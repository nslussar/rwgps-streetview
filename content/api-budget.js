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
 */
(function () {
  'use strict';

  var DEFAULT_CAP = 10000;
  var GEOCODE_MSG = 'RWGPS_SV_GEOCODE';
  var PAGE_LOAD_MSG = 'RWGPS_SV_PAGE_LOAD';

  var cap = DEFAULT_CAP;
  var capEnabled = true;
  var streetviewNetwork = 0;

  // Tolerate stale content scripts (after extension reload) — chrome.runtime
  // throws "Extension context invalidated" until the page is refreshed.
  function send(type) {
    try {
      chrome.runtime.sendMessage({ type: type }, function () {
        if (chrome.runtime.lastError) { /* swallow */ }
      });
    } catch (_) { /* swallow */ }
  }

  function init() {
    send(PAGE_LOAD_MSG);

    chrome.storage.sync.get(['apiCap', 'apiCapEnabled'], function (s) {
      cap = (typeof s.apiCap === 'number' && s.apiCap >= 0) ? s.apiCap : DEFAULT_CAP;
      capEnabled = s.apiCapEnabled !== false;
    });

    chrome.storage.local.get(['apiUsage'], function (l) {
      streetviewNetwork = (l.apiUsage && l.apiUsage.streetviewNetwork) || 0;
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'sync') {
        if (changes.apiCap) {
          var v = changes.apiCap.newValue;
          cap = (typeof v === 'number' && v >= 0) ? v : DEFAULT_CAP;
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
    return !(capEnabled && streetviewNetwork >= cap);
  }

  function countGeocode() {
    send(GEOCODE_MSG);
  }

  window.RwgpsApiBudget = {
    init: init,
    tryStreetView: tryStreetView,
    countGeocode: countGeocode
  };
})();
