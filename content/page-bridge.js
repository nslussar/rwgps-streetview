/**
 * Page bridge - runs in MAIN world to access Google Maps instances.
 * Communicates with the content script via window.postMessage.
 *
 * Strategy: Hook google.maps.Map and google.maps.Polyline constructors
 * to capture instances. Also scan DOM for already-created maps as fallback.
 */
(function () {
  'use strict';

  const PREFIX = 'RWGPS_SV_';
  let map = null;
  let polylines = [];
  let overlayProjection = null;
  let hooksInstalled = false;
  let trackingMarker = null;
  let markerMoveCounts = new Map(); // marker -> {count, lastTime}

  function debounce(fn, ms) {
    let timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function log(msg) {
    console.log('[RWGPS SV Bridge] ' + msg);
  }

  function tryGetMapFrom(obj, label) {
    if (map) return;
    try {
      var m = obj.getMap();
      if (m) { log('Map found via ' + label); onMapFound(m); }
    } catch (e) { /* ignore */ }
  }

  // Throttle tracking updates to ~12/sec (every 80ms)
  let lastTrackingSend = 0;
  let pendingTrackingLatlng = null;
  let trackingSendTimer = null;

  function throttledTrackingUpdate(latlng) {
    var lat = typeof latlng.lat === 'function' ? latlng.lat() : latlng.lat;
    var lng = typeof latlng.lng === 'function' ? latlng.lng() : latlng.lng;
    var data = { lat: lat, lng: lng };

    var now = Date.now();
    if (now - lastTrackingSend >= 80) {
      lastTrackingSend = now;
      clearTimeout(trackingSendTimer);
      window.postMessage({
        type: PREFIX + 'EVENT',
        action: 'TRACKING_POSITION',
        data: data
      }, '*');
    } else {
      // Queue the latest position so we always send the final one
      pendingTrackingLatlng = data;
      if (!trackingSendTimer) {
        trackingSendTimer = setTimeout(function () {
          trackingSendTimer = null;
          if (pendingTrackingLatlng) {
            lastTrackingSend = Date.now();
            window.postMessage({
              type: PREFIX + 'EVENT',
              action: 'TRACKING_POSITION',
              data: pendingTrackingLatlng
            }, '*');
            pendingTrackingLatlng = null;
          }
        }, 80 - (now - lastTrackingSend));
      }
    }
  }

  // --- Constructor hooks ---

  function installHooks() {
    if (hooksInstalled) return;
    if (!window.google || !window.google.maps) return;
    hooksInstalled = true;

    // Hook Map constructor
    const OrigMap = google.maps.Map;
    google.maps.Map = function (div, opts) {
      const instance = Reflect.construct(OrigMap, [div, opts], google.maps.Map);
      log('Map constructor intercepted');
      onMapFound(instance);
      return instance;
    };
    google.maps.Map.prototype = OrigMap.prototype;
    Object.setPrototypeOf(google.maps.Map, OrigMap);

    // Hook Polyline constructor
    const OrigPolyline = google.maps.Polyline;
    google.maps.Polyline = function (opts) {
      const instance = Reflect.construct(OrigPolyline, [opts], google.maps.Polyline);
      log('Polyline constructor intercepted');
      trackPolyline(instance);
      return instance;
    };
    google.maps.Polyline.prototype = OrigPolyline.prototype;
    Object.setPrototypeOf(google.maps.Polyline, OrigPolyline);

    // Hook Polyline.prototype.setMap to capture the map instance even if
    // the Map constructor was called before our hooks were installed.
    const origPolySetMap = google.maps.Polyline.prototype.setMap;
    google.maps.Polyline.prototype.setMap = function (mapInstance) {
      origPolySetMap.call(this, mapInstance);
      if (mapInstance && !map) {
        log('Map found via Polyline.setMap');
        onMapFound(mapInstance);
      }
    };

    // Hook Marker.prototype.setPosition to detect RWGPS's tracking marker.
    // The tracking marker is the one whose position changes rapidly (mouse-following).
    const origSetPosition = google.maps.Marker.prototype.setPosition;
    google.maps.Marker.prototype.setPosition = function (latlng) {
      origSetPosition.call(this, latlng);
      onMarkerMoved(this, latlng);
    };

    // Hook Marker.prototype.setVisible to detect show/hide of tracking marker
    const origSetVisible = google.maps.Marker.prototype.setVisible;
    google.maps.Marker.prototype.setVisible = function (visible) {
      origSetVisible.call(this, visible);
      if (this === trackingMarker && !visible) {
        window.postMessage({
          type: PREFIX + 'EVENT',
          action: 'TRACKING_LOST'
        }, '*');
      }
    };

    // Fallback: hook getBounds to catch existing map instances.
    // When injected late, the Map constructor was already called so our
    // constructor hook missed it. getBounds is called frequently by the
    // Maps API itself, so this captures the instance almost immediately.
    const origGetBounds = google.maps.Map.prototype.getBounds;
    google.maps.Map.prototype.getBounds = function () {
      if (!map) {
        log('Map found via getBounds hook');
        onMapFound(this);
      }
      return origGetBounds.call(this);
    };

    log('Constructor hooks installed');
  }

  function onMarkerMoved(marker, latlng) {
    if (!latlng) return;

    // If we already identified the tracking marker, forward (throttled)
    if (marker === trackingMarker) {
      throttledTrackingUpdate(latlng);
      return;
    }

    // Detect tracking marker: the one whose setPosition is called rapidly (>5 times/sec)
    var now = Date.now();
    var info = markerMoveCounts.get(marker);
    if (!info) {
      info = { count: 0, windowStart: now };
      markerMoveCounts.set(marker, info);
    }

    info.count++;

    // Reset window every second
    if (now - info.windowStart > 1000) {
      if (info.count > 5) {
        // This marker is being repositioned rapidly - it's the tracking marker
        if (trackingMarker !== marker) {
          log('Identified RWGPS tracking marker (moved ' + info.count + ' times/sec)');
        }
        trackingMarker = marker;
        // Clean up other markers from detection map, keep only this one
        markerMoveCounts.clear();

        // In edit mode, getBounds hook may never fire
        tryGetMapFrom(marker, 'tracking marker.getMap()');

        throttledTrackingUpdate(latlng);
        return;
      }
      info.count = 0;
      info.windowStart = now;
    }
  }

  // --- Finding existing instances (fallback when hooks are too late) ---

  function scanForExistingMap() {
    if (map) return true;

    const gmStyle = document.querySelector('.gm-style');
    if (!gmStyle) {
      log('scanForExistingMap: no .gm-style element found');
      return false;
    }

    const mapDiv = gmStyle.parentElement;
    if (!mapDiv) return false;

    log('scanForExistingMap: found map div, checking __gm=' + !!mapDiv.__gm);

    // Google Maps stores __gm on the map div
    if (mapDiv.__gm) {
      // Try to find the Map instance via __gm internals
      const gm = mapDiv.__gm;
      // The Map instance may be stored directly or nested
      if (gm && typeof gm === 'object') {
        // Check common internal locations
        for (const key of Object.keys(gm)) {
          const val = gm[key];
          if (val && typeof val.getZoom === 'function' && typeof val.getBounds === 'function') {
            log('Found existing Map via __gm.' + key);
            onMapFound(val);
            return true;
          }
        }
      }
    }

    // Scan mapDiv's own properties for the Map instance
    for (const key of Object.getOwnPropertyNames(mapDiv)) {
      try {
        const val = mapDiv[key];
        if (val && typeof val === 'object' &&
            typeof val.getZoom === 'function' &&
            typeof val.getBounds === 'function' &&
            typeof val.getDiv === 'function') {
          log('Found existing Map via div property: ' + key);
          onMapFound(val);
          return true;
        }
      } catch (e) { /* skip */ }
    }

    return false;
  }

  function scanForExistingPolylines() {
    // If we have the map, we can try to find polylines through the internal
    // overlay map pane. But Google Maps doesn't expose overlay enumeration.
    // Instead, rely on constructor hooks for new polylines and attempt
    // to find existing ones via the map div's internal structures.

    if (!map) return;

    // Check if the map div has __gm with overlay data
    const mapDiv = map.getDiv();
    if (!mapDiv || !mapDiv.__gm) return;

    // Look through __gm for arrays that might contain overlays
    function searchForPolylines(obj, depth) {
      if (depth > 3 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (item && typeof item.getPath === 'function' && typeof item.getMap === 'function') {
            if (!polylines.includes(item)) {
              log('Found existing Polyline via scan');
              trackPolyline(item);
            }
          }
        }
      }
    }

    try {
      searchForPolylines(mapDiv.__gm, 0);
    } catch (e) { /* ignore */ }
  }

  // --- Instance management ---

  function onMapFound(mapInstance) {
    if (map === mapInstance) return;
    map = mapInstance;
    log('Map ready, zoom=' + map.getZoom());
    setupProjectionHelper();

    // Scan for existing polylines after a short delay
    setTimeout(function () {
      scanForExistingPolylines();
      pushReady();
    }, 500);

    // Also push updates again after more time (route data may load async)
    setTimeout(function () {
      scanForExistingPolylines();
      debouncedRouteUpdate();
    }, 2000);

    setTimeout(function () {
      scanForExistingPolylines();
      debouncedRouteUpdate();
    }, 5000);

    // RWGPS defers polyline creation (React Query refetchOnWindowFocus).
    // Instead of waiting, fetch route coords directly from the RWGPS API.
    apiFetchTimer = setTimeout(function () {
      apiFetchTimer = null;
      if (polylines.length > 0) return;
      fetchRouteFromAPI();
    }, 2000);
  }

  var apiRouteCoords = null; // coords fetched directly from RWGPS API
  var apiFetchTimer = null;

  function fetchRouteFromAPI() {
    // Extract route ID from URL:
    //   /routes/12345 or /routes/12345/edit (view/edit existing)
    //   /routes/new?importId=12345 (editor with imported route)
    var match = window.location.pathname.match(/\/routes\/(\d+)/);
    var routeId = match ? match[1] : new URLSearchParams(window.location.search).get('importId');
    if (!routeId) {
      log('Cannot extract route ID from URL');
      return;
    }
    log('Fetching route coords from API for route ' + routeId);

    fetch('/routes/' + routeId + '.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (polylines.length > 0) return; // polylines appeared while fetching
        var trackPoints = (data && data.track_points) ||
                          (data && data.route && data.route.track_points);
        if (!trackPoints || trackPoints.length < 2) {
          log('API response has no track points');
          return;
        }
        var coords = trackPoints.map(function (p) {
          return {
            lat: p.y != null ? p.y : p.lat,
            lng: p.x != null ? p.x : p.lng
          };
        });
        apiRouteCoords = [coords];
        log('API fetch: got ' + coords.length + ' track points');
        window.postMessage({
          type: PREFIX + 'EVENT',
          action: 'ROUTE_CHANGED',
          data: apiRouteCoords
        }, '*');
      })
      .catch(function (e) {
        log('API fetch failed: ' + e.message);
      });
  }

  function trackPolyline(polyline) {
    if (polylines.includes(polyline)) return;
    polylines.push(polyline);
    apiRouteCoords = null; // real polylines supersede API-fetched coords
    if (apiFetchTimer) { clearTimeout(apiFetchTimer); apiFetchTimer = null; }

    tryGetMapFrom(polyline, 'polyline.getMap()');

    // Watch for path changes
    try {
      const path = polyline.getPath();
      if (path) {
        google.maps.event.addListener(path, 'set_at', debouncedRouteUpdate);
        google.maps.event.addListener(path, 'insert_at', debouncedRouteUpdate);
        google.maps.event.addListener(path, 'remove_at', debouncedRouteUpdate);
      }
    } catch (e) { /* ignore */ }

    debouncedRouteUpdate();
  }

  function setupProjectionHelper() {
    if (!map) return;

    const overlay = new google.maps.OverlayView();
    overlay.onAdd = function () {
      overlayProjection = this.getProjection();
      log('Projection helper ready');
    };
    overlay.draw = function () {
      overlayProjection = this.getProjection();
    };
    overlay.onRemove = function () {};
    overlay.setMap(map);
  }

  // --- Coordinate extraction ---

  function extractRouteCoords() {
    const allCoords = [];

    // Prune dead polylines (removed from map)
    polylines = polylines.filter(function (p) {
      try { return !!p.getMap(); } catch (e) { return false; }
    });

    for (const polyline of polylines) {
      try {
        const path = polyline.getPath();
        if (!path || path.getLength() === 0) continue;

        const coords = [];
        for (let i = 0; i < path.getLength(); i++) {
          const ll = path.getAt(i);
          coords.push({ lat: ll.lat(), lng: ll.lng() });
        }
        if (coords.length > 1) {
          allCoords.push(coords);
        }
      } catch (e) { /* skip dead polylines */ }
    }

    return allCoords;
  }

  const debouncedRouteUpdate = debounce(function () {
    const coords = extractRouteCoords();
    log('Route update: ' + coords.length + ' polylines, ' +
        coords.reduce(function (s, c) { return s + c.length; }, 0) + ' points');
    // Don't send empty updates if we have API-fetched coords
    if (coords.length === 0 && apiRouteCoords) return;
    window.postMessage({
      type: PREFIX + 'EVENT',
      action: 'ROUTE_CHANGED',
      data: coords.length > 0 ? coords : apiRouteCoords
    }, '*');
  }, 300);

  function pushReady() {
    const coords = extractRouteCoords();
    log('Pushing MAP_READY with ' + coords.length + ' polylines');
    window.postMessage({
      type: PREFIX + 'EVENT',
      action: 'MAP_READY',
      data: coords
    }, '*');
  }

  // --- Pixel to LatLng ---

  function pixelToLatLng(x, y) {
    if (!map) return null;

    // Method 1: OverlayView projection (most accurate)
    if (overlayProjection) {
      try {
        const point = new google.maps.Point(x, y);
        const latlng = overlayProjection.fromContainerPixelToLatLng(point);
        if (latlng) return { lat: latlng.lat(), lng: latlng.lng() };
      } catch (e) { /* fall through */ }
    }

    // Method 2: Bounds-based interpolation (fallback)
    const bounds = map.getBounds();
    if (!bounds) return null;

    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const div = map.getDiv();
    const width = div.offsetWidth;
    const height = div.offsetHeight;

    return {
      lat: ne.lat() - (y / height) * (ne.lat() - sw.lat()),
      lng: sw.lng() + (x / width) * (ne.lng() - sw.lng())
    };
  }

  // --- Message handling ---

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith(PREFIX + 'REQUEST')) return;

    switch (msg.action) {
      case 'GET_ROUTE_COORDS': {
        // Also re-scan for polylines when explicitly asked
        scanForExistingPolylines();
        window.postMessage({
          type: PREFIX + 'RESPONSE',
          action: 'ROUTE_COORDS',
          data: extractRouteCoords()
        }, '*');
        break;
      }

      case 'PIXEL_TO_LATLNG': {
        const result = pixelToLatLng(msg.data.x, msg.data.y);
        if (result) {
          window.postMessage({
            type: PREFIX + 'RESPONSE',
            action: 'LATLNG',
            data: result,
            zoom: map ? map.getZoom() : 15,
            requestId: msg.requestId
          }, '*');
        }
        break;
      }

      case 'REVERSE_GEOCODE': {
        if (!window.google || !window.google.maps) break;
        var geocoder = new google.maps.Geocoder();
        var reqId = msg.requestId;
        geocoder.geocode(
          { location: { lat: msg.data.lat, lng: msg.data.lng } },
          function (results, status) {
            var streetNumber = '';
            var streetName = '';
            var city = '';
            if (status === 'OK' && results && results.length > 0) {
              // Extract components from the most specific result
              for (var i = 0; i < results.length; i++) {
                var comps = results[i].address_components;
                for (var j = 0; j < comps.length; j++) {
                  var types = comps[j].types;
                  if (!streetNumber && types.indexOf('street_number') !== -1) {
                    streetNumber = comps[j].long_name;
                  }
                  if (!streetName && types.indexOf('route') !== -1) {
                    streetName = comps[j].long_name;
                  }
                  if (!city && types.indexOf('locality') !== -1) {
                    city = comps[j].long_name;
                  }
                }
                if (streetName) break;
              }
            }
            // Build label: "123 Main St, Portland" or "Main St, Portland" or "Main St"
            var label = '';
            if (streetName) {
              label = streetNumber ? streetNumber + ' ' + streetName : streetName;
              if (city) label += ', ' + city;
            }
            window.postMessage({
              type: PREFIX + 'RESPONSE',
              action: 'GEOCODE_RESULT',
              data: { label: label },
              requestId: reqId
            }, '*');
          }
        );
        break;
      }

      case 'PING': {
        window.postMessage({
          type: PREFIX + 'RESPONSE',
          action: 'PONG',
          data: { mapFound: !!map, polylines: polylines.length }
        }, '*');
        break;
      }
    }
  });

  // --- Bootstrap ---

  function bootstrap() {
    // Try to install hooks before google.maps creates anything
    installHooks();

    // Also scan for existing map (in case hooks were too late)
    scanForExistingMap();
  }

  // If google.maps is already loaded, bootstrap immediately
  if (window.google && window.google.maps && window.google.maps.Map) {
    log('google.maps already loaded, bootstrapping');
    bootstrap();
  }

  // Poll for google.maps availability (handles lazy loading)
  let pollCount = 0;
  const pollTimer = setInterval(function () {
    pollCount++;

    if (window.google && window.google.maps && window.google.maps.Map) {
      bootstrap();

      // Keep scanning for map instance even after hooks are installed
      // (covers the race where Map was created between hook install and scan)
      if (!map) {
        scanForExistingMap();
      }

      // Once we have a map, we can stop polling
      if (map && pollCount > 20) {
        clearInterval(pollTimer);
      }
    }

    // After 60s of fast polling, slow down to every 2s instead of giving up
    if (pollCount === 240) {
      clearInterval(pollTimer);
      log('Slowing poll for google.maps to every 2s');
      var slowTimer = setInterval(function () {
        if (window.google && window.google.maps && window.google.maps.Map) {
          bootstrap();
          if (!map) scanForExistingMap();
          if (map) clearInterval(slowTimer);
        }
      }, 2000);
    }
  }, 250);
})();
