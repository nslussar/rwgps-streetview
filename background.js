/**
 * Service worker — sole writer for all counter state.
 *
 *   - chrome.webRequest.onCompleted observes Street View Static API requests
 *     and uses `details.fromCache` to split into network (billed) vs cached.
 *   - Geocode increments arrive via chrome.runtime.onMessage from the content
 *     script (the page-bridge geocoder isn't a direct fetch we can observe).
 *   - Popup reset arrives via chrome.runtime.onMessage so the SW can cancel
 *     any pending flush, drop in-flight deltas, and write a fresh baseline
 *     atomically (popup must NOT write apiUsage directly — would race).
 *   - Writes are coalesced via FLUSH_MS so sustained hover doesn't generate
 *     one storage write per request.
 *   - cachedUsage / cachedSession are kept in SW memory, lazy-loaded on first
 *     use, eliminating per-flush storage reads.
 */

importScripts('lib/usage.js');

var FLUSH_MS = 1000;
var STREETVIEW_URL_FILTER = 'https://maps.googleapis.com/maps/api/streetview*';
var STREETVIEW_METADATA_PATH = '/maps/api/streetview/metadata';

var deltas = { network: 0, cached: 0, geocode: 0 };
var flushTimer = null;
var lastBadgeText = null;
var cachedUsage = null;
var cachedSession = null;

function formatBadge(n) {
  if (!n) return '';
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '10k+';
}

function updateBadge(count) {
  var text = formatBadge(count);
  if (text === lastBadgeText) return;
  lastBadgeText = text;
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: '#4285f4' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

function ensureLoaded(cb) {
  if (cachedUsage !== null) { cb(); return; }
  chrome.storage.local.get(['apiUsage', 'sessionApiUsage', 'migrationDone'], function (l) {
    var u = l.apiUsage;
    var s = l.sessionApiUsage;
    var migrated = false;
    // One-time migration of legacy `streetview` field (which conflated cache + network).
    // Treat as worst-case billed so the user isn't surprised by a sudden drop.
    if (!l.migrationDone) {
      if (u && u.streetview !== undefined && u.streetviewNetwork === undefined) {
        u.streetviewNetwork = u.streetview;
        delete u.streetview;
        migrated = true;
      }
      if (s && s.streetview !== undefined && s.streetviewNetwork === undefined) {
        s.streetviewNetwork = s.streetview;
        delete s.streetview;
        migrated = true;
      }
    }
    cachedUsage = u || RwgpsUsage.emptyUsage();
    cachedSession = s || RwgpsUsage.emptySession();
    if (migrated || !l.migrationDone) {
      chrome.storage.local.set({ apiUsage: cachedUsage, sessionApiUsage: cachedSession, migrationDone: true });
    }
    cb();
  });
}

function flush() {
  flushTimer = null;
  if (!deltas.network && !deltas.cached && !deltas.geocode) return;

  ensureLoaded(function () {
    var month = RwgpsUsage.currentMonth();
    if (cachedUsage.month !== month) cachedUsage = RwgpsUsage.emptyUsage();

    cachedUsage.streetviewNetwork += deltas.network;
    cachedUsage.streetviewCached += deltas.cached;
    cachedUsage.geocode += deltas.geocode;

    cachedSession.streetviewNetwork += deltas.network;
    cachedSession.streetviewCached += deltas.cached;
    cachedSession.geocode += deltas.geocode;

    deltas = { network: 0, cached: 0, geocode: 0 };

    chrome.storage.local.set({ apiUsage: cachedUsage, sessionApiUsage: cachedSession });
    updateBadge(cachedSession.streetviewNetwork);
  });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}

function resetSession() {
  cachedSession = RwgpsUsage.emptySession();
  chrome.storage.local.set({ sessionApiUsage: cachedSession });
  updateBadge(0);
}

function resetMonthly() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  deltas = { network: 0, cached: 0, geocode: 0 };
  cachedUsage = RwgpsUsage.emptyUsage();
  chrome.storage.local.set({ apiUsage: cachedUsage });
}

chrome.runtime.onStartup.addListener(resetSession);
chrome.runtime.onInstalled.addListener(resetSession);

chrome.webRequest.onCompleted.addListener(function (details) {
  if (details.url.indexOf(STREETVIEW_METADATA_PATH) !== -1) return;
  if (details.fromCache) deltas.cached++;
  else deltas.network++;
  scheduleFlush();
}, { urls: [STREETVIEW_URL_FILTER] });

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg) return;
  if (msg.type === RwgpsUsage.GEOCODE_MSG) {
    deltas.geocode++;
    scheduleFlush();
  } else if (msg.type === RwgpsUsage.RESET_MSG) {
    resetMonthly();
  }
});

// Re-sync badge after every SW wake (badge text doesn't persist across SW restarts).
ensureLoaded(function () {
  updateBadge(cachedSession.streetviewNetwork);
});
