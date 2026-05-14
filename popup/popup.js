var DEFAULT_RADIUS = 10;
var DEFAULT_BUCKET_METERS = 10;
var DEFAULT_SKIP_THRESHOLD_METERS = 10;
var DEFAULT_DWELL_MS = 200;
var DEFAULT_VIEWPORT_W = 400;
var DEFAULT_VIEWPORT_H = 250;
var DEFAULT_TILE_PX = 200;
var DEFAULT_HORIZON_NUDGE_PX = 0;
var RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Which collapsible is open in the body. At most one at a time —
// opening any of these closes the others. Two sections in v5e: the
// "Google Maps API" disclosure (`usage`) folds in cap + key, and Advanced.
var SECTIONS = ['usage', 'advanced'];

document.addEventListener('DOMContentLoaded', function () {
  function $(id) { return document.getElementById(id); }

  // Header
  var previewToggleBtn = $('previewToggle');
  var versionEl = $('version');

  // Body wrapper that dims when the preview is disabled
  var bodyDimmable = $('bodyDimmable');

  // Mode picker (vertical radio cards). The descriptive text lives inside
  // each card; there's no separate first-run hint element anymore.
  var modeExperimentalBtn = $('modeExperimental');
  var modeApiKeyBtn = $('modeApiKey');

  // Bodies
  var bodyExperimental = $('bodyExperimental');
  var bodyApiKey = $('bodyApiKey');

  // API-key onboarding (firstrun + apikey)
  var apiKeyOnboardingEl = $('apiKeyOnboarding');
  var apiKeyOnboardInput = $('apiKeyOnboard');
  var apiKeySaveBtn = $('apiKeySaveBtn');
  var howToToggle = $('howToToggle');
  var howToList = $('howToList');
  var apiKeyOnboardEye = $('apiKeyOnboardEye');
  var apiKeyOnboardEyeIcon = $('apiKeyOnboardEyeIcon');

  // Invalid-key block
  var invalidBlock = $('invalidKeyBlock');
  var replaceKeyBtn = $('replaceKeyBtn');

  // Usage disclosure
  var usageSection = $('usageSection');
  var usageToggle = $('usageToggle');
  var usagePanel = $('usagePanel');
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
  var setBtn = $('setUsage');
  var usageEyebrow = $('usageEyebrow');
  var usageSetRow = $('usageSetRow');
  var usageSetInput = $('usageSetInput');
  var usageSetSave = $('usageSetSave');
  var usageSetCancel = $('usageSetCancel');

  // Cap row (now lives inside the Google Maps API disclosure panel)
  var apiCapInput = $('apiCap');
  var apiCapEnabledInput = $('apiCapEnabled');

  // Advanced
  var advToggle = $('advToggle');
  var advancedPanel = $('advanced');
  var advResetAll = $('advResetAll');
  var advResetAllBtn = $('advResetAllBtn');
  var radiusInput = $('radius');
  var bucketMetersInput = $('bucketMeters');
  var skipThresholdMetersInput = $('skipThresholdMeters');
  var dwellMsInput = $('dwellMs');
  var verboseDebugInput = $('verboseDebug');
  var viewportWInput = $('viewportW');
  var viewportHInput = $('viewportH');
  var tilePxInput = $('tilePx');
  var horizonNudgePxInput = $('horizonNudgePx');

  // API key field — now lives inside the "Google Maps API" disclosure
  // panel rather than its own collapsible section.
  var apiKeyInput = $('apiKey');
  var keyEye = $('keyEye');
  var keyEyeIcon = $('keyEyeIcon');

  var manifest = chrome.runtime.getManifest();
  versionEl.textContent = manifest.version === '0.0.0' ? '(dev)' : 'v' + manifest.version;

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
    rateLimitedAt: 0,
    mode: 'experimental',       // 'apikey' | 'experimental' — backs useExperimentalPreview (default experimental for new users; switches to apikey if a key is already set)
    previewEnabled: true,       // header switch
    openSection: 'usage'        // null | 'usage' | 'advanced'
  };
  var activeTabId = null;
  var previewMode = null; // 'editor' | 'viewer' | null (content-script reachability)

  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function numOr(v, fallback) { return (typeof v === 'number' && v >= 0) ? v : fallback; }
  function numOrSigned(v, fallback) { return (typeof v === 'number' && isFinite(v)) ? v : fallback; }

  function currentMonthLabel() {
    return new Date().toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }
  function nextResetLabel() {
    var d = new Date();
    var nm = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return nm.toLocaleString(undefined, { month: 'long', day: 'numeric' });
  }

  function isFirstRun() {
    // First run = the user hasn't configured an API key yet. In experimental
    // mode this is also "first run" in the sense that we still want to show
    // the explanatory hint at the top.
    return !state.apiKey;
  }
  function isInvalidKey() {
    return state.mode === 'apikey' && !!state.apiKey && state.apiKeyInvalid;
  }
  function isOverQuota() {
    return state.mode === 'apikey' && !!state.apiKey && !state.apiKeyInvalid
      && state.capEnabled && state.monthSv >= state.cap;
  }

  function setSectionOpen(id) {
    state.openSection = id;
    var open = { usage: id === 'usage', advanced: id === 'advanced' };
    usageToggle.setAttribute('aria-expanded', open.usage ? 'true' : 'false');
    advToggle.setAttribute('aria-expanded', open.advanced ? 'true' : 'false');
    usagePanel.hidden = !open.usage;
    advancedPanel.hidden = !open.advanced;
  }

  function applyMode(mode) {
    state.mode = mode === 'experimental' ? 'experimental' : 'apikey';
    modeExperimentalBtn.setAttribute('aria-checked', state.mode === 'experimental' ? 'true' : 'false');
    modeApiKeyBtn.setAttribute('aria-checked', state.mode === 'apikey' ? 'true' : 'false');
  }

  function renderHeaderToggle() {
    var on = !!state.previewEnabled;
    previewToggleBtn.setAttribute('aria-checked', on ? 'true' : 'false');
    previewToggleBtn.title = on ? 'Click to disable Street View preview (S)' : 'Click to enable Street View preview (S)';
    bodyDimmable.classList.toggle('disabled', !on);
  }

  function render() {
    renderHeaderToggle();

    var firstRun = isFirstRun();
    var invalid = isInvalidKey();
    var over = isOverQuota();
    var experimental = state.mode === 'experimental';

    // Body containers
    bodyExperimental.hidden = !experimental;
    bodyApiKey.hidden = experimental;
    // In experimental mode there's nothing above Advanced, so we pull it
    // flush to the top of the body padding (matches the reference layout).
    bodyDimmable.classList.toggle('mode-experimental', experimental);

    if (experimental) {
      // Experimental body is empty — the mode card already describes the path.
      // Advanced (the next sibling) is the only thing rendered.
    } else {
      // API-key body. Onboarding takes over when there's no key. Cap row +
      // API key field live inside the Google Maps API disclosure, so they
      // ride along with usageSection's visibility.
      apiKeyOnboardingEl.hidden = !firstRun;
      invalidBlock.hidden = !invalid;
      usageSection.hidden = firstRun || invalid;
    }

    // Section visibility depends on whether the section's owning UI is
    // visible. If user's persisted openSection isn't applicable to the
    // current mode/state, fall back to a sensible default.
    var available = computeAvailableSections(firstRun, invalid, experimental);
    var openId = state.openSection;
    if (openId && available.indexOf(openId) === -1) openId = null;
    if (openId === null) {
      // Default behaviors:
      //   - apikey + active: open Usage
      //   - everything else: nothing open by default
      if (!experimental && !firstRun && !invalid) openId = 'usage';
    }
    setSectionOpen(openId);

    // Fill Usage view (even when closed — the disclosure summary needs it)
    renderUsageNumbers(over);

    if (firstRun && !experimental) {
      apiKeyOnboardInput.focus();
    }

    updateResetAllVisibility();
  }

  function computeAvailableSections(firstRun, invalid, experimental) {
    var out = ['advanced'];
    if (!experimental && !firstRun && !invalid) {
      out.unshift('usage');
    }
    return out;
  }

  function renderUsageNumbers(over) {
    usageMonthEl.textContent = 'Usage · ' + currentMonthLabel();
    usageSvEl.textContent = fmt(state.monthSv);
    usageCapDisplayEl.textContent = fmt(state.cap);
    usageScaleMaxEl.textContent = state.cap >= 1000
      ? Math.round(state.cap / 1000) + 'k'
      : String(state.cap);

    var pct = state.cap > 0 ? Math.min(100, (state.monthSv / state.cap) * 100) : 0;
    usageBarFill.style.width = pct + '%';

    var ratio = state.cap > 0 ? state.monthSv / state.cap : 0;
    var isWarn = !over && ratio > 0.9;
    usageSvEl.classList.toggle('usage-used-warn', isWarn);
    usageSvEl.classList.toggle('usage-used-danger', over);
    usageBarFill.classList.toggle('hero-bar-warn', isWarn);
    usageBarFill.classList.toggle('hero-bar-danger', over);

    overCapLabel.hidden = !over;

    usageSvCachedEl.textContent = fmt(state.monthSvCached);
    usageGeoEl.textContent = fmt(state.monthGeo);

    overQuotaNotice.hidden = !over;
    if (over) nextResetDateEl.textContent = nextResetLabel();

    var rateLimited = !!state.rateLimitedAt &&
      (Date.now() - state.rateLimitedAt) < RATE_LIMIT_WINDOW_MS;
    rateLimitNotice.hidden = over || !rateLimited;

    activePagePill.hidden = over || rateLimited;
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

  // Coalesce four independent state reads (sync settings, local counters,
  // session-per-tab, preview-state round-trip) into one initial render. After
  // that render commits, drop the .popup-loading class on next frame so the
  // switch/mode-card transitions only fire for user-driven changes — not for
  // the storage-to-DOM flip on every popup open.
  var pendingReads = 4;
  function initialReadDone() {
    if (--pendingReads === 0) {
      render();
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          document.body.classList.remove('popup-loading');
        });
      });
    }
  }

  chrome.storage.sync.get(
    ['apiKey', 'radius', 'apiCap', 'apiCapEnabled',
     'bucketMeters', 'skipThresholdMeters', 'dwellMs',
     'popupOpenSection', 'popupAdvancedExpanded',
     'useExperimentalPreview', 'verboseDebug',
     'viewportW', 'viewportH', 'tilePx', 'horizonNudgePx'],
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

      // Migrate popupAdvancedExpanded → popupOpenSection on the fly. The new
      // key is authoritative once set (including '' = explicitly closed); the
      // legacy key only seeds the initial value when popupOpenSection is
      // entirely absent from storage. The v5d 'apikey' section was folded
      // into 'usage' in v5e, so persisted 'apikey' maps onto that.
      if (typeof result.popupOpenSection === 'string') {
        var stored = result.popupOpenSection;
        if (stored === 'apikey') stored = 'usage';
        state.openSection = SECTIONS.indexOf(stored) !== -1 ? stored : null;
      } else if (result.popupAdvancedExpanded) {
        state.openSection = 'advanced';
      } else {
        state.openSection = null; // render() picks a default per mode/state
      }

      // Default mode: experimental for new users, apikey if a key is already
      // configured (so existing API-key users aren't flipped to experimental
      // on their next popup open). Write-back once so the value becomes
      // sticky and visible in storage; subsequent reads short-circuit.
      var hasModeFlag = typeof result.useExperimentalPreview === 'boolean';
      var wantExperimental = hasModeFlag
        ? result.useExperimentalPreview === true
        : !state.apiKey;
      if (!hasModeFlag) {
        chrome.storage.sync.set({ useExperimentalPreview: wantExperimental });
      }
      applyMode(wantExperimental ? 'experimental' : 'apikey');
      verboseDebugInput.checked = !!result.verboseDebug;
      viewportWInput.value = numOr(result.viewportW, DEFAULT_VIEWPORT_W);
      viewportHInput.value = numOr(result.viewportH, DEFAULT_VIEWPORT_H);
      tilePxInput.value = numOr(result.tilePx, DEFAULT_TILE_PX);
      horizonNudgePxInput.value = numOrSigned(result.horizonNudgePx, DEFAULT_HORIZON_NUDGE_PX);
      initialReadDone();
    }
  );

  // Mode picker click handlers — both buttons write useExperimentalPreview.
  function setModeFromClick(mode) {
    applyMode(mode);
    chrome.storage.sync.set({ useExperimentalPreview: state.mode === 'experimental' });
    render();
  }
  modeExperimentalBtn.addEventListener('click', function () { setModeFromClick('experimental'); });
  modeApiKeyBtn.addEventListener('click', function () { setModeFromClick('apikey'); });

  verboseDebugInput.addEventListener('change', function () {
    chrome.storage.sync.set({ verboseDebug: verboseDebugInput.checked });
  });

  // ---- Preview on/off switch (header) ----
  // When opened on an RWGPS tab the content script owns the live state
  // (round-trip via runtime messages); otherwise we fall back to writing
  // previewEnabledViewer directly so the button still controls the
  // persisted default.
  function withActiveTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tabId = tabs[0] && tabs[0].id;
      cb(tabId != null ? tabId : null);
    });
  }

  function fetchPreviewState() {
    withActiveTab(function (tabId) {
      if (tabId == null) { renderPreviewFromStorage(); return; }
      chrome.tabs.sendMessage(tabId, { type: 'GET_PREVIEW_STATE' }, function (response) {
        if (chrome.runtime.lastError || !response) {
          renderPreviewFromStorage();
          return;
        }
        previewMode = response.mode || null;
        state.previewEnabled = !!response.enabled;
        renderHeaderToggle();
        initialReadDone();
      });
    });
  }

  function renderPreviewFromStorage() {
    previewMode = null;
    chrome.storage.sync.get(['previewEnabledViewer'], function (result) {
      state.previewEnabled = result.previewEnabledViewer !== false;
      renderHeaderToggle();
      initialReadDone();
    });
  }

  previewToggleBtn.addEventListener('click', function () {
    var next = !state.previewEnabled;
    state.previewEnabled = next; // optimistic
    renderHeaderToggle();
    withActiveTab(function (tabId) {
      if (tabId == null) {
        chrome.storage.sync.set({ previewEnabledViewer: next });
        return;
      }
      chrome.tabs.sendMessage(tabId, { type: 'SET_PREVIEW_STATE', enabled: next }, function (response) {
        if (chrome.runtime.lastError || !response) {
          // No content script on this tab — write storage directly.
          chrome.storage.sync.set({ previewEnabledViewer: next });
          previewMode = null;
          return;
        }
        previewMode = response.mode || previewMode;
        state.previewEnabled = !!response.enabled;
        renderHeaderToggle();
      });
    });
  });

  // Mirror the page's `s` shortcut inside the popup — when the popup is open
  // the page doesn't receive key events, so we wire it up here too.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 's' && event.key !== 'S') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    var t = event.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (previewToggleBtn.disabled) return;
    event.preventDefault();
    previewToggleBtn.click();
  });

  fetchPreviewState();

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

  // Single-open accordion: clicking any section toggle opens it and
  // closes the others. Clicking an already-open section closes it.
  function bindSection(btn, sectionId) {
    btn.addEventListener('click', function () {
      var next = (state.openSection === sectionId) ? null : sectionId;
      setSectionOpen(next);
      chrome.storage.sync.set({ popupOpenSection: next == null ? '' : next });
    });
  }
  bindSection(usageToggle, 'usage');
  bindSection(advToggle, 'advanced');

  // How-to disclosure (firstrun) is independent — toggles its own list only.
  howToToggle.addEventListener('click', function () {
    var open = howToToggle.getAttribute('aria-expanded') === 'true';
    howToToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    howToList.hidden = open;
  });

  replaceKeyBtn.addEventListener('click', function () {
    chrome.storage.sync.set({ apiKey: '' });
    chrome.storage.local.remove(['apiKeyInvalid']);
    apiKeyOnboardInput.focus();
  });

  resetBtn.addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: RwgpsUsage.RESET_MSG });
  });

  function showSetRow() {
    usageSetInput.value = String(state.monthSv);
    usageSetInput.removeAttribute('aria-invalid');
    usageEyebrow.hidden = true;
    usageSetRow.hidden = false;
    usageSetInput.focus();
    usageSetInput.select();
  }
  function hideSetRow() {
    usageSetRow.hidden = true;
    usageEyebrow.hidden = false;
    setBtn.focus();
  }
  function commitSet() {
    // type="number" sanitizes commas/letters out of .value, but `step="1"`
    // is advisory — a typed "1.5" still reaches us. Reject anything that
    // isn't a non-negative integer to avoid silent parseInt truncation.
    var raw = (usageSetInput.value || '').trim();
    if (!/^\d+$/.test(raw)) {
      usageSetInput.setAttribute('aria-invalid', 'true');
      usageSetInput.focus();
      usageSetInput.select();
      return;
    }
    chrome.runtime.sendMessage({ type: RwgpsUsage.SET_MSG, streetviewNetwork: parseInt(raw, 10) });
    hideSetRow();
  }
  setBtn.addEventListener('click', showSetRow);
  usageSetSave.addEventListener('click', commitSet);
  usageSetCancel.addEventListener('click', hideSetRow);
  usageSetInput.addEventListener('input', function () {
    usageSetInput.removeAttribute('aria-invalid');
  });
  usageSetInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); commitSet(); }
    else if (event.key === 'Escape') { event.preventDefault(); hideSetRow(); }
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

  // "Reset all to defaults" — visibility tied to whether any tunable differs.
  // Drops the four storage keys; the existing storage.onChanged listener
  // mirrors the defaults back into the inputs and re-runs visibility.
  var TUNABLES = [
    { input: radiusInput, key: 'radius', def: DEFAULT_RADIUS },
    { input: bucketMetersInput, key: 'bucketMeters', def: DEFAULT_BUCKET_METERS },
    { input: skipThresholdMetersInput, key: 'skipThresholdMeters', def: DEFAULT_SKIP_THRESHOLD_METERS },
    { input: dwellMsInput, key: 'dwellMs', def: DEFAULT_DWELL_MS }
  ];
  function updateResetAllVisibility() {
    var anyModified = TUNABLES.some(function (t) {
      var v = parseInt(t.input.value, 10);
      return !isNaN(v) && v !== t.def;
    });
    advResetAll.hidden = !anyModified;
  }
  TUNABLES.forEach(function (t) { t.input.addEventListener('input', updateResetAllVisibility); });
  advResetAllBtn.addEventListener('click', function () {
    chrome.storage.sync.remove(TUNABLES.map(function (t) { return t.key; }));
  });
  bindNumberSave(viewportWInput, 'viewportW', function (v) { return v >= 200 && v <= 900; });
  bindNumberSave(viewportHInput, 'viewportH', function (v) { return v >= 150 && v <= 600; });
  bindNumberSave(tilePxInput, 'tilePx', function (v) { return v >= 80 && v <= 800; });
  bindNumberSave(horizonNudgePxInput, 'horizonNudgePx', function (v) { return v >= -150 && v <= 150; });

  // Reset buttons next to each tunable: drop the storage key so content.js
  // and the popup both fall back to their defaults. The storage.onChanged
  // listener below mirrors the new value into the input.
  document.querySelectorAll('[data-reset]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-reset');
      if (key) chrome.storage.sync.remove(key);
    });
  });

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
      if (changes.useExperimentalPreview) {
        applyMode(changes.useExperimentalPreview.newValue === true ? 'experimental' : 'apikey');
        changed = true;
      }
      if (changes.bucketMeters) syncInputValue(bucketMetersInput, numOr(changes.bucketMeters.newValue, DEFAULT_BUCKET_METERS));
      if (changes.skipThresholdMeters) syncInputValue(skipThresholdMetersInput, numOr(changes.skipThresholdMeters.newValue, DEFAULT_SKIP_THRESHOLD_METERS));
      if (changes.dwellMs) syncInputValue(dwellMsInput, numOr(changes.dwellMs.newValue, DEFAULT_DWELL_MS));
      if (changes.radius) syncInputValue(radiusInput, changes.radius.newValue || DEFAULT_RADIUS);
      if (changes.viewportW) syncInputValue(viewportWInput, numOr(changes.viewportW.newValue, DEFAULT_VIEWPORT_W));
      if (changes.viewportH) syncInputValue(viewportHInput, numOr(changes.viewportH.newValue, DEFAULT_VIEWPORT_H));
      if (changes.tilePx) syncInputValue(tilePxInput, numOr(changes.tilePx.newValue, DEFAULT_TILE_PX));
      if (changes.horizonNudgePx) syncInputValue(horizonNudgePxInput, numOrSigned(changes.horizonNudgePx.newValue, DEFAULT_HORIZON_NUDGE_PX));
      if (changes.verboseDebug) verboseDebugInput.checked = !!changes.verboseDebug.newValue;
      // Mirror viewer-mode preview toggles. Editor-mode state lives only in
      // the content script's memory so there's no storage event to listen for.
      if (changes.previewEnabledViewer && previewMode !== 'editor') {
        state.previewEnabled = changes.previewEnabledViewer.newValue !== false;
        renderHeaderToggle();
      }
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
