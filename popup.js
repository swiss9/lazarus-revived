const browser = globalThis.browser || globalThis.chrome;

let showAll = false;
let currentTabUrl = '';
let currentTabId = null;
let lazarus_lock_active = false;
let lazarus_unlocked = false;
let lazarus_salt = null;
let lazarus_pin_hash = null;
let cachedBlacklist = [];
let cachedSettings = {
  savePasswords: false,
  retentionHours: 720,
  restoreRequiresPassword: false,
  searchIndexing: true
};

async function loadSettings() {
  const { lazarus_settings } = await browser.storage.local.get("lazarus_settings");
  cachedSettings = { ...cachedSettings, ...(lazarus_settings || {}) };
  applySettingsToUI();
}

function applySettingsToUI() {
  document.getElementById('setting-savePasswords').checked = cachedSettings.savePasswords;
  document.getElementById('setting-retentionHours').value = cachedSettings.retentionHours;
  document.getElementById('setting-restoreRequiresPassword').checked = cachedSettings.restoreRequiresPassword;
  document.getElementById('setting-searchIndexing').checked = cachedSettings.searchIndexing;

  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.style.display = cachedSettings.searchIndexing ? '' : 'none';
  }
}

async function saveSettingsToStorage() {
  const newSettings = {
    savePasswords: document.getElementById('setting-savePasswords').checked,
    retentionHours: parseInt(document.getElementById('setting-retentionHours').value, 10) || 0,
    restoreRequiresPassword: document.getElementById('setting-restoreRequiresPassword').checked,
    searchIndexing: document.getElementById('setting-searchIndexing').checked
  };
  await browser.storage.local.set({ lazarus_settings: newSettings });
  cachedSettings = newSettings;
  applySettingsToUI();
  document.getElementById('settings-modal').style.display = 'none';
}

loadSettings();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.lazarus_settings) {
      cachedSettings = { ...cachedSettings, ...(changes.lazarus_settings.newValue || {}) };
      applySettingsToUI();
    }
    if (changes.lazarus_blacklist) {
      cachedBlacklist = changes.lazarus_blacklist.newValue || [];
    }
  }
});

async function loadBlacklist() {
  const { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
  cachedBlacklist = lazarus_blacklist || [];
}

function isSiteBlacklisted() {
  try {
    const hostname = new URL(currentTabUrl).hostname;
    return cachedBlacklist.includes(hostname);
  } catch { return false; }
}

async function loadLockState() {
  const { lazarus_lock, lazarus_salt_storage, lazarus_pin_hash_storage } = await browser.storage.local.get([
    "lazarus_lock", "lazarus_salt_storage", "lazarus_pin_hash_storage"
  ]);
  lazarus_lock_active = lazarus_lock === true;
  lazarus_salt = lazarus_salt_storage || null;
  lazarus_pin_hash = lazarus_pin_hash_storage || null;
}

async function deriveKey(pin, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPin(pin) {
  if (!lazarus_salt || !lazarus_pin_hash) return false;
  const hash = await deriveKey(pin, lazarus_salt);
  return hash === lazarus_pin_hash;
}

async function setLockPin(pin) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await deriveKey(pin, salt);
  await browser.storage.local.set({
    lazarus_lock: true,
    lazarus_salt_storage: salt,
    lazarus_pin_hash_storage: hash
  });
  lazarus_lock_active = true;
  lazarus_salt = salt;
  lazarus_pin_hash = hash;
}

function timeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, match => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[match];
  });
}

function extractLabel(fieldName) {
  if (fieldName.startsWith('#')) return fieldName;
  const last = fieldName.split('>').pop().trim();
  if (last.includes('[') || last.includes('#')) return last;
  return last;
}

async function getEntriesFromStorage() {
  try {
    const resp = await browser.runtime.sendMessage({
      action: "getSavedData",
      currentTabUrl: showAll ? null : currentTabUrl
    });
    return resp.entries;
  } catch (e) {
    return [];
  }
}

async function getActiveTabId() {
  if (currentTabId) return currentTabId;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;
  return currentTabId;
}

async function ensureRestorePermission() {
  if (!cachedSettings.restoreRequiresPassword) return true;
  if (!lazarus_lock_active) return true;

  const { lazarus_session_unlocked } = await browser.storage.session.get("lazarus_session_unlocked");
  if (lazarus_session_unlocked) {
    lazarus_unlocked = true;
    return true;
  }

  return new Promise(resolve => {
    showPinModal('verify', resolve);
  });
}

async function sendRestoreToActiveTab(fieldName, text) {
  if (!(await ensureRestorePermission())) return;
  const tabId = await getActiveTabId();
  if (!tabId) return;
  browser.tabs.sendMessage(tabId, {
    action: "restoreText",
    data: { fieldName, text }
  }).catch(() => {});
}

async function togglePin(entryId) {
  await browser.runtime.sendMessage({ action: "togglePin", entryId });
}

async function refreshEntries() {
  const container = document.getElementById('entries');
  container.innerHTML = '';
  if (lazarus_lock_active && !lazarus_unlocked) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔒</div><div class="empty-title">Vault Locked</div><div class="empty-desc">Enter your PIN to access saved texts.</div></div>`;
    return;
  }
  const searchValue = document.getElementById('search-input')?.value.toLowerCase().trim() || '';
  const entries = await getEntriesFromStorage();
  if (!entries || entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📜</div>
        <div class="empty-title">No drafts saved ${showAll ? 'yet' : 'for this site'}</div>
        <div class="empty-desc">Type in any form field and Lazarus will automatically capture your text here.</div>
      </div>
    `;
    return;
  }

  const filtered = entries.filter(e => {
    if (!searchValue) return true;
    const latestText = e.versions[e.versions.length - 1].text.toLowerCase();
    const field = e.fieldName.toLowerCase();
    const url = e.pageUrl.toLowerCase();
    return field.includes(searchValue) || latestText.includes(searchValue) || url.includes(searchValue);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No matching drafts</div></div>`;
    return;
  }

  filtered.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.versions[b.versions.length - 1].timestamp - a.versions[a.versions.length - 1].timestamp);

  const grouped = {};
  filtered.forEach(entry => {
    let hostname = 'Unknown Site';
    try { hostname = new URL(entry.pageUrl).hostname.replace('www.', '') || entry.pageUrl; } catch (e) { hostname = entry.pageUrl; }
    if (!grouped[hostname]) grouped[hostname] = [];
    grouped[hostname].push(entry);
  });

  for (const [hostname, entries] of Object.entries(grouped)) {
    const header = document.createElement('div');
    header.style.cssText = 'font-size:12px;font-weight:600;color:#D4AF37;margin:8px 0 4px 0;padding-bottom:2px;border-bottom:1px solid #333;';
    header.textContent = hostname;
    container.appendChild(header);

    entries.forEach(entry => {
      const card = document.createElement('div');
      card.className = 'entry-card';
      const latestVersion = entry.versions[entry.versions.length - 1];
      const label = extractLabel(entry.fieldName);
      card.innerHTML = `
        <div class="entry-meta">
          <span class="field-tag">${escapeHtml(label)}</span>
          <span class="time-tag">${timeAgo(latestVersion.timestamp)} · ${escapeHtml(hostname)}</span>
        </div>
        <div class="snippet">${escapeHtml(latestVersion.text)}</div>
        <div class="card-actions">
          <button class="btn-icon pin-btn" title="${entry.pinned ? 'Unpin' : 'Pin'}" aria-label="Pin ${escapeHtml(label)}">${entry.pinned ? '⭐' : '☆'}</button>
          <button class="btn-icon history-btn" title="View version history" aria-label="View version history for ${escapeHtml(label)}">📜</button>
          <button class="btn-icon delete-btn" title="Delete draft" aria-label="Delete draft ${escapeHtml(label)}">🗑️</button>
          <button class="btn-primary restore-btn">Resurrect</button>
        </div>
      `;

      card.querySelector('.restore-btn').addEventListener('click', () => {
        sendRestoreToActiveTab(entry.fieldName, latestVersion.text);
      });

      card.querySelector('.delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await browser.runtime.sendMessage({ action: "deleteEntry", entryId: entry.id });
        refreshEntries();
      });

      card.querySelector('.history-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        showVersionHistory(entry);
      });

      card.querySelector('.pin-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await togglePin(entry.id);
        refreshEntries();
      });

      container.appendChild(card);
    });
  }
}

async function showVersionHistory(entry) {
  const modal = document.createElement('div');
  modal.className = 'version-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', `Version history for ${extractLabel(entry.fieldName)}`);
  modal.innerHTML = `
    <div class="version-modal-content">
      <div class="version-header">
        <span class="field-tag">${escapeHtml(extractLabel(entry.fieldName))}</span>
        <button class="btn-icon close-modal" aria-label="Close version history">✖</button>
      </div>
      <div class="version-list"></div>
    </div>
  `;
  document.body.appendChild(modal);
  const list = modal.querySelector('.version-list');
  entry.versions.slice().reverse().forEach(version => {
    const row = document.createElement('div');
    row.className = 'version-row';
    row.innerHTML = `
      <span class="time-tag">${timeAgo(version.timestamp)}</span>
      <span class="version-snippet">${escapeHtml(version.text.slice(0, 60))}</span>
      <button class="btn-primary small restore-btn">Restore</button>
      <button class="btn-primary small promote-btn">Set as current</button>
    `;
    row.querySelector('.restore-btn').addEventListener('click', async () => {
      if (!(await ensureRestorePermission())) return;
      sendRestoreToActiveTab(entry.fieldName, version.text);
      modal.remove();
    });
    row.querySelector('.promote-btn').addEventListener('click', async () => {
      await browser.runtime.sendMessage({
        action: "promoteVersion",
        entryId: entry.id,
        timestamp: version.timestamp
      });
      modal.remove();
      refreshEntries();
    });
    list.appendChild(row);
  });
  modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

async function resurrectFullForm() {
  if (lazarus_lock_active && !lazarus_unlocked) return;
  if (!(await ensureRestorePermission())) return;
  const resp = await browser.runtime.sendMessage({
    action: "getSavedData",
    currentTabUrl: currentTabUrl
  });
  const entries = resp.entries || [];
  const payload = entries.map(e => ({
    fieldName: e.fieldName,
    text: e.versions[e.versions.length - 1].text
  }));
  const tabId = await getActiveTabId();
  if (tabId) {
    browser.tabs.sendMessage(tabId, {
      action: "restoreAllTexts",
      data: payload
    }).catch(() => {});
  }
}

async function toggleBlacklist() {
  const hostname = new URL(currentTabUrl).hostname;
  let { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
  let list = lazarus_blacklist || [];
  const index = list.indexOf(hostname);
  if (index > -1) list.splice(index, 1);
  else list.push(hostname);
  await browser.storage.local.set({ lazarus_blacklist: list });
  cachedBlacklist = list;
  updateBlacklistButton();
  updateStatusBadge();
  browser.runtime.sendMessage({ action: "blacklist-changed" });
}

function updateBlacklistButton() {
  const btn = document.getElementById('blacklist-btn');
  if (!currentTabUrl) return;
  if (isSiteBlacklisted()) {
    btn.textContent = '🔇 Unsilence Site';
  } else {
    btn.textContent = '🔕 Silence Site';
  }
}

function updateStatusBadge() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (!currentTabUrl) return;
  if (isSiteBlacklisted()) {
    dot.classList.add('paused');
    text.textContent = 'Vault Paused';
  } else {
    dot.classList.remove('paused');
    text.textContent = 'Vault Active';
  }
}

async function exportVault() {
  if (lazarus_lock_active && !lazarus_unlocked) return;
  if (!(await ensureRestorePermission())) return;
  const { entries } = await browser.runtime.sendMessage({ action: "getExportData" });
  const json = JSON.stringify(entries, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lazarus_vault_export.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function importVault() {
  if (lazarus_lock_active && !lazarus_unlocked) return;
  if (!(await ensureRestorePermission())) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error('Invalid format');
      await browser.runtime.sendMessage({ action: "importData", entries: imported });
      refreshEntries();
    } catch (e) {
      alert('Invalid vault file.');
    }
  };
  input.click();
}

function showPinModal(mode, callback) {
  const existing = document.querySelector('.pin-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.className = 'pin-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  let title = 'Enter PIN';
  if (mode === 'set') title = 'Set PIN';
  else if (mode === 'unlock-session') title = 'Unlock Session';
  const showConfirm = mode === 'set';
  modal.innerHTML = `
    <div class="pin-modal-content">
      <div class="pin-header">
        <span class="field-tag">${title}</span>
        <button class="btn-icon close-modal" aria-label="Close">✖</button>
      </div>
      <input type="password" class="search-input pin-input" placeholder="Enter PIN" aria-label="PIN" style="margin-bottom:8px;">
      ${showConfirm ? '<input type="password" class="search-input pin-confirm" placeholder="Confirm PIN" aria-label="Confirm PIN" style="margin-bottom:8px;">' : ''}
      <div class="error-text pin-error">${mode === 'set' ? 'PINs do not match' : 'Invalid PIN'}</div>
      <button class="btn-primary pin-submit" style="margin-top:8px;">${mode === 'set' ? 'Set' : 'Verify'}</button>
    </div>
  `;
  document.body.appendChild(modal);
  const closeBtn = modal.querySelector('.close-modal');
  const submitBtn = modal.querySelector('.pin-submit');
  const inputField = modal.querySelector('.pin-input');
  const confirmField = modal.querySelector('.pin-confirm');
  const errorDiv = modal.querySelector('.pin-error');

  closeBtn.addEventListener('click', () => { modal.remove(); if (callback) callback(false); });
  modal.addEventListener('click', (e) => { if (e.target === modal) { modal.remove(); if (callback) callback(false); } });

  inputField.focus();

  function submit() {
    const pin = inputField.value.trim();
    if (!pin) return;

    if (mode === 'set') {
      const confirm = confirmField.value.trim();
      if (pin !== confirm) {
        errorDiv.style.display = 'block';
        return;
      }
      errorDiv.style.display = 'none';
      setLockPin(pin).then(() => {
        document.getElementById('lock-btn').textContent = '🔓 Unlocked';
        lazarus_unlocked = true;
        browser.storage.session.set({ lazarus_session_unlocked: true });
        document.getElementById('lock-screen').style.display = 'none';
        document.getElementById('main-ui').style.display = 'flex';
        modal.remove();
        refreshEntries();
        if (callback) callback(true);
      });
    } else if (mode === 'verify' || mode === 'unlock-session') {
      verifyPin(pin).then(valid => {
        if (valid) {
          if (mode === 'unlock-session') {
            lazarus_unlocked = true;
            browser.storage.session.set({ lazarus_session_unlocked: true });
            document.getElementById('lock-btn').textContent = '🔓 Unlocked';
            document.getElementById('lock-screen').style.display = 'none';
            document.getElementById('main-ui').style.display = 'flex';
            modal.remove();
            refreshEntries();
            if (callback) callback(true);
          } else {
            if (callback) {
              lazarus_unlocked = true;
              document.getElementById('lock-btn').textContent = '🔓 Unlocked';
              browser.storage.session.set({ lazarus_session_unlocked: true });
              callback(true);
              modal.remove();
            }
          }
        } else {
          errorDiv.style.display = 'block';
          if (callback) callback(false);
        }
      });
    }
  }

  submitBtn.addEventListener('click', submit);
  inputField.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  if (confirmField) {
    confirmField.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    confirmField.addEventListener('input', () => { errorDiv.style.display = 'none'; });
  }
}

let searchDebounceTimer;
function debouncedRefresh() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(refreshEntries, 200);
}

async function init() {
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'blacklist-changed') {
      loadBlacklist().then(() => {
        updateStatusBadge();
        updateBlacklistButton();
      });
    }
  });

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab ? tab.id : null;
  currentTabUrl = tab ? tab.url : '';

  await loadBlacklist();
  await loadLockState();
  await loadSettings();

  const { lazarus_session_unlocked } = await browser.storage.session.get("lazarus_session_unlocked");
  if (lazarus_session_unlocked) {
    lazarus_unlocked = true;
  }

  if (lazarus_lock_active && !lazarus_unlocked) {
    document.getElementById('lock-screen').style.display = 'flex';
    document.getElementById('main-ui').style.display = 'none';
  } else {
    document.getElementById('lock-screen').style.display = 'none';
    document.getElementById('main-ui').style.display = 'flex';
  }

  if (currentTabUrl) {
    updateStatusBadge();
    updateBlacklistButton();
  }

  document.getElementById('tab-site').addEventListener('click', () => {
    showAll = false;
    document.getElementById('tab-site').classList.add('active');
    document.getElementById('tab-all').classList.remove('active');
    refreshEntries();
  });
  document.getElementById('tab-all').addEventListener('click', () => {
    showAll = true;
    document.getElementById('tab-all').classList.add('active');
    document.getElementById('tab-site').classList.remove('active');
    refreshEntries();
  });

  document.getElementById('search-input').addEventListener('input', debouncedRefresh);
  document.getElementById('resurrect-all-btn').addEventListener('click', resurrectFullForm);
  document.getElementById('blacklist-btn').addEventListener('click', toggleBlacklist);
  document.getElementById('export-btn').addEventListener('click', exportVault);
  document.getElementById('import-btn').addEventListener('click', importVault);

  document.getElementById('toggle-donate').addEventListener('click', (e) => {
    e.preventDefault();
    const modal = document.getElementById('donate-modal');
    modal.style.display = modal.style.display === 'none' || !modal.style.display ? 'flex' : 'none';
    document.getElementById('settings-modal').style.display = 'none';
  });

  document.getElementById('settings-btn').addEventListener('click', () => {
    const settingsModal = document.getElementById('settings-modal');
    const donateModal = document.getElementById('donate-modal');
    if (settingsModal.style.display === 'none' || !settingsModal.style.display) {
      settingsModal.style.display = 'flex';
      donateModal.style.display = 'none';
    } else {
      settingsModal.style.display = 'none';
    }
  });

  document.getElementById('settings-close-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
  });

  document.getElementById('save-settings').addEventListener('click', saveSettingsToStorage);

  document.getElementById('lock-btn').addEventListener('click', () => {
    if (lazarus_lock_active) {
      if (lazarus_unlocked) {
        lazarus_unlocked = false;
        browser.storage.session.set({ lazarus_session_unlocked: false });
        document.getElementById('lock-btn').textContent = '🔒 Locked';
        document.getElementById('lock-screen').style.display = 'flex';
        document.getElementById('main-ui').style.display = 'none';
      } else {
        showPinModal('unlock-session');
      }
    } else {
      showPinModal('set');
    }
  });

  document.getElementById('unlock-btn').addEventListener('click', async () => {
    const pinInput = document.getElementById('pin-input');
    const pinError = document.getElementById('pin-error');
    pinError.style.display = 'none';
    const pin = pinInput.value.trim();
    if (!pin) return;
    if (await verifyPin(pin)) {
      lazarus_unlocked = true;
      browser.storage.session.set({ lazarus_session_unlocked: true });
      document.getElementById('lock-btn').textContent = '🔓 Unlocked';
      document.getElementById('lock-screen').style.display = 'none';
      document.getElementById('main-ui').style.display = 'flex';
      refreshEntries();
    } else {
      pinError.style.display = 'block';
    }
  });

  document.getElementById('pin-input').addEventListener('input', () => {
    document.getElementById('pin-error').style.display = 'none';
  });

  document.getElementById('lock-btn').textContent = (lazarus_lock_active && !lazarus_unlocked) ? '🔒 Locked' : '🔓 Unlocked';

  await refreshEntries();
}

init();