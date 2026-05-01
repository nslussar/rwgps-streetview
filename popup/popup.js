var DEFAULT_RADIUS = 10;
var DEFAULT_BUCKET_METERS = 10;
var DEFAULT_SKIP_THRESHOLD_METERS = 10;
var DEFAULT_DWELL_MS = 200;

document.addEventListener('DOMContentLoaded', function () {
  const apiKeyInput = document.getElementById('apiKey');
  const enabledInput = document.getElementById('enabled');
  const radiusInput = document.getElementById('radius');
  const bucketMetersInput = document.getElementById('bucketMeters');
  const skipThresholdMetersInput = document.getElementById('skipThresholdMeters');
  const dwellMsInput = document.getElementById('dwellMs');
  const apiCapInput = document.getElementById('apiCap');
  const apiCapEnabledInput = document.getElementById('apiCapEnabled');
  const resetBtn = document.getElementById('resetUsage');
  const usageField = document.querySelector('.usage-field');
  const usageMonthEl = document.getElementById('usageMonth');
  const usageSvEl = document.getElementById('usageSv');
  const usageSvCachedEl = document.getElementById('usageSvCached');
  const usageGeoEl = document.getElementById('usageGeo');
  const usageCapDisplayEl = document.getElementById('usageCapDisplay');
  const sessionSvEl = document.getElementById('sessionSv');
  const sessionSvCachedEl = document.getElementById('sessionSvCached');
  const sessionGeoEl = document.getElementById('sessionGeo');

  var manifest = chrome.runtime.getManifest();
  var version = manifest.version === '0.0.0' ? '(dev build)' : 'v' + manifest.version;
  document.getElementById('version').textContent = version;

  var state = {
    monthSv: 0,
    monthSvCached: 0,
    monthGeo: 0,
    sessionSv: 0,
    sessionSvCached: 0,
    sessionGeo: 0,
    cap: RwgpsUsage.DEFAULT_CAP,
    capEnabled: true
  };

  function currentMonthLabel() {
    return new Date().toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString();
  }

  function applyMonthly(u) {
    if (u && u.month === RwgpsUsage.currentMonth()) {
      state.monthSv = RwgpsUsage.readNetwork(u);
      state.monthSvCached = u.streetviewCached || 0;
      state.monthGeo = u.geocode || 0;
    } else {
      state.monthSv = 0;
      state.monthSvCached = 0;
      state.monthGeo = 0;
    }
  }

  function applyTabSession(s) {
    state.sessionSv = (s && s.network) || 0;
    state.sessionSvCached = (s && s.cached) || 0;
    state.sessionGeo = (s && s.geocode) || 0;
  }

  function render() {
    usageMonthEl.textContent = currentMonthLabel();
    usageSvEl.textContent = fmt(state.monthSv);
    usageSvCachedEl.textContent = fmt(state.monthSvCached);
    usageGeoEl.textContent = fmt(state.monthGeo);
    usageCapDisplayEl.textContent = fmt(state.cap);
    sessionSvEl.textContent = fmt(state.sessionSv);
    sessionSvCachedEl.textContent = fmt(state.sessionSvCached);
    sessionGeoEl.textContent = fmt(state.sessionGeo);
    if (state.capEnabled && state.monthSv >= state.cap) {
      usageField.classList.add('over-cap');
    } else {
      usageField.classList.remove('over-cap');
    }
  }

  function numOr(v, fallback) {
    return (typeof v === 'number' && v >= 0) ? v : fallback;
  }

  chrome.storage.sync.get(
    ['apiKey', 'enabled', 'radius', 'apiCap', 'apiCapEnabled',
     'bucketMeters', 'skipThresholdMeters', 'dwellMs'],
    function (result) {
      apiKeyInput.value = result.apiKey || '';
      enabledInput.checked = result.enabled !== false;
      radiusInput.value = result.radius || DEFAULT_RADIUS;
      bucketMetersInput.value = numOr(result.bucketMeters, DEFAULT_BUCKET_METERS);
      skipThresholdMetersInput.value = numOr(result.skipThresholdMeters, DEFAULT_SKIP_THRESHOLD_METERS);
      dwellMsInput.value = numOr(result.dwellMs, DEFAULT_DWELL_MS);
      state.cap = numOr(result.apiCap, RwgpsUsage.DEFAULT_CAP);
      state.capEnabled = result.apiCapEnabled !== false;
      apiCapInput.value = state.cap;
      apiCapEnabledInput.checked = state.capEnabled;
      render();
    }
  );

  chrome.storage.local.get(['apiUsage'], function (result) {
    applyMonthly(result.apiUsage);
    render();
  });

  // Look up the active tab's session counter (per page-load, per tab).
  var activeTabId = null;
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    activeTabId = (tabs[0] && tabs[0].id) || null;
    chrome.storage.session.get(['sessionByTab'], function (result) {
      var byTab = result.sessionByTab || {};
      applyTabSession(activeTabId != null ? byTab[activeTabId] : null);
      render();
    });
  });

  var toggleBtn = document.getElementById('toggleKey');
  var eyeIcon = document.getElementById('eyeIcon');
  toggleBtn.addEventListener('click', function () {
    var hidden = apiKeyInput.type === 'password';
    apiKeyInput.type = hidden ? 'text' : 'password';
    eyeIcon.src = hidden ? '../icons/eye-show.png' : '../icons/eye-hide.png';
  });

  var saveTimer = null;
  apiKeyInput.addEventListener('input', function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      chrome.storage.sync.set({ apiKey: apiKeyInput.value.trim() });
    }, 400);
  });

  enabledInput.addEventListener('change', function () {
    chrome.storage.sync.set({ enabled: enabledInput.checked });
  });

  var radiusSaveTimer = null;
  radiusInput.addEventListener('input', function () {
    clearTimeout(radiusSaveTimer);
    radiusSaveTimer = setTimeout(function () {
      var val = parseInt(radiusInput.value, 10);
      if (val > 0) chrome.storage.sync.set({ radius: val });
    }, 400);
  });

  function debouncedNumberSave(input, key, validator) {
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var val = parseInt(input.value, 10);
        if (!isNaN(val) && validator(val)) {
          var patch = {}; patch[key] = val;
          chrome.storage.sync.set(patch);
        }
      }, 400);
    });
  }
  debouncedNumberSave(bucketMetersInput, 'bucketMeters', function (v) { return v >= 0 && v <= 100; });
  debouncedNumberSave(skipThresholdMetersInput, 'skipThresholdMeters', function (v) { return v >= 0 && v <= 200; });
  debouncedNumberSave(dwellMsInput, 'dwellMs', function (v) { return v >= 0 && v <= 1000; });

  var capSaveTimer = null;
  apiCapInput.addEventListener('input', function () {
    clearTimeout(capSaveTimer);
    capSaveTimer = setTimeout(function () {
      var val = parseInt(apiCapInput.value, 10);
      if (!isNaN(val) && val >= 0) chrome.storage.sync.set({ apiCap: val });
    }, 400);
  });

  apiCapEnabledInput.addEventListener('change', function () {
    chrome.storage.sync.set({ apiCapEnabled: apiCapEnabledInput.checked });
  });

  // Route reset through the SW so it can cancel pending flushes and drop
  // in-flight deltas atomically — popup writing apiUsage directly would race.
  resetBtn.addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: RwgpsUsage.RESET_MSG });
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    var changed = false;
    if (area === 'sync') {
      if (changes.apiCap) {
        var v = changes.apiCap.newValue;
        state.cap = (typeof v === 'number' && v >= 0) ? v : RwgpsUsage.DEFAULT_CAP;
        changed = true;
      }
      if (changes.apiCapEnabled) {
        state.capEnabled = changes.apiCapEnabled.newValue !== false;
        apiCapEnabledInput.checked = state.capEnabled;
        changed = true;
      }
      if (changes.bucketMeters) {
        bucketMetersInput.value = numOr(changes.bucketMeters.newValue, DEFAULT_BUCKET_METERS);
      }
      if (changes.skipThresholdMeters) {
        skipThresholdMetersInput.value = numOr(changes.skipThresholdMeters.newValue, DEFAULT_SKIP_THRESHOLD_METERS);
      }
      if (changes.dwellMs) {
        dwellMsInput.value = numOr(changes.dwellMs.newValue, DEFAULT_DWELL_MS);
      }
    }
    if (area === 'local' && changes.apiUsage) {
      applyMonthly(changes.apiUsage.newValue);
      changed = true;
    }
    if (area === 'session' && changes.sessionByTab && activeTabId != null) {
      var byTab = changes.sessionByTab.newValue || {};
      applyTabSession(byTab[activeTabId]);
      changed = true;
    }
    if (changed) render();
  });
});
