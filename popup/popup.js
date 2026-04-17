document.addEventListener('DOMContentLoaded', function () {
  const apiKeyInput = document.getElementById('apiKey');
  const enabledInput = document.getElementById('enabled');

  // Display version
  var manifest = chrome.runtime.getManifest();
  var version = manifest.version === '0.0.0' ? '(dev build)' : 'v' + manifest.version;
  document.getElementById('version').textContent = version;

  // Load saved settings
  chrome.storage.sync.get(['apiKey', 'enabled'], function (result) {
    apiKeyInput.value = result.apiKey || '';
    enabledInput.checked = result.enabled !== false;
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
});
