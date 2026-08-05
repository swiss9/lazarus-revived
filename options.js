const defaults = {
  savePasswords: false,
  retentionHours: 720,
  restoreRequiresPassword: false,
  searchIndexing: true
};

async function loadSettings() {
  const { lazarus_settings } = await browser.storage.local.get("lazarus_settings");
  return { ...defaults, ...(lazarus_settings || {}) };
}

async function init() {
  const settings = await loadSettings();
  document.getElementById('savePasswords').checked = settings.savePasswords;
  document.getElementById('retentionHours').value = settings.retentionHours;
  document.getElementById('restoreRequiresPassword').checked = settings.restoreRequiresPassword;
  document.getElementById('searchIndexing').checked = settings.searchIndexing;

  document.getElementById('save').addEventListener('click', async () => {
    const newSettings = {
      savePasswords: document.getElementById('savePasswords').checked,
      retentionHours: parseInt(document.getElementById('retentionHours').value, 10) || 0,
      restoreRequiresPassword: document.getElementById('restoreRequiresPassword').checked,
      searchIndexing: document.getElementById('searchIndexing').checked
    };
    await browser.storage.local.set({ lazarus_settings: newSettings });
    const status = document.getElementById('status');
    status.style.display = 'inline';
    setTimeout(() => status.style.display = 'none', 1500);
  });
}

init();
