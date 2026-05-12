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
  const TRACKING_UPDATE_INTERVAL = 150; // keep in sync with content.js
  let map = null;
  let polylines = [];
  let overlayProjection = null;
  let hooksInstalled = false;
  let trackingMarker = null;
  let markerMoveCounts = new Map(); // marker -> {count, lastTime}
  let currentZoom = null;
  // Forwarded from the content script via SET_DEBUG (the bridge runs in MAIN
  // world and can't read chrome.storage itself). Gates per-lookup retry /
  // error-dump / SIS-rescue / reverse-geocode diagnostics. Always-on bridge
  // events (constructor hooks, map-ready, projection-helper) keep using log().
  var debugEnabled = false;

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

  function vlog() {
    if (!debugEnabled) return;
    console.log.apply(console, arguments);
  }

  function tryGetMapFrom(obj, label) {
    if (map) return;
    try {
      var m = obj.getMap();
      if (m) {
        vlog('[RWGPS SV Bridge] Map found via ' + label);
        onMapFound(m);
      }
    } catch (e) { /* ignore */ }
  }

  // Resolve the streetView library object. Returns `{StreetViewService, StreetViewSource}`
  // or null. Handles both legacy global and dynamic loader (importLibrary).
  // We need StreetViewSource so we can filter out user-contributed photospheres
  // (type 10), which `streetviewpixels-pa.googleapis.com/v1/tile` does not serve —
  // their wrapped panoids would 4xx from the tile endpoint even though the
  // metadata lookup succeeds.
  var cachedSvLib = null;
  function getStreetViewLib() {
    if (cachedSvLib) return Promise.resolve(cachedSvLib);
    if (!window.google || !window.google.maps) return Promise.resolve(null);
    if (google.maps.StreetViewService) {
      cachedSvLib = {
        StreetViewService: google.maps.StreetViewService,
        StreetViewSource: google.maps.StreetViewSource
      };
      return Promise.resolve(cachedSvLib);
    }
    if (typeof google.maps.importLibrary === 'function') {
      return google.maps.importLibrary('streetView').then(function (lib) {
        cachedSvLib = lib;
        return lib;
      }).catch(function (e) {
        log('importLibrary("streetView") failed: ' + (e && e.message || e));
        return null;
      });
    }
    return Promise.resolve(null);
  }

  // SingleImageSearch RPC — used to extract the gpms-cs-s URL for type-10
  // (UGC) panoramas. The endpoint is keyless; CORS-permissive from
  // ridewithgps.com origin. See design spec section 4.2 for the request
  // shape rationale.
  var SINGLE_IMAGE_SEARCH_URL =
    'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch';

  // No bridge-side cache for v1: each LOOKUP_PANO that resolves to type-10
  // fires its own SingleImageSearch. Forward-sweep workflows get zero
  // benefit from caching here (each bucketed cursor position resolves to a
  // unique panoid on trails with ~10m UGC spacing — typical when one rider
  // uploads via a 360 camera at fixed intervals). Re-sweep / cursor-pause
  // workflows would benefit, but the cache costs ~10 lines.
  // FUTURE: see spec section 7.1 for a panoid-keyed cache + concurrent-dedup
  // map design when telemetry justifies it.

  // POST a SingleImageSearch request and parse the response for the
  // gpms-cs-s URL. Returns:
  //   { ok: true,  tokenBase: '...' }
  //   { ok: false, errorClass: 'UGC_RPC_HTTP_ERROR' | 'UGC_RPC_PARSE_FAIL' | 'UGC_URL_NOT_FOUND', message: string }
  async function singleImageSearch(lat, lng, radius) {
    var body;
    try {
      body = JSON.stringify(
        RwgpsPhotospheres.buildSingleImageSearchBody(lat, lng, radius));
    } catch (e) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_PARSE_FAIL',
        message: 'body build failed: ' + e.message
      };
    }

    var resp;
    try {
      resp = await fetch(SINGLE_IMAGE_SEARCH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json+protobuf',
          'x-user-agent': 'grpc-web-javascript/0.1'
        },
        body: body
      });
    } catch (e) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_HTTP_ERROR',
        message: 'network: ' + e.message
      };
    }

    if (!resp.ok) {
      return {
        ok: false,
        errorClass: 'UGC_RPC_HTTP_ERROR',
        message: 'HTTP ' + resp.status
      };
    }

    var rawText = await resp.text();
    return RwgpsPhotospheres.parseUgcUrlFromResponse(rawText);
  }

  // Wrap window.postMessage boilerplate for PANO_INFO responses.
  function sendPanoInfo(reqId, data) {
    window.postMessage({
      type: PREFIX + 'RESPONSE',
      action: 'PANO_INFO',
      data: data,
      requestId: reqId
    }, '*');
  }
  function sendPanoInfoError(reqId, errResult) {
    window.postMessage({
      type: PREFIX + 'RESPONSE',
      action: 'PANO_INFO',
      data: {
        error: errResult.message || 'unknown',
        noCoverage: errResult.errorClass === 'NO_COVERAGE',
        errorClass: errResult.errorClass
      },
      requestId: reqId
    }, '*');
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
    if (now - lastTrackingSend >= TRACKING_UPDATE_INTERVAL) {
      lastTrackingSend = now;
      clearTimeout(trackingSendTimer);
      window.postMessage({
        type: PREFIX + 'EVENT',
        action: 'TRACKING_POSITION',
        data: data,
        zoom: currentZoom
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
              data: pendingTrackingLatlng,
              zoom: currentZoom
            }, '*');
            pendingTrackingLatlng = null;
          }
        }, TRACKING_UPDATE_INTERVAL - (now - lastTrackingSend));
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
      vlog('[RWGPS SV Bridge] Map constructor intercepted');
      onMapFound(instance);
      return instance;
    };
    google.maps.Map.prototype = OrigMap.prototype;
    Object.setPrototypeOf(google.maps.Map, OrigMap);

    // Hook Polyline constructor
    const OrigPolyline = google.maps.Polyline;
    google.maps.Polyline = function (opts) {
      const instance = Reflect.construct(OrigPolyline, [opts], google.maps.Polyline);
      vlog('[RWGPS SV Bridge] Polyline constructor intercepted');
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
        vlog('[RWGPS SV Bridge] Map found via Polyline.setMap');
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
      if (this === trackingMarker) {
        if (!visible) {
          window.postMessage({
            type: PREFIX + 'EVENT',
            action: 'TRACKING_LOST'
          }, '*');
        } else {
          // Marker reappeared — send its current position immediately
          // so the overlay updates without waiting for the next setPosition
          var pos = this.getPosition();
          if (pos) throttledTrackingUpdate(pos);
        }
      }
    };

    // Fallback: hook getBounds to catch existing map instances.
    // When injected late, the Map constructor was already called so our
    // constructor hook missed it. getBounds is called frequently by the
    // Maps API itself, so this captures the instance almost immediately.
    const origGetBounds = google.maps.Map.prototype.getBounds;
    google.maps.Map.prototype.getBounds = function () {
      if (!map) {
        vlog('[RWGPS SV Bridge] Map found via getBounds hook');
        onMapFound(this);
      }
      return origGetBounds.call(this);
    };

    vlog('[RWGPS SV Bridge] Constructor hooks installed');
  }

  function onMarkerMoved(marker, latlng) {
    if (!latlng) return;

    // If we already identified the tracking marker, forward only when visible.
    // RWGPS may reposition the marker while hidden; sending those updates
    // would fight with TRACKING_LOST deactivation.
    if (marker === trackingMarker) {
      var vis = marker.getVisible();
      if (vis) throttledTrackingUpdate(latlng);
      return;
    }

    // Detect tracking marker: the one whose setPosition is called rapidly.
    // Re-identification (RWGPS recreated the marker): 2 calls within 300ms.
    // First identification: 3 calls within 500ms to avoid static markers.
    var now = Date.now();
    var info = markerMoveCounts.get(marker);
    if (!info) {
      info = { count: 0, firstSeen: now };
      markerMoveCounts.set(marker, info);
    }
    info.count++;

    var elapsed = now - info.firstSeen;
    var isRapid = trackingMarker
      ? info.count >= 2 && elapsed < 300
      : info.count >= 3 && elapsed < 500;

    if (isRapid) {
      if (trackingMarker !== marker) {
        vlog('[RWGPS SV Bridge] Identified RWGPS tracking marker (moved ' + info.count + ' times in ' + (now - info.firstSeen) + 'ms)');
      }
      trackingMarker = marker;
      markerMoveCounts.clear();

      // In edit mode, getBounds hook may never fire
      tryGetMapFrom(marker, 'tracking marker.getMap()');

      throttledTrackingUpdate(latlng);
      return;
    }
  }

  // --- Finding existing instances (fallback when hooks are too late) ---

  function scanForExistingMap() {
    if (map) return true;

    const gmStyle = document.querySelector('.gm-style');
    if (!gmStyle) {
      vlog('[RWGPS SV Bridge] scanForExistingMap: no .gm-style element found');
      return false;
    }

    const mapDiv = gmStyle.parentElement;
    if (!mapDiv) return false;

    vlog('[RWGPS SV Bridge] scanForExistingMap: found map div, checking __gm=' + !!mapDiv.__gm);

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
            vlog('[RWGPS SV Bridge] Found existing Map via __gm.' + key);
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
          vlog('[RWGPS SV Bridge] Found existing Map via div property: ' + key);
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
              vlog('[RWGPS SV Bridge] Found existing Polyline via scan');
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
    currentZoom = map.getZoom();
    log('Map ready, zoom=' + currentZoom);
    try {
      map.addListener('zoom_changed', function () {
        currentZoom = map.getZoom();
      });
    } catch (e) { /* listener attach failed; bridge still works with stale zoom */ }
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
    vlog('[RWGPS SV Bridge] Fetching route coords from API for route ' + routeId);

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
      vlog('[RWGPS SV Bridge] Projection helper ready');
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
    vlog('[RWGPS SV Bridge] Route update: ' + coords.length + ' polylines, ' +
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
            zoom: currentZoom != null ? currentZoom : (map ? map.getZoom() : 15),
            requestId: msg.requestId
          }, '*');
        }
        break;
      }

      case 'LOOKUP_PANO': {
        var reqId = msg.requestId;
        var radius = (msg.data && msg.data.radius) || 50;
        getStreetViewLib().then(function (lib) {
          if (!lib || !lib.StreetViewService) {
            window.postMessage({
              type: PREFIX + 'RESPONSE',
              action: 'PANO_INFO',
              data: { error: 'StreetViewService unavailable' },
              requestId: reqId
            }, '*');
            return;
          }
          var opts = {
            location: { lat: msg.data.lat, lng: msg.data.lng },
            radius: radius
          };
          // OUTDOOR excludes indoor type-2 ("Business View") panoramas AND
          // admits user-contributed photospheres (type-10) into the candidate
          // set. At the extension's small radius, type-2 ranking is effectively
          // moot on bike paths (no type-2 in range) and OUTDOOR falls through
          // to type-10 by elimination — recovering bike-path coverage.
          // See spec section 2.2.
          //
          // FUTURE: filter UGC by source tag (photos:street_view_android only)
          // if quality complaints come in — see spec section 7.2.
          var sourceVal = (lib.StreetViewSource && lib.StreetViewSource.OUTDOOR) || 'outdoor';
          opts.source = sourceVal;

          // DIAGNOSTIC — Maps JS getPanorama is flaky: identical bucketed
          // queries within a single session sometimes return ZERO_RESULTS and
          // sometimes succeed. Static API at the same coords returns coverage,
          // confirming the pano exists. Retry-with-logging distinguishes
          // transient flakiness from genuine no-coverage. If retry success
          // rate is high we'll either keep the retry or move to a different
          // lookup path entirely. See logs tagged 'getPanorama retry'.
          var MAX_RETRIES = 2;
          var RETRY_DELAY_MS = 300;
          var attemptNum = 0;

          function doLookup() {
            // Fresh StreetViewService per attempt — in case Maps JS holds
            // internal state per-instance that contributes to flakiness.
            var svc = new lib.StreetViewService();
            svc.getPanorama(opts)
              .then(async function (res) {
                if (attemptNum > 0) {
                  vlog('[RWGPS SV Bridge] getPanorama retry SUCCESS',
                    'req=' + reqId,
                    'attempt=' + (attemptNum + 1) + '/' + (MAX_RETRIES + 1),
                    'q=(' + msg.data.lat.toFixed(6) + ',' + msg.data.lng.toFixed(6) + ')');
                }
                var d = res && res.data;
                if (!d || !d.location) {
                  sendPanoInfoError(reqId, { errorClass: 'NO_COVERAGE', message: 'no data' });
                  return;
                }

                var panoid = d.location.pano;
                var common = {
                  panoid: panoid,
                  snappedLat: d.location.latLng.lat(),
                  snappedLng: d.location.latLng.lng(),
                  originHeading: d.tiles && d.tiles.originHeading,
                  originPitch: d.tiles && d.tiles.originPitch,
                  copyright: d.copyright || '',
                  // Echoed for diagnostic logging on the content side — lets
                  // the success log show q→snapped distance vs. radius.
                  queryLat: msg.data.lat,
                  queryLng: msg.data.lng,
                  queryRadius: radius
                };

                // Type-10 (UGC) branch — fire SingleImageSearch to extract the
                // gpms-cs-s URL. streetviewpixels-pa doesn't serve type-10, so
                // we have to render via a different content tier.
                if (RwgpsPhotospheres.isUgcPanoid(panoid)) {
                  // Use the SNAPPED pano coords (from getPanorama) instead of the
                  // raw cursor lat/lng. SingleImageSearch ranks results by proximity
                  // to the query point — using the snapped coords guarantees we
                  // match the same pano getPanorama just confirmed exists, not a
                  // different nearby UGC pano.
                  var ugcResult = await singleImageSearch(common.snappedLat, common.snappedLng, radius);
                  if (ugcResult.ok) {
                    sendPanoInfo(reqId, Object.assign({}, common, {
                      kind: 'ugc',
                      tokenBase: ugcResult.tokenBase
                    }));
                  } else {
                    sendPanoInfoError(reqId, ugcResult);
                  }
                  return;
                }

                // Type-2 path — existing tile-grid render.
                var ws = d.tiles && d.tiles.worldSize;
                sendPanoInfo(reqId, Object.assign({}, common, {
                  kind: 'tile',
                  worldSize: ws ? { width: ws.width, height: ws.height } : null
                }));
              })
              .catch(function (e) {
                var emsg = String(e && e.message || e);
                var noCoverage = emsg.indexOf('ZERO_RESULTS') !== -1;

                if (noCoverage) {
                  // Dump the full error object so DevTools surfaces fields
                  // we currently ignore — most interesting one is
                  // `endLocation` (LatLng of the closest pano Maps JS
                  // considered, even on ZERO_RESULTS). If endLocation is
                  // near our query, the backend knows about a pano it
                  // refused to return.
                  vlog('[RWGPS SV Bridge] getPanorama error dump',
                    'req=' + reqId,
                    'attempt=' + (attemptNum + 1) + '/' + (MAX_RETRIES + 1),
                    'q=(' + msg.data.lat.toFixed(6) + ',' + msg.data.lng.toFixed(6) + ')',
                    'error:', e);
                }

                if (noCoverage && attemptNum < MAX_RETRIES) {
                  attemptNum++;
                  vlog('[RWGPS SV Bridge] getPanorama ZERO_RESULTS, retrying',
                    'req=' + reqId,
                    'attempt=' + (attemptNum + 1) + '/' + (MAX_RETRIES + 1),
                    'q=(' + msg.data.lat.toFixed(6) + ',' + msg.data.lng.toFixed(6) + ')',
                    'delay=' + RETRY_DELAY_MS + 'ms');
                  setTimeout(doLookup, RETRY_DELAY_MS);
                  return;
                }

                if (attemptNum > 0) {
                  vlog('[RWGPS SV Bridge] getPanorama FAILED after retries',
                    'req=' + reqId,
                    'totalAttempts=' + (attemptNum + 1),
                    'noCoverage=' + noCoverage,
                    'q=(' + msg.data.lat.toFixed(6) + ',' + msg.data.lng.toFixed(6) + ')');
                }

                // SIS RESCUE — after getPanorama exhausts retries on a
                // ZERO_RESULTS, fall through to SingleImageSearch as the
                // metadata source. SIS hits a different backend and reliably
                // finds the panos getPanorama is stale-caching out. If SIS
                // returns a type-10 (UGC) pano, build a synthetic PANO_INFO
                // and route through the existing UGC render path. For other
                // outcomes (SIS empty, unhandled type) we fall back to the
                // original ZERO_RESULTS error.
                if (noCoverage) {
                  singleImageSearch(msg.data.lat, msg.data.lng, radius).then(function (sis) {
                    if (sis.ok && sis.panoType === 10) {
                      vlog('[RWGPS SV Bridge] SIS rescue: rendering UGC from SIS data',
                        'req=' + reqId,
                        'q=(' + msg.data.lat.toFixed(6) + ',' + msg.data.lng.toFixed(6) + ')',
                        'panoid=' + sis.panoid,
                        'snapped=(' + (sis.snappedLat != null ? sis.snappedLat.toFixed(6) : '?')
                          + ',' + (sis.snappedLng != null ? sis.snappedLng.toFixed(6) : '?') + ')',
                        'originHeading=' + (sis.originHeading != null ? sis.originHeading.toFixed(2) : '?'),
                        'originHeadingAlt=' + (sis.originHeadingAlt != null ? sis.originHeadingAlt.toFixed(2) : '?'),
                        'originPitch=' + (sis.originPitch != null ? sis.originPitch.toFixed(2) : '?'),
                        'copyright=' + sis.copyright);
                      sendPanoInfo(reqId, {
                        kind: 'ugc',
                        // Inner panoid (no CAoS wrapper). Downstream code
                        // uses this only for logging — the UGC render path
                        // builds URLs from tokenBase, not the panoid.
                        panoid: sis.panoid,
                        snappedLat: sis.snappedLat,
                        snappedLng: sis.snappedLng,
                        originHeading: sis.originHeading,
                        originPitch: sis.originPitch,
                        copyright: sis.copyright,
                        tokenBase: sis.tokenBase,
                        queryLat: msg.data.lat,
                        queryLng: msg.data.lng,
                        queryRadius: radius
                      });
                      return;
                    }
                    if (sis.ok) {
                      console.log('[RWGPS SV Bridge] SIS rescue: unhandled panoType, falling back to error',
                        'req=' + reqId, 'type=' + sis.panoType);
                    } else {
                      console.log('[RWGPS SV Bridge] SIS rescue: SIS also empty',
                        'req=' + reqId,
                        'q=(' + msg.data.lat.toFixed(6) + ',' + msg.data.lng.toFixed(6) + ')',
                        'errorClass=' + sis.errorClass);
                    }
                    sendPanoInfoError(reqId, {
                      errorClass: 'NO_COVERAGE',
                      message: emsg
                        + ' [q=' + msg.data.lat.toFixed(6)
                        + ',' + msg.data.lng.toFixed(6)
                        + ' r=' + radius + 'm'
                        + ' attempts=' + (attemptNum + 1)
                        + ' sis=' + (sis.ok ? 'type-' + sis.panoType : (sis.errorClass || 'empty'))
                        + ']'
                    });
                  });
                  return;
                }

                // Non-ZERO_RESULTS getPanorama failure (rare — network/
                // service unavailability). Leave errorClass unset so the
                // content script's panoErrorMessage falls through to the
                // generic "Street View lookup failed" message.
                sendPanoInfoError(reqId, {
                  errorClass: null,
                  message: emsg
                    + ' [q=' + msg.data.lat.toFixed(6)
                    + ',' + msg.data.lng.toFixed(6)
                    + ' r=' + radius + 'm'
                    + ' attempts=' + (attemptNum + 1) + ']'
                });
              });
          }

          doLookup();
        });
        break;
      }

      case 'REVERSE_GEOCODE': {
        if (!window.google || !window.google.maps) break;
        var geocoder = new google.maps.Geocoder();
        var reqId = msg.requestId;
        geocoder.geocode(
          { location: { lat: msg.data.lat, lng: msg.data.lng } },
          function (results, status) {
            // Diagnostic dump — surface what the geocoder offers at this
            // point so we can decide whether to prefer non-postal results
            // (e.g. a "point_of_interest" or "natural_feature" with the
            // actual trail name).
            if (debugEnabled) {
              try {
                var diag = (results || []).map(function (r) {
                  return {
                    formatted: r.formatted_address,
                    types: (r.types || []).join('|'),
                    placeName: (r.address_components && r.address_components[0] && r.address_components[0].long_name) || ''
                  };
                });
                console.log('[RWGPS SV Bridge] reverse-geocode',
                  '(' + msg.data.lat.toFixed(6) + ',' + msg.data.lng.toFixed(6) + ')',
                  'status=' + status,
                  'n=' + diag.length, diag);
              } catch (e) { /* ignore */ }
            }
            var streetNumber = '';
            var streetName = '';
            var city = '';
            if (status === 'OK' && results && results.length > 0) {
              // Prefer a result whose own top-level type is "route" — that's
              // the named road or trail at this lat/lng (e.g. "Olympic
              // Discovery Trail"). Without this preference, a closer postal
              // address result wins and we end up labeling a trail point
              // with the parallel road's name because street_address results
              // expose `route` in their address_components too.
              var pick = null;
              for (var i = 0; i < results.length; i++) {
                if ((results[i].types || []).indexOf('route') !== -1) {
                  pick = results[i];
                  break;
                }
              }
              if (!pick) pick = results[0];
              var pickIsRoute = (pick.types || []).indexOf('route') !== -1;
              var comps = pick.address_components || [];
              for (var j = 0; j < comps.length; j++) {
                var types = comps[j].types;
                // Skip the street number when we picked a route-typed result
                // — a trail name doesn't take a house number prefix.
                if (!pickIsRoute && !streetNumber && types.indexOf('street_number') !== -1) {
                  streetNumber = comps[j].long_name;
                }
                if (!streetName && types.indexOf('route') !== -1) {
                  streetName = comps[j].long_name;
                }
                if (!city && types.indexOf('locality') !== -1) {
                  city = comps[j].long_name;
                }
              }
            }
            // Build label: "123 Main St, Portland" / "Main St, Portland" /
            // "Olympic Discovery Trail, Sequim" / "Main St"
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

      case 'SET_DEBUG': {
        debugEnabled = !!(msg.data && msg.data.enabled);
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
    vlog('[RWGPS SV Bridge] google.maps already loaded, bootstrapping');
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
