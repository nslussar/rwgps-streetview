/**
 * API request budget tracking — runs in ISOLATED world.
 *
 * Tracks two billable Google Maps APIs:
 *   - Street View Static API (billed to user's API key, 10k/mo free tier) — gated by cap.
 *   - google.maps.Geocoder    (billed to RWGPS, not the user) — counted for visibility only.
 *
 * Storage layout:
 *   chrome.storage.sync   { apiCap: number, apiCapEnabled: boolean }
 *   chrome.storage.local  { apiUsage: { month, streetview, geocode },
 *                           sessionApiUsage: { streetview, geocode } }
 *
 * Counter writes go to .local and are coalesced (one write per FLUSH_MS) — sustained
 * hover would otherwise burn ~13 storage writes/sec. sessionApiUsage is wiped on
 * browser startup by background.js.
 */
(function () {
  'use strict';

  var DEFAULT_CAP = 10000;
  var FLUSH_MS = 1000;

  var cap = DEFAULT_CAP;
  var capEnabled = true;
  var usage = null;
  var sessionUsage = null;
  var loaded = false;
  var pending = { streetview: 0, geocode: 0 }; // increments before load completes
  var flushTimer = null;
  var dirty = false;

  function currentMonth() {
    var d = new Date();
    var m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : '' + m);
  }

  function emptyUsage() {
    return { month: currentMonth(), streetview: 0, geocode: 0 };
  }

  function emptySessionUsage() {
    return { streetview: 0, geocode: 0 };
  }

  function rolloverIfNeeded() {
    var month = currentMonth();
    if (!usage || usage.month !== month) {
      usage = emptyUsage();
    }
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!dirty) return;
    dirty = false;
    chrome.storage.local.set({ apiUsage: usage, sessionApiUsage: sessionUsage });
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function init() {
    chrome.storage.sync.get(['apiCap', 'apiCapEnabled'], function (s) {
      cap = (typeof s.apiCap === 'number' && s.apiCap >= 0) ? s.apiCap : DEFAULT_CAP;
      capEnabled = s.apiCapEnabled !== false;
    });

    chrome.storage.local.get(['apiUsage', 'sessionApiUsage'], function (l) {
      usage = l.apiUsage || emptyUsage();
      sessionUsage = l.sessionApiUsage || emptySessionUsage();
      rolloverIfNeeded();
      if (pending.streetview || pending.geocode) {
        usage.streetview += pending.streetview;
        usage.geocode += pending.geocode;
        sessionUsage.streetview += pending.streetview;
        sessionUsage.geocode += pending.geocode;
        pending.streetview = 0;
        pending.geocode = 0;
        scheduleFlush();
      }
      loaded = true;
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
      if (area === 'local') {
        if (changes.apiUsage) {
          usage = changes.apiUsage.newValue || emptyUsage();
        }
        if (changes.sessionApiUsage) {
          sessionUsage = changes.sessionApiUsage.newValue || emptySessionUsage();
        }
      }
    });

    // Persist pending counts when the page is hidden / unloaded.
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  function applyIncrement(kind) {
    if (!loaded) {
      // Cap can't be enforced pre-load; in practice this only affects the
      // validation ping at startup, which we always allow anyway.
      pending[kind]++;
      return;
    }
    rolloverIfNeeded();
    usage[kind] = (usage[kind] || 0) + 1;
    sessionUsage[kind] = (sessionUsage[kind] || 0) + 1;
    scheduleFlush();
  }

  function tryStreetView() {
    if (loaded && capEnabled && usage.streetview >= cap) return false;
    applyIncrement('streetview');
    return true;
  }

  function countGeocode() {
    applyIncrement('geocode');
  }

  function getSnapshot() {
    rolloverIfNeeded();
    return {
      month: usage ? usage.month : currentMonth(),
      streetview: usage ? usage.streetview : 0,
      geocode: usage ? usage.geocode : 0,
      sessionStreetview: sessionUsage ? sessionUsage.streetview : 0,
      sessionGeocode: sessionUsage ? sessionUsage.geocode : 0,
      cap: cap,
      capEnabled: capEnabled
    };
  }

  window.RwgpsApiBudget = {
    init: init,
    tryStreetView: tryStreetView,
    countGeocode: countGeocode,
    getSnapshot: getSnapshot
  };
})();
