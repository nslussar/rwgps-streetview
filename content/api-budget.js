/**
 * API request budget tracking — runs in ISOLATED world.
 *
 * Cap-check only — does NOT write counters. The service worker (background.js)
 * is the single writer:
 *   - chrome.webRequest.onCompleted observes Street View Static API requests
 *     and credits them as either network (billed) or cached.
 *   - countGeocode() forwards a message to the service worker to bump the
 *     geocode counter (geocoder isn't directly observable via webRequest from
 *     here since it's invoked from the page-bridge MAIN-world context).
 *
 * Cap is enforced against `streetviewNetwork` only — cache hits don't bill.
 *
 * Until the local-storage read completes, tryStreetView() returns false to
 * preserve the "no surprise billing" guarantee — we'd rather block one
 * request briefly than overshoot the cap on a near-boundary page reload.
 */
(function () {
  'use strict';

  var cap = RwgpsUsage.DEFAULT_CAP;
  var capEnabled = true;
  var streetviewNetwork = 0;
  var localLoaded = false;

  // Stale content scripts (after extension reload) throw "Extension context
  // invalidated" until the page is refreshed. Swallow.
  function send(type) {
    try {
      chrome.runtime.sendMessage({ type: type }, function () {
        if (chrome.runtime.lastError) { /* swallow */ }
      });
    } catch (_) { /* swallow */ }
  }

  function init() {
    send(RwgpsUsage.PAGE_LOAD_MSG);

    chrome.storage.sync.get(['apiCap', 'apiCapEnabled'], function (s) {
      cap = (typeof s.apiCap === 'number' && s.apiCap >= 0) ? s.apiCap : RwgpsUsage.DEFAULT_CAP;
      capEnabled = s.apiCapEnabled !== false;
    });

    chrome.storage.local.get(['apiUsage'], function (l) {
      streetviewNetwork = (l.apiUsage && l.apiUsage.streetviewNetwork) || 0;
      localLoaded = true;
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'sync') {
        if (changes.apiCap) {
          var v = changes.apiCap.newValue;
          cap = (typeof v === 'number' && v >= 0) ? v : RwgpsUsage.DEFAULT_CAP;
        }
        if (changes.apiCapEnabled) {
          capEnabled = changes.apiCapEnabled.newValue !== false;
        }
      }
      if (area === 'local' && changes.apiUsage) {
        streetviewNetwork = (changes.apiUsage.newValue && changes.apiUsage.newValue.streetviewNetwork) || 0;
      }
    });
  }

  function tryStreetView() {
    // Block until we know the real count — preserves cap on near-boundary reloads.
    if (capEnabled && !localLoaded) return false;
    return !(capEnabled && streetviewNetwork >= cap);
  }

  function countGeocode() {
    send(RwgpsUsage.GEOCODE_MSG);
  }

  window.RwgpsApiBudget = {
    init: init,
    tryStreetView: tryStreetView,
    countGeocode: countGeocode
  };
})();
