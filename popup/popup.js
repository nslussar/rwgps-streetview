var DEFAULT_RADIUS = 10;
var DEFAULT_BUCKET_METERS = 10;
var DEFAULT_SKIP_THRESHOLD_METERS = 10;
var DEFAULT_DWELL_MS = 200;
var RATE_LIMIT_WINDOW_MS = 60 * 1000;

var STATE = {
  FIRSTRUN: 'firstrun',
  INVALIDKEY: 'invalidkey',
  OVERQUOTA: 'overquota',
  ACTIVE: 'active'
};

document.addEventListener('DOMContentLoaded', function () {
  function $(id) { return document.getElementById(id); }

  var bodyMain = document.querySelector('.body-main');
  var bodyFirst = document.querySelector('.body-firstrun');
  var statusDot = document.querySelector('.header .status-dot');

  var apiKeyOnboardInput = $('apiKeyOnboard');
  var apiKeySaveBtn = $('apiKeySaveBtn');
  var howToToggle = $('howToToggle');
  var howToList = $('howToList');

  var invalidBlock = $('invalidKeyBlock');
  var dimmable = $('dimmable');
  var replaceKeyBtn = $('replaceKeyBtn');

  var usageMonthEl = $('usageMonth');
  var usageSvEl = $('usageSv');
  var usageCapDisplayEl = $('usageCapDisplay');
  var usageBarFill = $('usageBarFill');
  var usageScaleMaxEl = $('usageScaleMax');
  var usageSvCachedEl = $('usageSvCached');
  var usageGeoEl = $('usageGeo');
  var overCapLabel = $('overCapLabel');
  var overQuotaNotice = $('overQuotaNotice');
  var rateLimitNotice = $('rateLimitNotice');
  var nextResetDateEl = $('nextResetDate');
  var activePagePill = $('activePagePill');
  var sessionSvEl = $('sessionSv');
  var sessionSvCachedEl = $('sessionSvCached');
  var sessionGeoEl = $('sessionGeo');

  var resetBtn = $('resetUsage');
  var apiCapInput = $('apiCap');
  var apiCapEnabledInput = $('apiCapEnabled');
  var advToggle = $('advToggle');
  var advancedGrid = $('advanced');

  var radiusInput = $('radius');
  var bucketMetersInput = $('bucketMeters');
  var skipThresholdMetersInput = $('skipThresholdMeters');
  var dwellMsInput = $('dwellMs');

  var keyToggle = $('keyToggle');
  var keyField = $('keyField');
  var apiKeyInput = $('apiKey');
  var keyEye = $('keyEye');
  var keyEyeIcon = $('keyEyeIcon');
  var keyDelete = $('keyDelete');
  var apiKeyOnboardEye = $('apiKeyOnboardEye');
  var apiKeyOnboardEyeIcon = $('apiKeyOnboardEyeIcon');

  var manifest = chrome.runtime.getManifest();
  $('version').textContent = manifest.version === '0.0.0' ? '(dev)' : 'v' + manifest.version;

  var state = {
    apiKey: '',
    apiKeyInvalid: false,
    monthSv: 0,
    monthSvCached: 0,
    monthGeo: 0,
    sessionSv: 0,
    sessionSvCached: 0,
    sessionGeo: 0,
    cap: RwgpsUsage.DEFAULT_CAP,
    capEnabled: true,
    rateLimitedAt: 0
  };
  var activeTabId = null;

  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function numOr(v, fallback) { return (typeof v === 'number' && v >= 0) ? v : fallback; }

  function currentMonthLabel() {
    return new Date().toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }
  function nextResetLabel() {
    var d = new Date();
    var nm = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return nm.toLocaleString(undefined, { month: 'long', day: 'numeric' });
  }

  function decideState() {
    if (!state.apiKey) return STATE.FIRSTRUN;
    if (state.apiKeyInvalid) return STATE.INVALIDKEY;
    if (state.capEnabled && state.monthSv >= state.cap) return STATE.OVERQUOTA;
    return STATE.ACTIVE;
  }

  function setStatusDot(s) {
    statusDot.classList.remove('status-dot-ok', 'status-dot-warn', 'status-dot-danger');
    if (s === STATE.FIRSTRUN) statusDot.classList.add('status-dot-warn');
    else if (s === STATE.INVALIDKEY) statusDot.classList.add('status-dot-danger');
    else statusDot.classList.add('status-dot-ok');
  }

  function render() {
    var s = decideState();
    setStatusDot(s);
    bodyFirst.hidden = s !== STATE.FIRSTRUN;
    bodyMain.hidden = s === STATE.FIRSTRUN;

    if (s === STATE.FIRSTRUN) {
      apiKeyOnboardInput.focus();
      return;
    }

    invalidBlock.hidden = s !== STATE.INVALIDKEY;
    dimmable.classList.toggle('dimmed', s === STATE.INVALIDKEY);

    usageMonthEl.textContent = 'Usage · ' + currentMonthLabel();
    usageSvEl.textContent = fmt(state.monthSv);
    usageCapDisplayEl.textContent = fmt(state.cap);
    usageScaleMaxEl.textContent = state.cap >= 1000
      ? Math.round(state.cap / 1000) + 'k'
      : String(state.cap);

    var pct = state.cap > 0 ? Math.min(100, (state.monthSv / state.cap) * 100) : 0;
    usageBarFill.style.width = pct + '%';

    var ratio = state.cap > 0 ? state.monthSv / state.cap : 0;
    var isOver = s === STATE.OVERQUOTA;
    var isWarn = !isOver && ratio > 0.9;
    usageSvEl.classList.toggle('hero-used-warn', isWarn);
    usageSvEl.classList.toggle('hero-used-danger', isOver);
    usageBarFill.classList.toggle('hero-bar-warn', isWarn);
    usageBarFill.classList.toggle('hero-bar-danger', isOver);

    overCapLabel.hidden = !isOver;

    usageSvCachedEl.textContent = fmt(state.monthSvCached);
    usageGeoEl.textContent = fmt(state.monthGeo);

    overQuotaNotice.hidden = !isOver;
    if (isOver) nextResetDateEl.textContent = nextResetLabel();

    var rateLimited = !!state.rateLimitedAt &&
      (Date.now() - state.rateLimitedAt) < RATE_LIMIT_WINDOW_MS;
    rateLimitNotice.hidden = isOver || !rateLimited;

    activePagePill.hidden = s !== STATE.ACTIVE || rateLimited;
    sessionSvEl.textContent = fmt(state.sessionSv);
    sessionSvCachedEl.textContent = fmt(state.sessionSvCached);
    sessionGeoEl.textContent = fmt(state.sessionGeo);
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

  // Coalesce three independent storage reads into one initial render.
  var pendingReads = 3;
  function initialReadDone() { if (--pendingReads === 0) render(); }

  chrome.storage.sync.get(
    ['apiKey', 'radius', 'apiCap', 'apiCapEnabled',
     'bucketMeters', 'skipThresholdMeters', 'dwellMs'],
    function (result) {
      state.apiKey = result.apiKey || '';
      apiKeyOnboardInput.value = state.apiKey;
      apiKeyInput.value = state.apiKey;
      radiusInput.value = result.radius || DEFAULT_RADIUS;
      bucketMetersInput.value = numOr(result.bucketMeters, DEFAULT_BUCKET_METERS);
      skipThresholdMetersInput.value = numOr(result.skipThresholdMeters, DEFAULT_SKIP_THRESHOLD_METERS);
      dwellMsInput.value = numOr(result.dwellMs, DEFAULT_DWELL_MS);
      state.cap = numOr(result.apiCap, RwgpsUsage.DEFAULT_CAP);
      state.capEnabled = result.apiCapEnabled !== false;
      apiCapInput.value = state.cap;
      apiCapEnabledInput.checked = state.capEnabled;
      initialReadDone();
    }
  );

  chrome.storage.local.get(['apiUsage', 'apiKeyInvalid', 'rateLimitedAt'], function (result) {
    applyMonthly(result.apiUsage);
    state.apiKeyInvalid = !!result.apiKeyInvalid;
    state.rateLimitedAt = result.rateLimitedAt || 0;
    initialReadDone();
  });

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    activeTabId = (tabs[0] && tabs[0].id) || null;
    chrome.storage.session.get(['sessionByTab'], function (result) {
      var byTab = result.sessionByTab || {};
      applyTabSession(activeTabId != null ? byTab[activeTabId] : null);
      initialReadDone();
    });
  });

  function debounce(fn, ms) {
    var t = null, lastArg;
    function debounced(arg) {
      lastArg = arg;
      clearTimeout(t);
      t = setTimeout(function () { t = null; fn(lastArg); }, ms);
    }
    debounced.flush = function () {
      if (t === null) return;
      clearTimeout(t);
      t = null;
      fn(lastArg);
    };
    return debounced;
  }

  function saveApiKey(value) {
    var trimmed = (value || '').trim();
    state.apiKey = trimmed;
    chrome.storage.sync.set({ apiKey: trimmed });
  }
  var debouncedSaveKey = debounce(saveApiKey, 400);

  apiKeyInput.addEventListener('input', function () { debouncedSaveKey(apiKeyInput.value); });
  apiKeyInput.addEventListener('blur', function () { debouncedSaveKey.flush(); });

  apiKeySaveBtn.addEventListener('click', function () {
    saveApiKey(apiKeyOnboardInput.value);
  });
  apiKeyOnboardInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') saveApiKey(apiKeyOnboardInput.value);
  });

  function bindEyeToggle(btn, icon, input) {
    btn.addEventListener('click', function () {
      var hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      icon.src = hidden ? '../icons/eye-show.png' : '../icons/eye-hide.png';
      btn.title = hidden ? 'Hide API key' : 'Show API key';
    });
  }
  bindEyeToggle(keyEye, keyEyeIcon, apiKeyInput);
  bindEyeToggle(apiKeyOnboardEye, apiKeyOnboardEyeIcon, apiKeyOnboardInput);

  function bindDisclosure(btn, panel, group) {
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
      if (!open && group) {
        group.forEach(function (other) {
          if (other.btn !== btn) {
            other.btn.setAttribute('aria-expanded', 'false');
            other.panel.hidden = true;
          }
        });
      }
    });
  }
  var bodyGroup = [
    { btn: advToggle, panel: advancedGrid },
    { btn: keyToggle, panel: keyField }
  ];
  bindDisclosure(advToggle, advancedGrid, bodyGroup);
  bindDisclosure(keyToggle, keyField, bodyGroup);
  bindDisclosure(howToToggle, howToList);

  replaceKeyBtn.addEventListener('click', function () {
    chrome.storage.sync.set({ apiKey: '' });
    chrome.storage.local.remove(['apiKeyInvalid']);
    apiKeyOnboardInput.focus();
  });

  keyDelete.addEventListener('click', function () {
    apiKeyInput.value = '';
    chrome.storage.sync.set({ apiKey: '' });
    chrome.storage.local.remove(['apiKeyInvalid']);
  });

  resetBtn.addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: RwgpsUsage.RESET_MSG });
  });

  apiCapEnabledInput.addEventListener('change', function () {
    chrome.storage.sync.set({ apiCapEnabled: apiCapEnabledInput.checked });
  });

  function bindNumberSave(input, key, validator) {
    var save = debounce(function (val) {
      var patch = {}; patch[key] = val;
      chrome.storage.sync.set(patch);
    }, 400);
    input.addEventListener('input', function () {
      var val = parseInt(input.value, 10);
      if (!isNaN(val) && validator(val)) save(val);
    });
  }
  bindNumberSave(apiCapInput, 'apiCap', function (v) { return v >= 0; });
  bindNumberSave(radiusInput, 'radius', function (v) { return v > 0 && v <= 100; });
  bindNumberSave(bucketMetersInput, 'bucketMeters', function (v) { return v >= 0 && v <= 100; });
  bindNumberSave(skipThresholdMetersInput, 'skipThresholdMeters', function (v) { return v >= 0 && v <= 200; });
  bindNumberSave(dwellMsInput, 'dwellMs', function (v) { return v >= 0 && v <= 1000; });

  // Mirror an external storage change into a focused-aware input.
  function syncInputValue(input, value) {
    if (document.activeElement !== input) input.value = value;
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    var changed = false;
    if (area === 'sync') {
      if (changes.apiKey) {
        state.apiKey = changes.apiKey.newValue || '';
        syncInputValue(apiKeyOnboardInput, state.apiKey);
        syncInputValue(apiKeyInput, state.apiKey);
        changed = true;
      }
      if (changes.apiCap) {
        state.cap = numOr(changes.apiCap.newValue, RwgpsUsage.DEFAULT_CAP);
        syncInputValue(apiCapInput, state.cap);
        changed = true;
      }
      if (changes.apiCapEnabled) {
        state.capEnabled = changes.apiCapEnabled.newValue !== false;
        apiCapEnabledInput.checked = state.capEnabled;
        changed = true;
      }
      if (changes.bucketMeters) syncInputValue(bucketMetersInput, numOr(changes.bucketMeters.newValue, DEFAULT_BUCKET_METERS));
      if (changes.skipThresholdMeters) syncInputValue(skipThresholdMetersInput, numOr(changes.skipThresholdMeters.newValue, DEFAULT_SKIP_THRESHOLD_METERS));
      if (changes.dwellMs) syncInputValue(dwellMsInput, numOr(changes.dwellMs.newValue, DEFAULT_DWELL_MS));
      if (changes.radius) syncInputValue(radiusInput, changes.radius.newValue || DEFAULT_RADIUS);
    }
    if (area === 'local') {
      if (changes.apiUsage) { applyMonthly(changes.apiUsage.newValue); changed = true; }
      if (changes.apiKeyInvalid) { state.apiKeyInvalid = !!changes.apiKeyInvalid.newValue; changed = true; }
      if (changes.rateLimitedAt) { state.rateLimitedAt = changes.rateLimitedAt.newValue || 0; changed = true; }
    }
    if (area === 'session' && changes.sessionByTab && activeTabId != null) {
      var byTab = changes.sessionByTab.newValue || {};
      applyTabSession(byTab[activeTabId]);
      changed = true;
    }
    if (changed) render();
  });
});
