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

  var api = {
    DEFAULT_CAP: 10000,
    currentMonth: currentMonth,
    emptyUsage: emptyUsage,
    emptySession: emptySession,
    emptyTabSession: emptyTabSession,
    readNetwork: readNetwork,
    GEOCODE_MSG: 'RWGPS_SV_GEOCODE',
    RESET_MSG: 'RWGPS_SV_RESET',
    PAGE_LOAD_MSG: 'RWGPS_SV_PAGE_LOAD',
    SV_CACHE_HIT_MSG: 'RWGPS_SV_CACHE_HIT'
  };

  if (typeof self !== 'undefined') self.RwgpsUsage = api;
  if (typeof window !== 'undefined') window.RwgpsUsage = api;
})();
