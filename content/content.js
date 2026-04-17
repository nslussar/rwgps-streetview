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
  let apiKey = '';
  let enabled = true;
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
  let useTrackingMode = false;
  let trackingActive = false;
  let trackingTimeout = null;

  // Manual mode state
  let pendingLatLng = null;
  let requestIdCounter = 0;
  let throttleTimer = null;

  // Cursor position (updated by mousemove, used by both modes)
  let cursorX = 0;
  let cursorY = 0;
  let trackingHideTimer = null;

  // --- Initialization ---

  function init() {
    chrome.storage.sync.get(['apiKey', 'enabled'], function (result) {
      apiKey = result.apiKey || '';
      enabled = result.enabled !== false;

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
    });
  }

  function validateApiKey() {
    if (!apiKey) return;
    // Test with a known-good Street View location (Times Square)
    var testUrl = 'https://maps.googleapis.com/maps/api/streetview'
      + '?size=100x100&location=40.758896,-73.985130'
      + '&radius=1000'
      + '&key=' + encodeURIComponent(apiKey)
      + '&return_error_code=true';
    console.log('[RWGPS Street View] Validating API key, test URL: ' + testUrl);
    var testImg = new Image();
    testImg.onload = function () {
      keyValid = true;
      console.log('[RWGPS Street View] API key is valid (test image loaded, size: ' + testImg.naturalWidth + 'x' + testImg.naturalHeight + ')');
    };
    testImg.onerror = function () {
      keyValid = false;
      console.log('[RWGPS Street View] API key validation failed (test image error). Try opening this URL in a browser tab to see the error: ' + testUrl);
    };
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
            if (!useTrackingMode) {
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
            handleTrackingPosition(msg.data);
            break;
          case 'TRACKING_LOST':
            // Don't hide immediately - RWGPS may briefly hide/show the marker.
            // Let the trackingHideTimer handle it if tracking doesn't resume.
            if (!trackingHideTimer) {
              trackingHideTimer = setTimeout(function () {
                hideOverlay();
                trackingActive = false;
              }, 500);
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
      if (!useTrackingMode) {
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

  function attachMouseListeners() {
    if (mapContainer) return; // already attached

    const gmStyle = document.querySelector('.gm-style');
    mapContainer = gmStyle ? gmStyle.parentElement || gmStyle : null;
    if (!mapContainer) {
      setTimeout(attachMouseListeners, 1000);
      return;
    }
    console.log('[RWGPS Street View] Attached to map container');

    mapContainer.addEventListener('mousemove', onMouseMove);
    mapContainer.addEventListener('mouseleave', function (event) {
      // Don't hide if cursor moved to the overlay
      if (overlayEl.contains(event.relatedTarget)) return;
      hideOverlay();
      pendingLatLng = null;
      clearTimeout(trackingHideTimer);
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

    // Forward mousemove from overlay to keep tracking alive
    overlayEl.addEventListener('mousemove', function (event) {
      onMouseMove(event);
    });

    // Hide when cursor leaves the overlay (unless going back to the map)
    overlayEl.addEventListener('mouseleave', function (event) {
      if (mapContainer.contains(event.relatedTarget)) return;
      hideOverlay();
      pendingLatLng = null;
      clearTimeout(trackingHideTimer);
      trackingActive = false;
    });
  }

  function onMouseMove(event) {
    if (!enabled || !apiKey) return;

    var prevX = cursorX;
    var prevY = cursorY;
    cursorX = event.clientX;
    cursorY = event.clientY;

    // In tracking mode, only start the hide timer if the cursor actually moved.
    // When stationary, RWGPS stops calling setPosition, but the overlay should stay.
    if (useTrackingMode) {
      var dx = cursorX - prevX;
      var dy = cursorY - prevY;
      if (dx * dx + dy * dy > 4) { // moved more than 2px
        clearTimeout(trackingHideTimer);
        trackingHideTimer = setTimeout(function () {
          hideOverlay();
          trackingActive = false;
        }, 500);
      }
    }

    // In manual mode, we need to convert pixel to latlng ourselves.
    if (!useTrackingMode && flatCoords.length >= 2) {
      if (throttleTimer) return;
      throttleTimer = setTimeout(function () { throttleTimer = null; }, 80);

      const rect = mapContainer.getBoundingClientRect();
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

  function handleTrackingPosition(latlng) {
    if (!enabled || !apiKey) return;

    if (!useTrackingMode) {
      useTrackingMode = true;
      console.log('[RWGPS Street View] Tracking mode activated');
    }

    // Ensure mouse listeners are attached (tracking can activate before MAP_READY)
    if (!mapContainer) {
      attachMouseListeners();
    }
    trackingActive = true;
    clearTimeout(trackingHideTimer);

    // Skip update if within 5m of last shown point
    if (lastShownPoint && RwgpsGeo.distanceMeters(lastShownPoint, latlng) < 5) {
      positionOverlay();
      showOverlay();
      return;
    }

    var heading = computeSegmentHeading(latlng);
    if (heading !== null) {
      updateHeading(heading);
    } else {
      showHeadingLoading();
    }

    lastShownPoint = { lat: latlng.lat, lng: latlng.lng };
    updateStreetViewImage(latlng.lat, latlng.lng, heading || 0);
    positionOverlay();
    showOverlay();
  }

  // --- Manual Mode (fallback) ---

  function handleManualLatLng(latlng, requestId, zoom) {
    if (requestId !== pendingLatLng) return;
    pendingLatLng = null;

    var nearest = RwgpsGeo.nearestPointOnPolyline(latlng, flatCoords);
    if (!nearest) {
      hideOverlay();
      return;
    }

    var z = zoom || 15;
    var metersPerPixel = 156543 * Math.cos(latlng.lat * Math.PI / 180) / Math.pow(2, z);
    var thresholdMeters = 25 * metersPerPixel;
    var distMeters = nearest.distanceDeg * 111000 * Math.cos(latlng.lat * Math.PI / 180);

    if (distMeters > thresholdMeters) {
      hideOverlay();
      return;
    }

    if (lastShownPoint && RwgpsGeo.distanceMeters(lastShownPoint, nearest) < 5) {
      positionOverlay();
      return;
    }

    var heading = RwgpsGeo.computeBearing(
      flatCoords[nearest.segmentIndex],
      flatCoords[nearest.segmentIndex + 1]
    );
    updateHeading(heading);

    lastShownPoint = { lat: nearest.lat, lng: nearest.lng };
    updateStreetViewImage(nearest.lat, nearest.lng, heading);
    positionOverlay();
    showOverlay();
  }

  // --- Geocoding ---

  function requestGeocode(lat, lng) {
    // Only geocode if we've moved >30m from last geocoded point
    if (lastGeocodedPoint && RwgpsGeo.distanceMeters(lastGeocodedPoint, { lat: lat, lng: lng }) < 30) {
      return;
    }
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

  function updateStreetViewImage(lat, lng, heading) {
    if (keyValid === false) {
      overlayImg.style.display = 'none';
      noCoverageEl.textContent = 'Invalid API key — check extension settings';
      noCoverageEl.style.display = 'flex';
      streetLabelEl.style.display = 'none';
      return;
    }

    requestGeocode(lat, lng);

    var url = 'https://maps.googleapis.com/maps/api/streetview'
      + '?size=400x250'
      + '&location=' + lat.toFixed(6) + ',' + lng.toFixed(6)
      + '&heading=' + Math.round(heading)
      + '&radius=100'
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

  function positionOverlay() {
    var ow = 404; // 400 + 2*2 border
    var oh = 254;
    var gap = 20;

    var left = cursorX + gap;
    var top = cursorY - oh - gap;

    if (left + ow > window.innerWidth) {
      left = cursorX - ow - gap;
    }
    if (top < 0) {
      top = cursorY + gap;
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
    streetLabelEl.style.display = 'none';
    hideHeading();
    loadingEl.style.display = 'none';
    clearTimeout(loadingSpinnerTimer);
  }

  // --- Start ---
  init();
})();
