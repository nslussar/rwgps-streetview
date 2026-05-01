var lastBadgeText = null;

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

function refreshBadgeFromStorage() {
  chrome.storage.local.get(['sessionApiUsage'], function (l) {
    var n = (l.sessionApiUsage && l.sessionApiUsage.streetview) || 0;
    updateBadge(n);
  });
}

function resetSession() {
  chrome.storage.local.set({ sessionApiUsage: { streetview: 0, geocode: 0 } });
  updateBadge(0);
}

chrome.runtime.onStartup.addListener(resetSession);
chrome.runtime.onInstalled.addListener(resetSession);

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.sessionApiUsage) {
    var n = (changes.sessionApiUsage.newValue && changes.sessionApiUsage.newValue.streetview) || 0;
    updateBadge(n);
  }
});

// Re-sync after every SW wake (badge text doesn't persist across SW restarts).
refreshBadgeFromStorage();
