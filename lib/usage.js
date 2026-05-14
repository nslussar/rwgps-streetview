/**
 * Shared usage helpers for the API request budget.
 *
 * Loaded by:
 *   - background.js (service worker) via importScripts('lib/usage.js')
 *   - popup/popup.js via <script src="../lib/usage.js"> in popup.html
 *
 * Exposes RwgpsUsage on the global. (Not loaded into content scripts — they
 * don't need any of these helpers post-refactor.)
 */
(function () {
  'use strict';

  function currentMonth() {
    var d = new Date();
    var m = d.getMonth() + 1;
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : '' + m);
  }

  function emptyUsage() {
    return { month: currentMonth(), streetviewNetwork: 0, streetviewCached: 0, geocode: 0 };
  }

  function emptySession() {
    return { streetviewNetwork: 0, streetviewCached: 0, geocode: 0 };
  }

  function emptyTabSession() {
    return { network: 0, cached: 0, geocode: 0 };
  }

  // Legacy `streetview` field falls back until migration writes the new fields.
  function readNetwork(u) {
    if (!u) return 0;
    return u.streetviewNetwork !== undefined ? u.streetviewNetwork : (u.streetview || 0);
  }

  // Normalize a stored apiUsage object on SW boot.
  //   - Migrates legacy `streetview` (conflated cache+network) → `streetviewNetwork`
  //     so a user upgrading from the pre-cache-split build keeps their count.
  //   - Fills any missing counter field with 0; without this, a partial object
  //     would yield NaN on subsequent +=, surfacing as a zeroed display.
  //   - Returns `changed:true` only when the object was actually modified, so
  //     the caller can skip the storage write (avoids clobbering concurrent
  //     writes on every boot for the steady-state case).
  function normalizeStoredUsage(u) {
    if (!u) return { usage: emptyUsage(), changed: false };
    var out = Object.assign({}, u);
    var changed = false;
    if (out.streetview !== undefined && out.streetviewNetwork === undefined) {
      out.streetviewNetwork = out.streetview;
      delete out.streetview;
      changed = true;
    } else if (out.streetview !== undefined) {
      // Both fields present (shouldn't happen, but be defensive): drop legacy.
      delete out.streetview;
      changed = true;
    }
    if (typeof out.streetviewNetwork !== 'number') { out.streetviewNetwork = 0; changed = true; }
    if (typeof out.streetviewCached !== 'number') { out.streetviewCached = 0; changed = true; }
    if (typeof out.geocode !== 'number') { out.geocode = 0; changed = true; }
    if (typeof out.month !== 'string' || !out.month) { out.month = currentMonth(); changed = true; }
    return { usage: out, changed: changed };
  }

  var api = {
    DEFAULT_CAP: 10000,
    currentMonth: currentMonth,
    emptyUsage: emptyUsage,
    emptySession: emptySession,
    emptyTabSession: emptyTabSession,
    readNetwork: readNetwork,
    normalizeStoredUsage: normalizeStoredUsage,
    GEOCODE_MSG: 'RWGPS_SV_GEOCODE',
    RESET_MSG: 'RWGPS_SV_RESET',
    PAGE_LOAD_MSG: 'RWGPS_SV_PAGE_LOAD'
  };

  if (typeof self !== 'undefined') self.RwgpsUsage = api;
  if (typeof window !== 'undefined') window.RwgpsUsage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
