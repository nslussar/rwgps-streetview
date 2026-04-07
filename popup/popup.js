document.addEventListener('DOMContentLoaded', function () {
  const apiKeyInput = document.getElementById('apiKey');
  const enabledInput = document.getElementById('enabled');
  const saveBtn = document.getElementById('save');
  const statusEl = document.getElementById('status');

  // Load saved settings
  chrome.storage.sync.get(['apiKey', 'enabled'], function (result) {
    apiKeyInput.value = result.apiKey || '';
    enabledInput.checked = result.enabled !== false;
  });

  saveBtn.addEventListener('click', function () {
    const apiKey = apiKeyInput.value.trim();
    const enabled = enabledInput.checked;

    chrome.storage.sync.set({ apiKey: apiKey, enabled: enabled }, function () {
      statusEl.textContent = 'Saved!';
      statusEl.className = 'success';
      setTimeout(function () { statusEl.textContent = ''; }, 2000);
    });
  });

  // Save on Enter in the input field
  apiKeyInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') saveBtn.click();
  });
});
