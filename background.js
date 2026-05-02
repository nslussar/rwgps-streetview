/**
 * Service worker — sole writer for all counter state.
 *
 *   - chrome.webRequest.onCompleted observes Street View Static API requests
 *     and uses `details.fromCache` to split into network (billed) vs cached.
 *   - Geocode increments arrive via chrome.runtime.onMessage from the content
 *     script (the page-bridge geocoder isn't a direct fetch we can observe).
 *   - Popup reset arrives via chrome.runtime.onMessage so the SW can cancel
 *     any pending flush, drop in-flight deltas, and write a fresh baseline
 *     atomically.
 *
 * Two scopes:
 *   - Monthly counter (apiUsage in chrome.storage.local) — global, persistent,
 *     gates the cap. Single source of truth for billing protection.
 *   - Per-tab session counter (sessionByTab in chrome.storage.session) — keyed
 *     by tabId, reset per page load, per-tab toolbar badge. Cleared on
 *     browser restart (storage.session is in-memory) and on tab close.
 */

importScripts('lib/usage.js');

var FLUSH_MS = 1000;
var STREETVIEW_URL_FILTER = 'https://maps.googleapis.com/maps/api/streetview*';
var STREETVIEW_METADATA_PATH = '/maps/api/streetview/metadata';
var BADGE_BG = '#4285f4';
var BADGE_FG = '#ffffff';

var perTabDeltas = {}; // { [tabId]: { network, cached, geocode } }
var flushTimer = null;
var cachedUsage = null;     // monthly (chrome.storage.local)
var sessionByTab = null;    // per-tab (chrome.storage.session)
var lastBadgeText = {};     // { [tabId]: lastText } — dedupe per-tab

function formatBadge(n) {
  if (!n) return '';
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '10k+';
}

function updateTabBadge(tabId) {
  var s = sessionByTab && sessionByTab[tabId];
  var text = formatBadge((s && s.network) || 0);
  if (lastBadgeText[tabId] === text) return;
  lastBadgeText[tabId] = text;
  chrome.action.setBadgeText({ tabId: tabId, text: text });
  if (text) {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: BADGE_BG });
    chrome.action.setBadgeTextColor({ tabId: tabId, color: BADGE_FG });
  }
}

function ensureLoaded(cb) {
  if (cachedUsage !== null && sessionByTab !== null) { cb(); return; }
  var pending = 2;
  function done() { if (--pending === 0) cb(); }

  chrome.storage.local.get(['apiUsage', 'sessionApiUsage', 'migrationDone'], function (l) {
    var u = l.apiUsage;
    var migrated = false;
    // One-time migration of legacy `streetview` field (which conflated cache + network).
    // Treat as worst-case billed so the user isn't surprised by a sudden drop.
    if (!l.migrationDone) {
      if (u && u.streetview !== undefined && u.streetviewNetwork === undefined) {
        u.streetviewNetwork = u.streetview;
        delete u.streetview;
        migrated = true;
      }
    }
    cachedUsage = u || RwgpsUsage.emptyUsage();
    if (migrated || !l.migrationDone) {
      // Drop the legacy global sessionApiUsage too while we're at it.
      chrome.storage.local.set({ apiUsage: cachedUsage, migrationDone: true });
      chrome.storage.local.remove('sessionApiUsage');
    }
    done();
  });

  chrome.storage.session.get(['sessionByTab'], function (s) {
    sessionByTab = s.sessionByTab || {};
    done();
  });
}

function flush() {
  flushTimer = null;
  var tabIds = Object.keys(perTabDeltas);
  if (tabIds.length === 0) return;

  ensureLoaded(function () {
    var month = RwgpsUsage.currentMonth();
    if (cachedUsage.month !== month) cachedUsage = RwgpsUsage.emptyUsage();

    var totalN = 0, totalC = 0, totalG = 0;
    for (var i = 0; i < tabIds.length; i++) {
      var tabId = tabIds[i];
      var d = perTabDeltas[tabId];
      totalN += d.network; totalC += d.cached; totalG += d.geocode;
      var entry = sessionByTab[tabId] || RwgpsUsage.emptyTabSession();
      entry.network += d.network;
      entry.cached += d.cached;
      entry.geocode += d.geocode;
      sessionByTab[tabId] = entry;
    }
    perTabDeltas = {};

    cachedUsage.streetviewNetwork += totalN;
    cachedUsage.streetviewCached += totalC;
    cachedUsage.geocode += totalG;

    chrome.storage.local.set({ apiUsage: cachedUsage });
    chrome.storage.session.set({ sessionByTab: sessionByTab });

    for (var j = 0; j < tabIds.length; j++) {
      updateTabBadge(parseInt(tabIds[j], 10));
    }
  });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}

function recordIncrement(tabId, kind) {
  if (tabId == null || tabId < 0) return;
  if (!perTabDeltas[tabId]) perTabDeltas[tabId] = { network: 0, cached: 0, geocode: 0 };
  perTabDeltas[tabId][kind]++;
  scheduleFlush();
}

function resetTab(tabId) {
  ensureLoaded(function () {
    sessionByTab[tabId] = RwgpsUsage.emptyTabSession();
    delete perTabDeltas[tabId];
    chrome.storage.session.set({ sessionByTab: sessionByTab });
    updateTabBadge(tabId);
  });
}

function resetAllSessions() {
  // We deliberately don't touch cachedUsage — monthly counter is independent
  // of session state. ensureLoaded() still triggers a local read on first
  // use because cachedUsage stays null here.
  sessionByTab = {};
  perTabDeltas = {};
  lastBadgeText = {};
  chrome.storage.session.set({ sessionByTab: {} });
  // Per-tab badges clear automatically when tabs close; live tabs will re-badge on next request.
}

function resetMonthly() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  perTabDeltas = {};
  ensureLoaded(function () {
    cachedUsage = RwgpsUsage.emptyUsage();
    chrome.storage.local.set({ apiUsage: cachedUsage });
  });
}

chrome.runtime.onStartup.addListener(resetAllSessions);
chrome.runtime.onInstalled.addListener(resetAllSessions);

chrome.tabs.onRemoved.addListener(function (tabId) {
  delete perTabDeltas[tabId];
  delete lastBadgeText[tabId];
  if (sessionByTab && sessionByTab[tabId] !== undefined) {
    delete sessionByTab[tabId];
    chrome.storage.session.set({ sessionByTab: sessionByTab });
  }
});

// `&return_error_code=true` is set on every SV URL by the content script,
// so Google returns 403 REQUEST_DENIED / 429 OVER_QUERY_LIMIT directly.
var HTTP_FORBIDDEN = 403;
var HTTP_TOO_MANY_REQUESTS = 429;
var RATE_LIMIT_WRITE_GAP_MS = 5000;
var apiKeyInvalid = null;   // tri-state: null = unknown, avoids spurious remove on first 2xx after SW wake
var rateLimitedLastWrite = 0;

chrome.webRequest.onCompleted.addListener(function (details) {
  if (details.url.indexOf(STREETVIEW_METADATA_PATH) !== -1) return;
  recordIncrement(details.tabId, details.fromCache ? 'cached' : 'network');

  // Cache hits already counted; statusCode is from Google but the request never reached them.
  if (details.fromCache) return;
  var sc = details.statusCode;
  if (sc === HTTP_FORBIDDEN) {
    if (apiKeyInvalid !== true) {
      apiKeyInvalid = true;
      chrome.storage.local.set({ apiKeyInvalid: true });
    }
  } else if (sc >= 200 && sc < 300) {
    if (apiKeyInvalid !== false) {
      apiKeyInvalid = false;
      chrome.storage.local.remove('apiKeyInvalid');
    }
  }
  if (sc === HTTP_TOO_MANY_REQUESTS) {
    var now = Date.now();
    if (now - rateLimitedLastWrite > RATE_LIMIT_WRITE_GAP_MS) {
      rateLimitedLastWrite = now;
      chrome.storage.local.set({ rateLimitedAt: now });
    }
  }
}, { urls: [STREETVIEW_URL_FILTER] });

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg) return;
  var tabId = (sender && sender.tab) ? sender.tab.id : null;
  if (msg.type === RwgpsUsage.GEOCODE_MSG) {
    recordIncrement(tabId, 'geocode');
  } else if (msg.type === RwgpsUsage.PAGE_LOAD_MSG) {
    if (tabId != null) resetTab(tabId);
  } else if (msg.type === RwgpsUsage.RESET_MSG) {
    resetMonthly();
  }
});
