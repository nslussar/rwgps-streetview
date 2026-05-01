var DEFAULT_RADIUS = 10;
var DEFAULT_CAP = 10000;

document.addEventListener('DOMContentLoaded', function () {
  const apiKeyInput = document.getElementById('apiKey');
  const enabledInput = document.getElementById('enabled');
  const radiusInput = document.getElementById('radius');
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
    cap: DEFAULT_CAP,
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

  function applySession(s) {
    state.sessionSv = RwgpsUsage.readNetwork(s);
    state.sessionSvCached = (s && s.streetviewCached) || 0;
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

  chrome.storage.sync.get(['apiKey', 'enabled', 'radius', 'apiCap', 'apiCapEnabled'], function (result) {
    apiKeyInput.value = result.apiKey || '';
    enabledInput.checked = result.enabled !== false;
    radiusInput.value = result.radius || DEFAULT_RADIUS;
    state.cap = (typeof result.apiCap === 'number' && result.apiCap >= 0) ? result.apiCap : DEFAULT_CAP;
    state.capEnabled = result.apiCapEnabled !== false;
    apiCapInput.value = state.cap;
    apiCapEnabledInput.checked = state.capEnabled;
    render();
  });

  chrome.storage.local.get(['apiUsage', 'sessionApiUsage'], function (result) {
    applyMonthly(result.apiUsage);
    applySession(result.sessionApiUsage);
    render();
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
        state.cap = (typeof v === 'number' && v >= 0) ? v : DEFAULT_CAP;
        changed = true;
      }
      if (changes.apiCapEnabled) {
        state.capEnabled = changes.apiCapEnabled.newValue !== false;
        apiCapEnabledInput.checked = state.capEnabled;
        changed = true;
      }
    }
    if (area === 'local') {
      if (changes.apiUsage) {
        applyMonthly(changes.apiUsage.newValue);
        changed = true;
      }
      if (changes.sessionApiUsage) {
        applySession(changes.sessionApiUsage.newValue);
        changed = true;
      }
    }
    if (changed) render();
  });
});
