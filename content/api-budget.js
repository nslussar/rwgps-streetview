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

  var cap = DEFAULT_CAP;
  var capEnabled = true;
  var streetviewNetwork = 0;

  function init() {
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
    // Stale content scripts (after extension reload) throw "Extension context
    // invalidated" — swallow it; the user just needs to refresh the page.
    try {
      chrome.runtime.sendMessage({ type: GEOCODE_MSG }, function () {
        if (chrome.runtime.lastError) { /* swallow */ }
      });
    } catch (_) { /* swallow */ }
  }

  window.RwgpsApiBudget = {
    init: init,
    tryStreetView: tryStreetView,
    countGeocode: countGeocode
  };
})();
