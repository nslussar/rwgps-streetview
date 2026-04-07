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
  let routeCoords = []; // array of arrays of {lat, lng}
  let flatCoords = [];  // flattened for nearest-point search
  let lastShownPoint = null;
  let overlayEl = null;
  let overlayImg = null;
  let noCoverageEl = null;
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
        console.log('[RWGPS Street View] No API key configured. Click the extension icon to set one.');
        return;
      }

      if (!enabled) return;

      injectBridge();
      createOverlay();
      listenForBridgeMessages();
      waitForMap();
    });

    chrome.storage.onChanged.addListener(function (changes) {
      if (changes.apiKey) apiKey = changes.apiKey.newValue || '';
      if (changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        if (!enabled) hideOverlay();
      }
    });
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
    overlayImg.addEventListener('error', function () {
      overlayImg.style.display = 'none';
      noCoverageEl.style.display = 'flex';
    });
    overlayImg.addEventListener('load', function () {
      overlayImg.style.display = 'block';
      noCoverageEl.style.display = 'none';
    });

    noCoverageEl = document.createElement('div');
    noCoverageEl.className = 'sv-no-coverage';
    noCoverageEl.textContent = 'No Street View coverage here';
    noCoverageEl.style.display = 'none';

    overlayEl.appendChild(overlayImg);
    overlayEl.appendChild(noCoverageEl);
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
            hideOverlay();
            trackingActive = false;
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
    mapContainer.addEventListener('mouseleave', function () {
      hideOverlay();
      pendingLatLng = null;
      clearTimeout(trackingHideTimer);
      trackingActive = false;
    });
  }

  function onMouseMove(event) {
    if (!enabled || !apiKey) return;

    cursorX = event.clientX;
    cursorY = event.clientY;

    // In tracking mode, hide overlay if no TRACKING_POSITION arrives soon
    if (useTrackingMode) {
      clearTimeout(trackingHideTimer);
      trackingHideTimer = setTimeout(function () {
        hideOverlay();
        trackingActive = false;
      }, 200);
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

    // Find nearest segment for heading calculation
    var heading = 0;
    if (flatCoords.length >= 2) {
      var nearest = RwgpsGeo.nearestPointOnPolyline(latlng, flatCoords);
      if (nearest) {
        var segA = flatCoords[nearest.segmentIndex];
        var segB = flatCoords[nearest.segmentIndex + 1];
        heading = RwgpsGeo.computeBearing(segA, segB);
      }
    }

    // Skip update if within 5m of last shown point
    if (lastShownPoint && RwgpsGeo.distanceMeters(lastShownPoint, latlng) < 5) {
      positionOverlay();
      showOverlay();
      return;
    }

    lastShownPoint = { lat: latlng.lat, lng: latlng.lng };
    updateStreetViewImage(latlng.lat, latlng.lng, heading);
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

    var segA = flatCoords[nearest.segmentIndex];
    var segB = flatCoords[nearest.segmentIndex + 1];
    var heading = RwgpsGeo.computeBearing(segA, segB);

    lastShownPoint = { lat: nearest.lat, lng: nearest.lng };
    updateStreetViewImage(nearest.lat, nearest.lng, heading);
    positionOverlay();
    showOverlay();
  }

  // --- Overlay Management ---

  function updateStreetViewImage(lat, lng, heading) {
    var url = 'https://maps.googleapis.com/maps/api/streetview'
      + '?size=400x250'
      + '&location=' + lat.toFixed(6) + ',' + lng.toFixed(6)
      + '&heading=' + Math.round(heading)
      + '&radius=100'
      + '&pitch=-5'
      + '&fov=90'
      + '&key=' + encodeURIComponent(apiKey)
      + '&return_error_code=true';

    noCoverageEl.style.display = 'none';
    overlayImg.src = url;
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
  }

  // --- Start ---
  init();
})();
