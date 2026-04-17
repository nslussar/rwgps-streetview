var DEFAULT_RADIUS = 10;

document.addEventListener('DOMContentLoaded', function () {
  const apiKeyInput = document.getElementById('apiKey');
  const enabledInput = document.getElementById('enabled');
  const radiusInput = document.getElementById('radius');

  // Display version
  var manifest = chrome.runtime.getManifest();
  var version = manifest.version === '0.0.0' ? '(dev build)' : 'v' + manifest.version;
  document.getElementById('version').textContent = version;

  // Load saved settings
  chrome.storage.sync.get(['apiKey', 'enabled', 'radius'], function (result) {
    apiKeyInput.value = result.apiKey || '';
    enabledInput.checked = result.enabled !== false;
    radiusInput.value = result.radius || DEFAULT_RADIUS;
  });

  // Toggle API key visibility
  var toggleBtn = document.getElementById('toggleKey');
  var eyeIcon = document.getElementById('eyeIcon');
  toggleBtn.addEventListener('click', function () {
    var hidden = apiKeyInput.type === 'password';
    apiKeyInput.type = hidden ? 'text' : 'password';
    eyeIcon.src = hidden ? '../icons/eye-show.png' : '../icons/eye-hide.png';
  });

  // Auto-save on change
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
});
