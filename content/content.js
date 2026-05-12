/**
 * Content script - runs in ISOLATED world.
 * Manages the Street View overlay, mouse events, and bridge communication.
 *
 * Two modes:
 * 1. TRACKING mode (preferred): Piggybacks on RWGPS's own route-tracking marker.
 *    The bridge detects when RWGPS repositions its hover marker and sends us
 *    the exact route-snapped lat/lng. Perfect proximity matching.
 * 2. MANUAL mode (fallback): If tracking marker isn't detected within 10s,
 *    falls back to our own pixel-to-latlng + nearest-point calculation.
 */
(function () {
  'use strict';

  const PREFIX = 'RWGPS_SV_';
  const TRACKING_UPDATE_INTERVAL = 150; // keep in sync with page-bridge.js
  const LINGER_MS = 2000;
  const MANUAL_MODE_MIN_ZOOM = 13;
  const DEACTIVATE_DELAY_HIGH_ZOOM = 500; // quick handoff to manual mode
  const DEACTIVATE_DELAY_LOW_ZOOM = 2000; // safety net when marker is destroyed
  const TRACKING_LOST_DEBOUNCE = 200; // debounce rapid show/hide oscillation
  const DEFAULT_RADIUS = 10; // meters — Street View panorama search radius
  const DEFAULT_BUCKET_METERS = 10;
  const DEFAULT_SKIP_THRESHOLD_METERS = 10;
  const DEFAULT_DWELL_MS = 200;
  const HEADING_BUCKET_DEG = 15;
  const MANUAL_SNAP_MAX_PIXELS = 10;         // max cursor-to-polyline distance to snap in manual mode
  // The skip threshold composes with the user's meters setting: the effective
  // value is max(userMeters, PIXEL_FLOOR_SKIP * metersPerPixelAtZoom). At high
  // zoom the user value dominates; at low zoom the pixel floor takes over so
  // cursor sweeps don't hammer the API with sub-pixel updates. Bucketing is
  // intentionally not auto-scaled — large buckets at low zoom would snap
  // requests onto neighboring streets / off-coverage spots.
  const PIXEL_FLOOR_SKIP = 5;
  // streetviewpixels-pa tile endpoint (free, no API key). The endpoint exposes
  // tile-grid levels via the `zoom` param. At each level the panorama is split
  // into `worldSize / (512 * 2^(5-zoom))` tiles per axis: zoom=5 → worldSize/512
  // (full res, 32×16 standard), zoom=4 → /1024 (16×8), zoom=3 → /2048 (8×4).
  // Tile pixels are always 512×512, so lower zoom = wider angular coverage per
  // tile = lower per-pixel detail. Actual grid dims come from `tiles.worldSize`
  // in the getPanorama response; defaults below are the standard SV-car case.
  const TILE_BASE = 'https://streetviewpixels-pa.googleapis.com/v1/tile';
  const TILE_ZOOM = 4;
  function worldDivisorForZoom(z) { return 512 * Math.pow(2, 5 - z); } // px per tile in worldSize space
  function defaultXTilesForZoom(z) { return 32 / Math.pow(2, 5 - z); } // standard SV-car horizontal grid
  function defaultYTilesForZoom(z) { return 16 / Math.pow(2, 5 - z); } // standard SV-car vertical grid
  // Free-tile pipeline tunables exposed in the popup. Viewport size and
  // per-tile pixel size trade FOV against detail (smaller tiles = more
  // panorama visible per viewport pixel); horizon nudge layers a fixed
  // pixel offset on top of the auto seam-row centering.
  const DEFAULT_VIEWPORT_W = 400;
  const DEFAULT_VIEWPORT_H = 250;
  const DEFAULT_TILE_PX = 200;
  const DEFAULT_HORIZON_NUDGE_PX = 0;
  let apiKey = '';
  let enabled = true;
  // 'editor' for /routes/new and /routes/{id}/edit; otherwise 'viewer'. Used
  // to drive the preview-on-page-load default: editor starts OFF every load
  // (in-memory only, no storage), viewer remembers via previewEnabledViewer.
  const mode = (function () {
    var p = window.location.pathname;
    if (/^\/routes\/new\b/.test(p)) return 'editor';
    if (/^\/routes\/\d+\/edit\b/.test(p)) return 'editor';
    return 'viewer';
  })();
  let previewEnabled = false; // set in init() based on mode + storage
  let useFreeTilePipeline = true;
  let radius = DEFAULT_RADIUS;
  let bucketMeters = DEFAULT_BUCKET_METERS;
  let skipThresholdMeters = DEFAULT_SKIP_THRESHOLD_METERS;
  let dwellMs = DEFAULT_DWELL_MS;
  let viewportW = DEFAULT_VIEWPORT_W;
  let viewportH = DEFAULT_VIEWPORT_H;
  let tilePx = DEFAULT_TILE_PX;
  let horizonNudgePx = DEFAULT_HORIZON_NUDGE_PX;
  // Cached values from the most recent free-tile render so we can re-apply
  // the inner-div transform when only a tunable knob changes (no new pano).
  let lastFrac = null;
  let lastSeamWorldOffset = 0;
  let dwellTimer = null;
  let pendingDwellArgs = null;
  let keyValid = null; // null = untested, true = valid, false = invalid
  let routeCoords = []; // array of arrays of {lat, lng}
  let flatCoords = [];  // flattened for nearest-point search
  let lastShownPoint = null;
  let overlayEl = null;
  let overlayImg = null;
  let overlayTilesEl = null;
  let overlayTiles = []; // [tl, tr, bl, br] order matches grid layout
  let noCoverageEl = null;
  let streetLabelEl = null;
  let headingLabelEl = null;
  let headingArrowEl = null;
  let hintLabelEl = null;
  let copyrightEl = null;
  let loadingEl = null;
  let lastGeocodedPoint = null;
  let geocodeCounter = 0;
  let mapContainer = null;
  let bridgeReady = false;

  // Tracking mode state
  let trackingActive = false;
  let trackingTimeout = null;

  // Pano-lookup state for the free-tile pipeline. `pendingPanoHeading` is
  // safe as a single var because we only honor the response whose requestId
  // matches the latest counter — stale responses get dropped before the
  // heading is read.
  let panoLookupCounter = 0;
  let pendingPanoHeading = 0;

  // UGC photosphere state — single-slot, NOT a multi-pano cache. Overwritten
  // when the visible pano changes. Held so heading-update flows can rebuild
  // the URL without re-fetching panorama metadata.
  var lastUgcTokenBase = null;
  var lastUgcOriginHeading = null;
  var lastUgcOriginPitch = null;
  var lastUgcCopyright = null;

  // Manual mode state
  let pendingLatLng = null;
  let requestIdCounter = 0;
  let throttleTimer = null;
  let lastKnownZoom = null;

  // Cursor position (updated by mousemove, used by both modes)
  let cursorX = 0;
  let cursorY = 0;
  let trackingDeactivateTimer = null;
  let lastActiveMode = null; // 'tracking' or 'manual' — for logging transitions

  let cachedMapRect = null; // cached getBoundingClientRect for mapContainer
  let lingerTimer = null; // delays overlay hide so user can click it
  let positionScheduled = false;
  let positionRafId = null;

  // --- Initialization ---

  function init() {
    RwgpsApiBudget.init();
    chrome.storage.sync.get(['apiKey', 'enabled', 'useFreeTilePipeline', 'radius', 'bucketMeters', 'skipThresholdMeters', 'dwellMs', 'viewportW', 'viewportH', 'tilePx', 'horizonNudgePx', 'previewEnabledViewer'], function (result) {
      apiKey = result.apiKey || '';
      enabled = result.enabled !== false;
      previewEnabled = mode === 'viewer'
        ? result.previewEnabledViewer !== false  // viewer default: ON
        : false;                                 // editor: always OFF on load
      useFreeTilePipeline = result.useFreeTilePipeline !== false; // default true
      radius = result.radius || DEFAULT_RADIUS;
      bucketMeters = numOr(result.bucketMeters, DEFAULT_BUCKET_METERS);
      skipThresholdMeters = numOr(result.skipThresholdMeters, DEFAULT_SKIP_THRESHOLD_METERS);
      dwellMs = numOr(result.dwellMs, DEFAULT_DWELL_MS);
      viewportW = numOr(result.viewportW, DEFAULT_VIEWPORT_W);
      viewportH = numOr(result.viewportH, DEFAULT_VIEWPORT_H);
      tilePx = numOr(result.tilePx, DEFAULT_TILE_PX);
      horizonNudgePx = numOrSigned(result.horizonNudgePx, DEFAULT_HORIZON_NUDGE_PX);

      if (!apiKey && !useFreeTilePipeline) {
        console.log('[RWGPS Street View] No API key configured and free-tile pipeline disabled. Idle.');
        return;
      }

      if (!enabled) return;

      if (apiKey && !useFreeTilePipeline) validateApiKey();
      injectBridge();
      createOverlay();
      registerKeyboardShortcuts();
      listenForBridgeMessages();
      waitForMap();
    });

    chrome.storage.onChanged.addListener(function (changes) {
      if (changes.apiKey) {
        var hadKey = !!apiKey;
        apiKey = changes.apiKey.newValue || '';
        keyValid = null;
        if (apiKey && !useFreeTilePipeline) validateApiKey();
        // If this is the first time an API key is set and we weren't already
        // running (free-tile pipeline disabled), run full setup
        if (!hadKey && apiKey && enabled && !bridgeReady && !useFreeTilePipeline) {
          console.log('[RWGPS Street View] API key set, running late initialization');
          injectBridge();
          createOverlay();
          registerKeyboardShortcuts();
          listenForBridgeMessages();
          waitForMap();
        }
      }
      if (changes.useFreeTilePipeline) {
        var prev = useFreeTilePipeline;
        useFreeTilePipeline = changes.useFreeTilePipeline.newValue !== false;
        // Late init when enabling free pipeline without an API key set
        if (!prev && useFreeTilePipeline && enabled && !bridgeReady) {
          console.log('[RWGPS Street View] Free-tile pipeline enabled, running late initialization');
          injectBridge();
          createOverlay();
          registerKeyboardShortcuts();
          listenForBridgeMessages();
          waitForMap();
        }
      }
      if (changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        if (!enabled) hideOverlay();
      }
      // Editor mode ignores cross-tab sync (its default is always OFF on load
      // and any toggle is in-memory). Viewer mode mirrors storage.
      if (changes.previewEnabledViewer && mode === 'viewer') {
        previewEnabled = changes.previewEnabledViewer.newValue !== false;
        if (!previewEnabled) hideOverlay();
      }
      if (changes.radius) {
        radius = changes.radius.newValue || DEFAULT_RADIUS;
      }
      if (changes.bucketMeters) {
        bucketMeters = numOr(changes.bucketMeters.newValue, DEFAULT_BUCKET_METERS);
      }
      if (changes.skipThresholdMeters) {
        skipThresholdMeters = numOr(changes.skipThresholdMeters.newValue, DEFAULT_SKIP_THRESHOLD_METERS);
      }
      if (changes.dwellMs) {
        dwellMs = numOr(changes.dwellMs.newValue, DEFAULT_DWELL_MS);
      }
      if (changes.viewportW) {
        viewportW = numOr(changes.viewportW.newValue, DEFAULT_VIEWPORT_W);
        applyOverlayCssVars();
      }
      if (changes.viewportH) {
        viewportH = numOr(changes.viewportH.newValue, DEFAULT_VIEWPORT_H);
        applyOverlayCssVars();
      }
      if (changes.tilePx) {
        tilePx = numOr(changes.tilePx.newValue, DEFAULT_TILE_PX);
        applyOverlayCssVars();
        applyTilesTransform();
      }
      if (changes.horizonNudgePx) {
        horizonNudgePx = numOrSigned(changes.horizonNudgePx.newValue, DEFAULT_HORIZON_NUDGE_PX);
        applyTilesTransform();
      }
    });

    // Popup ↔ content-script bridge for the preview-toggle button. Editor-mode
    // state lives only here, so the popup must round-trip through us instead
    // of reading storage directly.
    chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
      if (!request || typeof request.type !== 'string') return;
      if (request.type === 'GET_PREVIEW_STATE') {
        sendResponse({ mode: mode, enabled: previewEnabled });
      } else if (request.type === 'SET_PREVIEW_STATE') {
        setPreviewEnabled(!!request.enabled);
        sendResponse({ ok: true, mode: mode, enabled: previewEnabled });
      }
    });
  }

  function isOperational() {
    return enabled && previewEnabled && (apiKey || useFreeTilePipeline);
  }

  function setPreviewEnabled(value) {
    var next = !!value;
    if (previewEnabled === next) return;
    previewEnabled = next;
    if (mode === 'viewer') {
      chrome.storage.sync.set({ previewEnabledViewer: previewEnabled });
    }
    if (!previewEnabled) {
      hideOverlay();
      // Reset tracking state so re-enabling treats the next signal as fresh.
      // Without clearing trackingActive the LATLNG-listener path drops manual
      // responses (`if (!trackingActive)` short-circuits them), and a stale
      // lastActiveMode='tracking' suppresses manual mode at low zoom.
      lastActiveMode = null;
      trackingActive = false;
      clearTimeout(trackingDeactivateTimer);
      trackingDeactivateTimer = null;
      pendingLatLng = null;
    } else {
      // If cursor is already over the route, kick a lookup so the preview
      // appears immediately — no mouse-wiggle needed.
      tryShowAtCursor();
    }
  }

  function tryShowAtCursor() {
    if (!isOperational() || !mapContainer || flatCoords.length < 2) return;
    var rect = getMapRect();
    if (cursorX < rect.left || cursorX > rect.right ||
        cursorY < rect.top || cursorY > rect.bottom) return;
    var id = ++requestIdCounter;
    pendingLatLng = id;
    window.postMessage({
      type: PREFIX + 'REQUEST',
      action: 'PIXEL_TO_LATLNG',
      data: { x: cursorX - rect.left, y: cursorY - rect.top },
      requestId: id
    }, '*');
  }

  function numOr(v, fallback) {
    return (typeof v === 'number' && v >= 0) ? v : fallback;
  }

  // Signed variant for tunables that accept negative values (e.g. horizon nudge).
  function numOrSigned(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  function applyOverlayCssVars() {
    if (!overlayEl) return;
    overlayEl.style.setProperty('--sv-vp-w', viewportW + 'px');
    overlayEl.style.setProperty('--sv-vp-h', viewportH + 'px');
    overlayEl.style.setProperty('--sv-tile-px', tilePx + 'px');
  }

  // Re-apply the inner-tile-div transform from the most recent free-tile
  // render. Used when a tunable knob changes (tilePx / horizonNudgePx) so
  // the heading and horizon stay centered without waiting for a new pano.
  function applyTilesTransform() {
    if (!overlayTilesEl || lastFrac == null) return;
    var horizonOffsetPx = lastSeamWorldOffset * tilePx;
    overlayTilesEl.style.transform =
      'translateX(' + (-tilePx * lastFrac) + 'px) ' +
      'translateY(' + (-(horizonOffsetPx + horizonNudgePx)) + 'px)';
  }

  // Skip-threshold floor lifted to whichever is bigger: the user-set value
  // or PIXEL_FLOOR_SKIP screen pixels at the current zoom. Falls back to
  // the user value when zoom is unknown (preserves historical high-zoom
  // behavior at startup before the bridge has reported zoom).
  function effectiveSkipMeters(userMeters, lat) {
    if (lastKnownZoom == null) return userMeters;
    var pixelMeters = PIXEL_FLOOR_SKIP * RwgpsGeo.metersPerPixelAtZoom(lat, lastKnownZoom);
    return userMeters > pixelMeters ? userMeters : pixelMeters;
  }

  function redactKey(url) {
    return url.replace(/([?&]key=)[^&]+/, '$1REDACTED');
  }

  function validateApiKey() {
    if (!apiKey) return;
    // Test with a known-good Street View location (Times Square)
    var testUrl = 'https://maps.googleapis.com/maps/api/streetview'
      + '?size=100x100&location=40.758896,-73.985130'
      + '&radius=1000'
      + '&key=' + encodeURIComponent(apiKey)
      + '&return_error_code=true';
    console.log('[RWGPS Street View] Validating API key, test URL: ' + redactKey(testUrl));
    var testImg = new Image();
    testImg.onload = function () {
      keyValid = true;
      chrome.storage.local.remove('apiKeyInvalid');
      console.log('[RWGPS Street View] API key is valid (test image loaded, size: ' + testImg.naturalWidth + 'x' + testImg.naturalHeight + ')');
    };
    testImg.onerror = function () {
      keyValid = false;
      chrome.storage.local.set({ apiKeyInvalid: true });
      console.log('[RWGPS Street View] API key validation failed (test image error). Try opening this URL in a browser tab to see the error: ' + redactKey(testUrl));
    };
    if (!RwgpsApiBudget.tryStreetView()) {
      console.log('[RWGPS Street View] API key validation skipped — monthly cap reached.');
      return;
    }
    testImg.src = testUrl;
  }

  function injectBridge() {
    // Inject the photospheres lib first so the bridge can call its helpers.
    // Both go into MAIN world (the bridge's execution context). Top-level
    // const declarations in the lib become available to the bridge via
    // shared global lexical scope; the lib also attaches to window for
    // belt-and-suspenders.
    const lib = document.createElement('script');
    lib.src = chrome.runtime.getURL('lib/photospheres.js');
    document.documentElement.appendChild(lib);
    lib.onload = function () {
      lib.remove();
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/page-bridge.js');
      document.documentElement.appendChild(script);
      script.onload = function () { script.remove(); };
    };
  }

  function createOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'rwgps-sv-overlay';

    overlayImg = document.createElement('img');
    overlayImg.alt = 'Street View preview';

    overlayTilesEl = document.createElement('div');
    overlayTilesEl.className = 'sv-tiles';
    var tileClasses = [
      'sv-tile sv-tile-tl', 'sv-tile sv-tile-tm', 'sv-tile sv-tile-tr',
      'sv-tile sv-tile-bl', 'sv-tile sv-tile-bm', 'sv-tile sv-tile-br'
    ];
    overlayTiles = tileClasses.map(function (cls) {
      var t = document.createElement('img');
      t.className = cls;
      t.alt = '';
      overlayTilesEl.appendChild(t);
      return t;
    });

    loadingEl = document.createElement('div');
    loadingEl.className = 'sv-loading';
    var spinner = document.createElement('div');
    spinner.className = 'sv-spinner';
    loadingEl.appendChild(spinner);
    loadingEl.style.display = 'none';

    noCoverageEl = document.createElement('div');
    noCoverageEl.className = 'sv-no-coverage';
    noCoverageEl.textContent = 'No Street View coverage here';
    noCoverageEl.style.display = 'none';

    streetLabelEl = document.createElement('div');
    streetLabelEl.className = 'sv-street-label';

    headingLabelEl = document.createElement('div');
    headingLabelEl.className = 'sv-heading-label';

    headingArrowEl = document.createElement('div');
    headingArrowEl.className = 'sv-heading-arrow';
    var arrowImg = document.createElement('img');
    arrowImg.src = chrome.runtime.getURL('icons/heading-arrow.svg');
    arrowImg.width = 18;
    arrowImg.height = 18;
    headingArrowEl.appendChild(arrowImg);

    hintLabelEl = document.createElement('div');
    hintLabelEl.className = 'sv-hint-label';
    var hintKbdV = document.createElement('kbd');
    hintKbdV.textContent = 'v';
    hintLabelEl.appendChild(hintKbdV);
    hintLabelEl.appendChild(document.createTextNode(' open tab  ·  '));
    var hintKbdS = document.createElement('kbd');
    hintKbdS.textContent = 's';
    hintLabelEl.appendChild(hintKbdS);
    hintLabelEl.appendChild(document.createTextNode(' to disable'));

    copyrightEl = document.createElement('div');
    copyrightEl.className = 'sv-copyright';
    copyrightEl.style.display = 'none';

    overlayEl.appendChild(overlayImg);
    overlayEl.appendChild(overlayTilesEl);
    overlayEl.appendChild(loadingEl);
    overlayEl.appendChild(noCoverageEl);
    overlayEl.appendChild(streetLabelEl);
    overlayEl.appendChild(headingLabelEl);
    overlayEl.appendChild(hintLabelEl);
    overlayEl.appendChild(headingArrowEl);
    overlayEl.appendChild(copyrightEl);
    document.body.appendChild(overlayEl);
    applyOverlayCssVars();
  }

  // --- Bridge Communication ---

  function listenForBridgeMessages() {
    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === PREFIX + 'RESPONSE') {
        switch (msg.action) {
          case 'ROUTE_COORDS':
            setRouteCoords(msg.data);
            break;
          case 'LATLNG':
            if (msg.zoom) lastKnownZoom = msg.zoom;
            if (!trackingActive) {
              handleManualLatLng(msg.data, msg.requestId, msg.zoom);
            }
            break;
          case 'GEOCODE_RESULT':
            handleGeocodeResult(msg.data, msg.requestId);
            break;
          case 'PANO_INFO':
            handlePanoInfo(msg.data, msg.requestId);
            break;
          case 'PONG':
            if (msg.data.mapFound) onBridgeReady();
            break;
        }
      } else if (msg.type === PREFIX + 'EVENT') {
        switch (msg.action) {
          case 'MAP_READY':
            setRouteCoords(msg.data);
            onBridgeReady();
            break;
          case 'ROUTE_CHANGED':
            setRouteCoords(msg.data);
            break;
          case 'TRACKING_POSITION':
            if (msg.zoom != null) lastKnownZoom = msg.zoom;
            handleTrackingPosition(msg.data);
            break;
          case 'TRACKING_LOST':
            // At high zoom, RWGPS hides the marker between sparse waypoints.
            // Debounce to avoid rapid tracking→manual oscillation.
            if (!trackingDeactivateTimer) {
              startLingerTimer();
              trackingDeactivateTimer = setTimeout(function () {
                trackingDeactivateTimer = null;
                trackingActive = false;
              }, TRACKING_LOST_DEBOUNCE);
            }
            break;
        }
      }
    });
  }

  function setRouteCoords(coords) {
    routeCoords = coords || [];
    flatCoords = routeCoords.flat();
  }

  function onBridgeReady() {
    if (bridgeReady) return;
    bridgeReady = true;
    requestRouteCoords();
    attachMouseListeners();

    // Wait 10s for tracking mode to activate; if not, fall back to manual
    trackingTimeout = setTimeout(function () {
      if (lastActiveMode !== 'tracking') {
        console.log('[RWGPS Street View] Tracking marker not detected, using manual mode');
      }
    }, 10000);
  }

  function requestRouteCoords() {
    window.postMessage({ type: PREFIX + 'REQUEST', action: 'GET_ROUTE_COORDS' }, '*');
  }

  function waitForMap() {
    let attempts = 0;
    const pingInterval = setInterval(function () {
      window.postMessage({ type: PREFIX + 'REQUEST', action: 'PING' }, '*');
      attempts++;
      if (bridgeReady || attempts > 60) clearInterval(pingInterval);
    }, 500);
  }

  // --- Mouse Handling (shared) ---

  function getMapRect() {
    if (!cachedMapRect) cachedMapRect = mapContainer.getBoundingClientRect();
    return cachedMapRect;
  }

  function startLingerTimer() {
    cancelLingerTimer();
    lingerTimer = setTimeout(function () {
      lingerTimer = null;
      hideOverlay();
    }, LINGER_MS);
  }

  function cancelLingerTimer() {
    if (lingerTimer) {
      clearTimeout(lingerTimer);
      lingerTimer = null;
    }
  }

  // Keyboard shortcuts register at init (before the bridge is ready) so
  // toggling preview / opening Street View works on a fresh editor-mode load
  // even if the user never moves the mouse first. Idempotent — late-init
  // paths in init() also call this, so guard against double-registration.
  var keyboardShortcutsRegistered = false;
  function registerKeyboardShortcuts() {
    if (keyboardShortcutsRegistered) return;
    keyboardShortcutsRegistered = true;

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'v' && event.key !== 'V') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!overlayEl || overlayEl.style.display === 'none') return;
      if (!lastShownPoint) return;
      var t = event.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      event.preventDefault();
      openStreetViewTab();
    });

    // `s` toggles preview on/off. Works whether or not the overlay is
    // visible (so the user can re-enable from a cold editor-mode page).
    document.addEventListener('keydown', function (event) {
      if (event.key !== 's' && event.key !== 'S') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      var t = event.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      event.preventDefault();
      setPreviewEnabled(!previewEnabled);
    });
  }

  function attachMouseListeners() {
    if (mapContainer) return; // already attached

    const gmStyle = document.querySelector('.gm-style');
    mapContainer = gmStyle ? gmStyle.parentElement || gmStyle : null;
    if (!mapContainer) {
      setTimeout(attachMouseListeners, 1000);
      return;
    }
    console.log('[RWGPS Street View] Attached to map container');

    function invalidateMapRect() { cachedMapRect = null; }
    window.addEventListener('resize', invalidateMapRect);
    window.addEventListener('scroll', invalidateMapRect, true);

    // Bind mousemove to `document` so cursor tracking survives RWGPS rebuilding
    // the map container on map-type switches (Google → other → Google).
    document.addEventListener('mousemove', onMouseMove);
    mapContainer.addEventListener('mouseleave', function (event) {
      // Don't hide if cursor moved to the overlay
      if (overlayEl.contains(event.relatedTarget)) return;
      // If tracking is active (e.g. elevation chart hover driving the marker),
      // keep the overlay visible — it will hide when tracking stops.
      if (trackingActive) return;
      hideOverlay();
      pendingLatLng = null;
      clearTimeout(trackingDeactivateTimer);
      trackingDeactivateTimer = null;
      trackingActive = false;
    });

    // Click on overlay opens Google Maps Street View in a new tab
    // (also bound to the `v` key in registerKeyboardShortcuts — because the
    // overlay tracks the cursor, making it nearly impossible to actually
    // mouse over and click).
    overlayEl.addEventListener('click', openStreetViewTab);

    overlayEl.addEventListener('mouseenter', cancelLingerTimer);

    // Hide when cursor leaves the overlay (unless going back to the map)
    overlayEl.addEventListener('mouseleave', function (event) {
      if (mapContainer.contains(event.relatedTarget)) return;
      hideOverlay();
      pendingLatLng = null;
      clearTimeout(trackingDeactivateTimer);
      trackingDeactivateTimer = null;
      trackingActive = false;
    });
  }

  function onMouseMove(event) {
    // Track cursor even when preview is disabled — so when the user toggles
    // back on, tryShowAtCursor() has a real position to work from.
    var prevX = cursorX;
    var prevY = cursorY;
    cursorX = event.clientX;
    cursorY = event.clientY;
    if (!isOperational()) return;
    schedulePositionOverlay();

    // Deactivate tracking when RWGPS stops sending position updates.
    // At high zoom (500ms): quick handoff to manual mode for gap filling.
    // At low zoom (2s): safety net in case RWGPS destroys the marker
    // without calling setVisible(false).
    if (trackingActive && !trackingDeactivateTimer) {
      var dx = cursorX - prevX;
      var dy = cursorY - prevY;
      if (dx * dx + dy * dy > 4) { // moved more than 2px
        var z = lastKnownZoom || 15;
        var deactivateDelay = z >= MANUAL_MODE_MIN_ZOOM ? DEACTIVATE_DELAY_HIGH_ZOOM : DEACTIVATE_DELAY_LOW_ZOOM;
        startLingerTimer();
        trackingDeactivateTimer = setTimeout(function () {
          trackingDeactivateTimer = null;
          trackingActive = false;
        }, deactivateDelay);
      }
    }

    // Manual mode: convert pixel to latlng when tracking isn't active.
    // This serves as both primary mode (no tracking marker) and fallback
    // (tracking marker hidden between sparse waypoints at high zoom).
    if (!trackingActive && flatCoords.length >= 2) {
      if (throttleTimer) return;
      throttleTimer = setTimeout(function () { throttleTimer = null; }, TRACKING_UPDATE_INTERVAL);

      const rect = getMapRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const id = ++requestIdCounter;
      pendingLatLng = id;
      window.postMessage({
        type: PREFIX + 'REQUEST',
        action: 'PIXEL_TO_LATLNG',
        data: { x: x, y: y },
        requestId: id
      }, '*');
    }
  }

  // --- Tracking Mode (piggyback on RWGPS hover marker) ---

  function handleTrackingPosition(data) {
    if (!isOperational()) return;

    // Ensure mouse listeners are attached (tracking can activate before MAP_READY)
    if (!mapContainer) {
      attachMouseListeners();
    }
    trackingActive = true;
    clearTimeout(trackingDeactivateTimer);
    trackingDeactivateTimer = null;
    cancelLingerTimer();
    if (lastActiveMode !== 'tracking') {
      console.log('[RWGPS Street View] Switched to RWGPS tracking mode');
      lastActiveMode = 'tracking';
    }

    if (lastShownPoint && RwgpsGeo.distanceMeters(lastShownPoint, data) < effectiveSkipMeters(skipThresholdMeters, data.lat)) {
      positionOverlay();
      showOverlay();
      return;
    }

    var heading = computeSegmentHeading(data);
    if (heading !== null) {
      updateHeading(heading);
    } else {
      showHeadingLoading();
    }

    lastShownPoint = { lat: data.lat, lng: data.lng };
    scheduleStreetViewUpdate(data.lat, data.lng, heading || 0);
    positionOverlay();
    showOverlay();
  }

  // --- Manual Mode (fallback) ---

  function handleManualLatLng(latlng, requestId, zoom) {
    if (!isOperational()) return;
    if (requestId !== pendingLatLng) return;
    pendingLatLng = null;

    // At low zoom RWGPS tracking is reliable — only use manual mode
    // at high zoom where tracking is sparse between waypoints.
    var z = zoom || 15;
    if (z < MANUAL_MODE_MIN_ZOOM && lastActiveMode === 'tracking') return;

    var nearest = RwgpsGeo.nearestPointOnPolyline(latlng, flatCoords);
    if (!nearest) {
      startLingerTimer();
      return;
    }

    var snapMaxMeters = MANUAL_SNAP_MAX_PIXELS * RwgpsGeo.metersPerPixelAtZoom(latlng.lat, z);
    if (RwgpsGeo.distanceMeters(latlng, nearest) > snapMaxMeters) {
      startLingerTimer();
      return;
    }

    cancelLingerTimer();
    if (lastActiveMode !== 'manual') {
      console.log('[RWGPS Street View] Switched to manual mode');
      lastActiveMode = 'manual';
    }

    if (lastShownPoint && RwgpsGeo.distanceMeters(lastShownPoint, nearest) < effectiveSkipMeters(skipThresholdMeters, nearest.lat)) {
      positionOverlay();
      return;
    }

    var heading = RwgpsGeo.computeBearing(
      flatCoords[nearest.segmentIndex],
      flatCoords[nearest.segmentIndex + 1]
    );
    updateHeading(heading);

    lastShownPoint = { lat: nearest.lat, lng: nearest.lng };
    scheduleStreetViewUpdate(nearest.lat, nearest.lng, heading);
    positionOverlay();
    showOverlay();
  }

  // --- Geocoding ---

  function requestGeocode(lat, lng) {
    // Only geocode if we've moved >30m from last geocoded point
    if (lastGeocodedPoint && RwgpsGeo.distanceMeters(lastGeocodedPoint, { lat: lat, lng: lng }) < 30) {
      return;
    }
    RwgpsApiBudget.countGeocode();
    lastGeocodedPoint = { lat: lat, lng: lng };
    var id = ++geocodeCounter;
    window.postMessage({
      type: PREFIX + 'REQUEST',
      action: 'REVERSE_GEOCODE',
      data: { lat: lat, lng: lng },
      requestId: id
    }, '*');
  }

  function handleGeocodeResult(data, requestId) {
    if (requestId !== geocodeCounter) return; // stale
    if (data.label) {
      streetLabelEl.textContent = data.label;
      streetLabelEl.style.display = 'block';
    } else {
      streetLabelEl.style.display = 'none';
    }
  }

  // --- Heading Display ---

  var lastDisplayedHeading = null;

  function computeSegmentHeading(latlng) {
    if (flatCoords.length < 2) return null;
    var nearest = RwgpsGeo.nearestPointOnPolyline(latlng, flatCoords);
    if (!nearest) return null;
    return RwgpsGeo.computeBearing(
      flatCoords[nearest.segmentIndex],
      flatCoords[nearest.segmentIndex + 1]
    );
  }

  function updateHeading(heading) {
    var rounded = Math.round(heading);
    if (rounded === lastDisplayedHeading) return;
    lastDisplayedHeading = rounded;
    headingLabelEl.textContent = 'Heading ' + RwgpsGeo.bearingToCompass(heading);
    headingLabelEl.style.display = 'block';
    headingArrowEl.style.display = 'flex';
    headingArrowEl.style.transform = 'rotate(' + rounded + 'deg)';
  }

  function showHeadingLoading() {
    lastDisplayedHeading = null;
    headingLabelEl.textContent = 'Loading route\u2026';
    headingLabelEl.style.display = 'block';
    headingArrowEl.style.display = 'none';
  }

  function hideHeading() {
    lastDisplayedHeading = null;
    headingLabelEl.style.display = 'none';
    headingArrowEl.style.display = 'none';
  }

  // --- Overlay Management ---

  var preloadCounter = 0;
  var loadingSpinnerTimer = null;
  var hasLoadedImage = false;

  function showCapBlockedUI() {
    overlayImg.style.display = 'none';
    loadingEl.style.display = 'none';
    clearTimeout(loadingSpinnerTimer);
    noCoverageEl.textContent = 'Monthly API request limit reached';
    noCoverageEl.style.display = 'flex';
    streetLabelEl.style.display = 'none';
    positionOverlay();
    showOverlay();
  }

  function scheduleStreetViewUpdate(lat, lng, heading) {
    if (dwellMs <= 0) {
      updateStreetViewImage(lat, lng, heading);
      return;
    }
    pendingDwellArgs = [lat, lng, heading];
    clearTimeout(dwellTimer);
    dwellTimer = setTimeout(function () {
      var a = pendingDwellArgs;
      pendingDwellArgs = null;
      dwellTimer = null;
      if (a) updateStreetViewImage(a[0], a[1], a[2]);
    }, dwellMs);
  }

  function updateStreetViewImage(lat, lng, heading) {
    if (useFreeTilePipeline) {
      updateStreetViewImageViaFreeTile(lat, lng, heading);
      return;
    }
    if (keyValid === false) {
      overlayImg.style.display = 'none';
      noCoverageEl.textContent = 'Invalid API key — check extension settings';
      noCoverageEl.style.display = 'flex';
      streetLabelEl.style.display = 'none';
      return;
    }

    if (!RwgpsApiBudget.tryStreetView()) {
      showCapBlockedUI();
      return;
    }

    var b = RwgpsGeo.bucketLatLng(lat, lng, bucketMeters);
    var h = RwgpsGeo.bucketHeading(heading, HEADING_BUCKET_DEG);

    requestGeocode(b.lat, b.lng);

    var url = 'https://maps.googleapis.com/maps/api/streetview'
      + '?size=400x250'
      + '&location=' + b.lat.toFixed(6) + ',' + b.lng.toFixed(6)
      + '&heading=' + Math.round(h)
      + '&radius=' + radius
      + '&pitch=-5'
      + '&fov=90'
      + '&key=' + encodeURIComponent(apiKey)
      + '&return_error_code=true';

    // Preload offscreen so we don't cancel in-flight loads on the visible img.
    // Only swap the visible src once the preload completes.
    var id = ++preloadCounter;

    // Delay spinner when a previous image is already visible
    clearTimeout(loadingSpinnerTimer);
    if (!hasLoadedImage) {
      loadingEl.style.display = 'flex';
      noCoverageEl.style.display = 'none';
    } else {
      loadingSpinnerTimer = setTimeout(function () {
        if (id === preloadCounter) {
          loadingEl.style.display = 'flex';
        }
      }, 500);
    }
    var preload = new Image();
    preload.onload = function () {
      if (id !== preloadCounter) return; // stale
      clearTimeout(loadingSpinnerTimer);
      hasLoadedImage = true;
      overlayImg.src = url;
      overlayImg.style.display = 'block';
      overlayTilesEl.style.display = 'none';
      loadingEl.style.display = 'none';
      noCoverageEl.style.display = 'none';
    };
    preload.onerror = function () {
      if (id !== preloadCounter) return; // stale
      clearTimeout(loadingSpinnerTimer);
      overlayImg.style.display = 'none';
      overlayTilesEl.style.display = 'none';
      loadingEl.style.display = 'none';
      noCoverageEl.textContent = navigator.onLine
        ? 'No Street View coverage here'
        : 'Could not load — check your connection';
      noCoverageEl.style.display = 'flex';
    };
    preload.src = url;
  }

  // --- Free-tile pipeline (no API key, uses streetviewpixels-pa tile endpoint) ---

  function updateStreetViewImageViaFreeTile(lat, lng, heading) {
    var b = RwgpsGeo.bucketLatLng(lat, lng, bucketMeters);
    var h = RwgpsGeo.bucketHeading(heading, HEADING_BUCKET_DEG);

    requestGeocode(b.lat, b.lng);

    var id = ++panoLookupCounter;
    pendingPanoHeading = h;

    // Delay spinner when a previous image is already visible (mirrors Static API path)
    clearTimeout(loadingSpinnerTimer);
    if (!hasLoadedImage) {
      loadingEl.style.display = 'flex';
      noCoverageEl.style.display = 'none';
    } else {
      loadingSpinnerTimer = setTimeout(function () {
        if (id === panoLookupCounter) loadingEl.style.display = 'flex';
      }, 500);
    }

    console.log('[RWGPS Street View] lookup-pano req=' + id,
      'bucketed=(' + b.lat.toFixed(6) + ',' + b.lng.toFixed(6) + ')',
      'raw=(' + lat.toFixed(6) + ',' + lng.toFixed(6) + ')',
      'r=' + radius + 'm');

    window.postMessage({
      type: PREFIX + 'REQUEST',
      action: 'LOOKUP_PANO',
      data: { lat: b.lat, lng: b.lng, radius: radius },
      requestId: id
    }, '*');
  }

  function buildTileUrl(panoid, x, y) {
    return TILE_BASE
      + '?cb_client=maps_sv.tactile'
      + '&panoid=' + encodeURIComponent(panoid)
      + '&x=' + x + '&y=' + y
      + '&zoom=' + TILE_ZOOM + '&nbt=1&fover=2';
  }

  function renderUgcPanorama(data, requestId) {
    lastUgcTokenBase = data.tokenBase;
    lastUgcOriginHeading = data.originHeading || 0;
    lastUgcOriginPitch = data.originPitch || 0;
    lastUgcCopyright = data.copyright || '';

    var url = RwgpsPhotospheres.buildUgcRenderUrl(
      data.tokenBase,
      pendingPanoHeading,
      lastUgcOriginHeading,
      lastUgcOriginPitch,
      viewportW,
      viewportH);

    var qDist = (data.queryLat != null && data.snappedLat != null)
      ? RwgpsGeo.distanceMeters(
          { lat: data.queryLat, lng: data.queryLng },
          { lat: data.snappedLat, lng: data.snappedLng }).toFixed(1)
      : '?';
    console.log('[RWGPS Street View] ugc pano',
      data.panoid,
      'originHeading=' + lastUgcOriginHeading.toFixed(1),
      'originPitch=' + lastUgcOriginPitch.toFixed(2),
      'yaw=' + (((pendingPanoHeading - lastUgcOriginHeading) % 360 + 360) % 360).toFixed(1),
      'q=(' + (data.queryLat != null ? data.queryLat.toFixed(6) : '?')
        + ',' + (data.queryLng != null ? data.queryLng.toFixed(6) : '?') + ')',
      'qDist=' + qDist + 'm',
      'r=' + (data.queryRadius != null ? data.queryRadius : '?') + 'm',
      'url=' + url);

    var pid = ++preloadCounter;
    var pre = new Image();
    pre.onload = function () {
      if (pid !== preloadCounter) return;     // stale (newer pano arrived)
      clearTimeout(loadingSpinnerTimer);
      hasLoadedImage = true;
      overlayImg.src = url;
      overlayImg.style.display = 'block';
      overlayTilesEl.style.display = 'none';
      loadingEl.style.display = 'none';
      noCoverageEl.style.display = 'none';
      if (lastUgcCopyright) {
        copyrightEl.textContent = lastUgcCopyright;
        copyrightEl.style.display = 'block';
      } else {
        copyrightEl.style.display = 'none';
      }
    };
    pre.onerror = function () {
      if (pid !== preloadCounter) return;
      showPanoError({
        error: 'gpms-cs-s image load failed',
        errorClass: 'UGC_IMAGE_LOAD_FAIL',
        noCoverage: false
      });
    };
    pre.src = url;
  }

  function showPanoError(data) {
    clearTimeout(loadingSpinnerTimer);
    overlayImg.style.display = 'none';
    overlayTilesEl.style.display = 'none';
    copyrightEl.style.display = 'none';     // ensure attribution clears across renders
    loadingEl.style.display = 'none';
    if (data.errorClass) {
      console.log('[RWGPS Street View] error',
        data.errorClass + ':', data.error || '(no detail)');
    }
    noCoverageEl.textContent = panoErrorMessage(data);
    noCoverageEl.style.display = 'flex';
  }

  // The G1/G2/G3 suffixes give a user something specific to type into a bug
  // report without leaking implementation details into the UI. See spec
  // section 4.3.
  function panoErrorMessage(data) {
    if (data.noCoverage) return 'No Street View coverage here';
    if (!navigator.onLine) return 'Could not load — check your connection';
    switch (data.errorClass) {
      case 'UGC_RPC_HTTP_ERROR':  return 'Street View lookup failed (G1)';
      case 'UGC_RPC_PARSE_FAIL':  return 'Street View lookup failed (G2)';
      case 'UGC_URL_NOT_FOUND':   return 'Street View lookup failed (G3)';
      case 'UGC_IMAGE_LOAD_FAIL': return 'Could not load image';
      default:                    return 'Street View lookup failed';
    }
  }

  function handlePanoInfo(data, requestId) {
    if (requestId !== panoLookupCounter) return; // stale

    if (data.error) {
      return showPanoError(data);
    }

    if (data.kind === 'ugc') {
      return renderUgcPanorama(data, requestId);
    }
    // Defaults to tile path (also handles legacy responses without `kind`).
    return renderTilePanorama(data, requestId);
  }

  function renderTilePanorama(data, requestId) {
    // Tile-grid dimensions vary per panorama. Standard Google SV-car captures
    // are 16×8 at zoom=4; trekker / photo-path captures are non-standard
    // (e.g. 13×7) and will INVALID_ARGUMENT for x or y outside their range.
    // worldSize is reported at full resolution (zoom=5); divide by the per-zoom
    // pixel-per-tile factor to get this zoom level's grid. Floor (not round)
    // x — non-standard panoramas can have a half-padded trailing tile that
    // wraps into tile 0 and produces visible duplication.
    var divisor = worldDivisorForZoom(TILE_ZOOM);
    var xTiles = defaultXTilesForZoom(TILE_ZOOM);
    var yTiles = defaultYTilesForZoom(TILE_ZOOM);
    var xTilesContinuous = xTiles; // fractional grid count; used for angular math
    if (data.worldSize && data.worldSize.width && data.worldSize.height) {
      xTilesContinuous = data.worldSize.width / divisor;
      xTiles = Math.max(1, Math.floor(xTilesContinuous));
      yTiles = Math.max(2, Math.round(data.worldSize.height / divisor));
    }
    // Each tile-index advances the camera by `divisor` worldsize px around the
    // panorama, regardless of how many indices we render. Use the continuous
    // grid count so the heading→tile math stays angularly correct even when
    // the floored xTiles dropped a partial tile.
    var degPerXTile = 360 / xTilesContinuous;
    // Choose y rows flanking the horizon. The horizon is approximately at the
    // panorama's vertical center (worldSize.height/2). Pick the tile-row pair
    // whose seam is closest to that center, then translateY-shift the inner
    // div to put horizon at the viewport vertical center.
    //
    // Why round-to-nearest-seam (not floor(yTiles/2)): non-standard panoramas
    // (e.g. trekker 13312×6656) have non-integer rows-per-half-panorama. At
    // zoom=4 a 6656-tall pano gives yTiles=7 → floor(7/2)-1=2 puts the seam
    // 50px above the true center; round-to-nearest picks seamRow=3 with a
    // translateY of +50px to compensate, landing horizon at viewport center.
    var horizonWorldY = (data.worldSize && data.worldSize.height) ? data.worldSize.height / 2 : (yTiles * divisor / 2);
    var seamRow = Math.round(horizonWorldY / divisor);
    seamRow = Math.max(1, Math.min(yTiles - 1, seamRow));
    var yTop = seamRow - 1;
    var yBot = seamRow;
    // Inner-div pixels horizon sits below the seam (negative = above seam).
    // Each tile renders at tilePx; spans `divisor` worldsize px. Cache the
    // worldsize-fraction offset so applyTilesTransform() can recompute the
    // pixel shift if tilePx or horizonNudgePx change after this render.
    var seamWorldOffset = (horizonWorldY - seamRow * divisor) / divisor;
    var horizonOffsetPx = seamWorldOffset * tilePx;
    console.log('[RWGPS Street View] pano',
      data.panoid,
      'worldSize=' + (data.worldSize ? data.worldSize.width + 'x' + data.worldSize.height : 'null'),
      'tiles=' + xTiles + 'x' + yTiles,
      'seamRow=' + seamRow,
      'yShift=' + horizonOffsetPx.toFixed(1) + 'px');

    // 3-wide tile selection. The middle tile (T) contains the route heading.
    // We render T-1 and T+1 alongside it so we have horizontal pan room to
    // sub-tile-shift the inner div, putting the heading exactly at the
    // viewport's horizontal center regardless of where it falls within tile T.
    // The +180° offset accounts for the tile-x convention being opposite
    // of the world heading: x=0 looks "backward" from originHeading.
    var rel = (((pendingPanoHeading - data.originHeading + 180) % 360) + 360) % 360;
    var floorIdx = Math.floor(rel / degPerXTile);
    var T = ((floorIdx % xTiles) + xTiles) % xTiles;
    var leftX  = ((T - 1) % xTiles + xTiles) % xTiles;
    var midX   = T;
    var rightX = (T + 1) % xTiles;
    var frac = (rel / degPerXTile) - floorIdx; // [0, 1)

    // 6 tiles in (tl, tm, tr, bl, bm, br) order — must match overlayTiles array.
    var urls = [
      buildTileUrl(data.panoid, leftX,  yTop),
      buildTileUrl(data.panoid, midX,   yTop),
      buildTileUrl(data.panoid, rightX, yTop),
      buildTileUrl(data.panoid, leftX,  yBot),
      buildTileUrl(data.panoid, midX,   yBot),
      buildTileUrl(data.panoid, rightX, yBot)
    ];

    var pid = ++preloadCounter;
    var loaded = 0;
    var done = false;
    urls.forEach(function (url, i) {
      var pre = new Image();
      pre.onload = function () {
        if (pid !== preloadCounter || done) return;
        loaded++;
        if (loaded === 6) {
          done = true;
          clearTimeout(loadingSpinnerTimer);
          hasLoadedImage = true;
          // Sub-tile horizontal shift so the heading lands at viewport center,
          // plus vertical shift so horizon lands at viewport center (compensates
          // for non-integer yTiles where the chosen seam isn't exactly at horizon).
          // Cache for re-application when tunable knobs change.
          lastFrac = frac;
          lastSeamWorldOffset = seamWorldOffset;
          applyTilesTransform();
          for (var j = 0; j < 6; j++) overlayTiles[j].src = urls[j];
          overlayImg.style.display = 'none';
          overlayTilesEl.style.display = 'block';
          loadingEl.style.display = 'none';
          noCoverageEl.style.display = 'none';
        }
      };
      pre.onerror = function () {
        if (pid !== preloadCounter || done) return;
        done = true;
        clearTimeout(loadingSpinnerTimer);
        overlayImg.style.display = 'none';
        overlayTilesEl.style.display = 'none';
        loadingEl.style.display = 'none';
        noCoverageEl.textContent = navigator.onLine
          ? 'Tile load failed'
          : 'Could not load — check your connection';
        noCoverageEl.style.display = 'flex';
      };
      pre.src = url;
    });
  }

  // Coalesce mousemove-driven repositions to one paint per frame.
  // The data path (image, heading, geocode) stays on its 150ms throttle;
  // only the overlay window position runs at native frame rate.
  function schedulePositionOverlay() {
    if (positionScheduled) return;
    if (!overlayEl || overlayEl.style.display === 'none') return;
    positionScheduled = true;
    positionRafId = requestAnimationFrame(function () {
      positionScheduled = false;
      positionRafId = null;
      positionOverlay();
    });
  }

  function positionOverlay() {
    var ow = viewportW + 4; // viewport + 2*2 border
    var oh = viewportH + 4;
    var gap = 20;

    var vw = window.innerWidth;

    var anchorX = cursorX;
    var anchorY = cursorY;

    var left = anchorX + gap;
    var top = anchorY - oh - gap;

    if (left + ow > vw) {
      left = anchorX - ow - gap;
    }
    if (top < 0) {
      top = anchorY + gap;
    }

    overlayEl.style.left = left + 'px';
    overlayEl.style.top = top + 'px';
  }

  function showOverlay() {
    overlayEl.style.display = 'block';
  }

  function openStreetViewTab() {
    if (!lastShownPoint) return;
    var h = lastDisplayedHeading != null ? ((lastDisplayedHeading % 360) + 360) % 360 : 0;
    var url = 'https://www.google.com/maps/@'
      + lastShownPoint.lat.toFixed(6) + ',' + lastShownPoint.lng.toFixed(6)
      + ',3a,75y,' + h + 'h,90t/data=!3m4!1e1!3m2!1s!2e0';
    window.open(url, '_blank');
  }

  function hideOverlay() {
    overlayEl.style.display = 'none';
    lastShownPoint = null;
    lastUgcTokenBase = null;
    lastUgcOriginHeading = null;
    lastUgcOriginPitch = null;
    lastUgcCopyright = null;
    if (copyrightEl) copyrightEl.style.display = 'none';
    lastGeocodedPoint = null;
    cancelLingerTimer();
    if (positionRafId !== null) {
      cancelAnimationFrame(positionRafId);
      positionRafId = null;
      positionScheduled = false;
    }
    clearTimeout(dwellTimer);
    dwellTimer = null;
    pendingDwellArgs = null;
    streetLabelEl.style.display = 'none';
    hideHeading();
    loadingEl.style.display = 'none';
    clearTimeout(loadingSpinnerTimer);
  }

  // --- Start ---
  init();
})();
