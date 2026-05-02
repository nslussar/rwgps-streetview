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
  let apiKey = '';
  let enabled = true;
  let radius = DEFAULT_RADIUS;
  let bucketMeters = DEFAULT_BUCKET_METERS;
  let skipThresholdMeters = DEFAULT_SKIP_THRESHOLD_METERS;
  let dwellMs = DEFAULT_DWELL_MS;
  let dwellTimer = null;
  let pendingDwellArgs = null;
  let keyValid = null; // null = untested, true = valid, false = invalid
  let routeCoords = []; // array of arrays of {lat, lng}
  let flatCoords = [];  // flattened for nearest-point search
  let lastShownPoint = null;
  let overlayEl = null;
  let overlayImg = null;
  let noCoverageEl = null;
  let streetLabelEl = null;
  let headingLabelEl = null;
  let headingArrowEl = null;
  let loadingEl = null;
  let lastGeocodedPoint = null;
  let geocodeCounter = 0;
  let mapContainer = null;
  let bridgeReady = false;

  // Tracking mode state
  let trackingActive = false;
  let trackingTimeout = null;

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
    chrome.storage.sync.get(['apiKey', 'enabled', 'radius', 'bucketMeters', 'skipThresholdMeters', 'dwellMs'], function (result) {
      apiKey = result.apiKey || '';
      enabled = result.enabled !== false;
      radius = result.radius || DEFAULT_RADIUS;
      bucketMeters = numOr(result.bucketMeters, DEFAULT_BUCKET_METERS);
      skipThresholdMeters = numOr(result.skipThresholdMeters, DEFAULT_SKIP_THRESHOLD_METERS);
      dwellMs = numOr(result.dwellMs, DEFAULT_DWELL_MS);

      if (!apiKey) {
        console.log('[RWGPS Street View] No API key configured. Will initialize when key is set.');
        return;
      }

      if (!enabled) return;

      validateApiKey();
      injectBridge();
      createOverlay();
      listenForBridgeMessages();
      waitForMap();
    });

    chrome.storage.onChanged.addListener(function (changes) {
      if (changes.apiKey) {
        var hadKey = !!apiKey;
        apiKey = changes.apiKey.newValue || '';
        keyValid = null;
        if (apiKey) validateApiKey();
        // If this is the first time an API key is set, run full setup
        if (!hadKey && apiKey && enabled) {
          console.log('[RWGPS Street View] API key set, running late initialization');
          injectBridge();
          createOverlay();
          listenForBridgeMessages();
          waitForMap();
        }
      }
      if (changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        if (!enabled) hideOverlay();
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
    });
  }

  function numOr(v, fallback) {
    return (typeof v === 'number' && v >= 0) ? v : fallback;
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
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/page-bridge.js');
    document.documentElement.appendChild(script);
    script.onload = function () { script.remove(); };
  }

  function createOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'rwgps-sv-overlay';

    overlayImg = document.createElement('img');
    overlayImg.alt = 'Street View preview';

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

    overlayEl.appendChild(overlayImg);
    overlayEl.appendChild(loadingEl);
    overlayEl.appendChild(noCoverageEl);
    overlayEl.appendChild(streetLabelEl);
    overlayEl.appendChild(headingLabelEl);
    overlayEl.appendChild(headingArrowEl);
    document.body.appendChild(overlayEl);
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
    overlayEl.addEventListener('click', function () {
      if (!lastShownPoint) return;
      var url = 'https://www.google.com/maps/@'
        + lastShownPoint.lat.toFixed(6) + ',' + lastShownPoint.lng.toFixed(6)
        + ',3a,75y,0h,90t/data=!3m4!1e1!3m2!1s!2e0';
      window.open(url, '_blank');
    });

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
    if (!enabled || !apiKey) return;

    var prevX = cursorX;
    var prevY = cursorY;
    cursorX = event.clientX;
    cursorY = event.clientY;
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
    if (!enabled || !apiKey) return;

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
      loadingEl.style.display = 'none';
      noCoverageEl.style.display = 'none';
    };
    preload.onerror = function () {
      if (id !== preloadCounter) return; // stale
      clearTimeout(loadingSpinnerTimer);
      overlayImg.style.display = 'none';
      loadingEl.style.display = 'none';
      noCoverageEl.textContent = navigator.onLine
        ? 'No Street View coverage here'
        : 'Could not load — check your connection';
      noCoverageEl.style.display = 'flex';
    };
    preload.src = url;
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
    var ow = 404; // 400 + 2*2 border
    var oh = 254;
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

  function hideOverlay() {
    overlayEl.style.display = 'none';
    lastShownPoint = null;
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
