const browser = globalThis.browser || globalThis.chrome;

let showAll = false;
let currentTabUrl = '';
let lazarus_lock_active = false;
let lazarus_unlocked = false;
let lazarus_salt = null;
let lazarus_pin_hash = null;
let lazarus_enc_salt = null;
let cachedBlacklist = [];
let cachedSettings = {
  savePasswords: false,
  retentionHours: 720,
  restoreRequiresPassword: false,
  searchIndexing: true
};
let encryptionKey = null;
let operationQueue = Promise.resolve();
let currentPageSize = 50;

const $ = id => document.getElementById(id);

const lockBtn = $('lock-btn');
const lockScreen = $('lock-screen');
const mainUi = $('main-ui');
const entriesContainer = $('entries');
const searchInput = $('search-input');
const settingsModal = $('settings-modal');
const donateModal = $('donate-modal');
const toastEl = $('toast');
const loadingSpinner = $('loading-spinner');

let toastTimer;

function showToast(msg) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

function updateLockButtonText() {
  if (!lazarus_lock_active) {
    lockBtn.textContent = '🔒 Set PIN';
    lockBtn.title = 'Set a PIN to lock your vault';
  } else if (lazarus_unlocked) {
    lockBtn.textContent = '🔓 Unlocked';
    lockBtn.title = 'Lock the vault';
  } else {
    lockBtn.textContent = '🔒 Locked';
    lockBtn.title = 'Unlock the vault';
  }
}

function enqueue(op) {
  operationQueue = operationQueue.then(() => op()).catch(e => {
    console.error('[Lazarus] Operation failed:', e);
    showToast('Operation failed: ' + e.message);
  });
  return operationQueue;
}

async function loadSettings() {
  try {
    const { lazarus_settings } = await browser.storage.local.get("lazarus_settings");
    cachedSettings = { ...cachedSettings, ...(lazarus_settings || {}) };
    applySettingsToUI();
  } catch (e) {
    console.error('[Lazarus] loadSettings error:', e);
  }
}

function applySettingsToUI() {
  $('setting-savePasswords').checked = cachedSettings.savePasswords;
  $('setting-retentionHours').value = cachedSettings.retentionHours;
  $('setting-restoreRequiresPassword').checked = cachedSettings.restoreRequiresPassword;
  $('setting-searchIndexing').checked = cachedSettings.searchIndexing;
  searchInput.style.display = cachedSettings.searchIndexing ? '' : 'none';
  const changePinBtn = $('setting-change-pin');
  if (changePinBtn) {
    changePinBtn.style.display = (lazarus_lock_active && lazarus_unlocked) ? 'inline-block' : 'none';
  }
}

async function saveSettingsToStorage() {
  try {
    const newSettings = {
      savePasswords: $('setting-savePasswords').checked,
      retentionHours: parseInt($('setting-retentionHours').value, 10) || 0,
      restoreRequiresPassword: $('setting-restoreRequiresPassword').checked,
      searchIndexing: $('setting-searchIndexing').checked
    };
    await browser.storage.local.set({ lazarus_settings: newSettings });
    cachedSettings = newSettings;
    applySettingsToUI();
    settingsModal.style.display = 'none';
    showToast('Settings saved');
  } catch (e) {
    showToast('Failed to save settings: ' + e.message);
  }
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
      updateBlacklistButton();
    }
  }
});

async function loadBlacklist() {
  try {
    const { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
    cachedBlacklist = lazarus_blacklist || [];
  } catch (e) { console.error(e); }
}

function isSiteBlacklisted() {
  try { return cachedBlacklist.includes(new URL(currentTabUrl).hostname); } catch { return false; }
}

async function loadLockState() {
  try {
    const data = await browser.storage.local.get([
      "lazarus_lock", "lazarus_salt_storage", "lazarus_pin_hash_storage", "lazarus_enc_salt_storage"
    ]);
    lazarus_lock_active = data.lazarus_lock === true;
    lazarus_salt = data.lazarus_salt_storage || null;
    lazarus_pin_hash = data.lazarus_pin_hash_storage || null;
    lazarus_enc_salt = data.lazarus_enc_salt_storage || null;
  } catch (e) { console.error(e); }
}

async function deriveKey(pin, salt, purpose = '') {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt + purpose), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPin(pin) {
  if (!lazarus_salt || !lazarus_pin_hash) return false;
  const hash = await deriveKey(pin, lazarus_salt, 'verify');
  return hash === lazarus_pin_hash;
}

async function deriveEncryptionKey(pin) {
  if (!lazarus_enc_salt) return null;
  const rawKey = await deriveKey(pin, lazarus_enc_salt, 'encrypt');
  const keyBytes = new Uint8Array(rawKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
  return await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptBlob(entries) {
  if (!encryptionKey) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(entries));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, encoded);
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(ciphertext)) };
}

async function decryptBlob(encrypted) {
  if (!encryptionKey) return null;
  try {
    const iv = new Uint8Array(encrypted.iv);
    const ciphertext = new Uint8Array(encrypted.data);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encryptionKey, ciphertext);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (e) { return null; }
}

async function storeEncryptionKeyInSession() {
  if (!encryptionKey) return;
  const rawKey = await crypto.subtle.exportKey("raw", encryptionKey);
  const keyStr = Array.from(new Uint8Array(rawKey)).map(b => b.toString(16).padStart(2, '0')).join('');
  await browser.storage.session.set({ lazarus_encryption_key: keyStr });
}

async function loadEncryptionKeyFromSession() {
  try {
    const { lazarus_encryption_key } = await browser.storage.session.get("lazarus_encryption_key");
    if (lazarus_encryption_key) {
      const keyBytes = new Uint8Array(lazarus_encryption_key.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      encryptionKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    }
  } catch (e) { encryptionKey = null; }
}

async function saveBlobToBackground(blob) {
  await browser.runtime.sendMessage({ action: "saveBlob", blob });
}

async function loadBlobFromBackground(filterUrl) {
  const resp = await browser.runtime.sendMessage({ action: "getSavedData", currentTabUrl: filterUrl });
  return resp.entries;
}

async function loadEntries(filterUrl) {
  try {
    const stored = await loadBlobFromBackground(filterUrl);
    if (!stored) return [];
    if (stored.iv) {
      if (!encryptionKey) return [];
      const decrypted = await decryptBlob(stored);
      return decrypted || [];
    }
    return stored;
  } catch (e) {
    console.error('[Lazarus] loadEntries error:', e);
    return [];
  }
}

async function saveEntries(entries) {
  try {
    if (lazarus_lock_active && encryptionKey) {
      const encrypted = await encryptBlob(entries);
      if (encrypted) await saveBlobToBackground(encrypted);
    } else {
      await saveBlobToBackground(entries);
    }
  } catch (e) {
    console.error('[Lazarus] saveEntries error:', e);
    throw e;
  }
}

function renderEntries(entries) {
  entriesContainer.innerHTML = '';
  if (!entries || !entries.length) {
    entriesContainer.innerHTML = `<div class="empty-state"><div class="empty-icon">📝</div><div class="empty-title">Nothing saved yet</div><div class="empty-desc">Start typing in any form field – Lazarus will quietly save your work.</div></div>`;
    return;
  }
  const grouped = {};
  entries.forEach(entry => {
    let hostname = 'Unknown Site';
    try { hostname = new URL(entry.pageUrl).hostname.replace('www.', '') || entry.pageUrl; } catch (e) { hostname = entry.pageUrl; }
    if (!grouped[hostname]) grouped[hostname] = [];
    grouped[hostname].push(entry);
  });
  for (const [hostname, entries] of Object.entries(grouped)) {
    const header = document.createElement('div');
    header.style.cssText = 'font-size:12px;font-weight:600;color:#D4AF37;margin:8px 0 4px 0;padding-bottom:2px;border-bottom:1px solid #333;';
    header.textContent = hostname;
    entriesContainer.appendChild(header);
    entries.forEach(entry => {
      const card = document.createElement('div');
      card.className = 'entry-card';
      const latestVersion = entry.versions[entry.versions.length - 1];
      const label = extractLabel(entry.fieldName);
      card.innerHTML = `<div class="entry-meta"><span class="field-tag">${escapeHtml(label)}</span><span class="time-tag">${timeAgo(latestVersion.timestamp)} · ${escapeHtml(hostname)}</span></div><div class="snippet">${escapeHtml(latestVersion.text)}</div><div class="card-actions"><button class="btn-icon pin-btn" title="${entry.pinned ? 'Unpin' : 'Pin'}" aria-label="Pin ${escapeHtml(label)}">${entry.pinned ? '⭐' : '☆'}</button><button class="btn-icon history-btn" title="View version history" aria-label="View version history for ${escapeHtml(label)}">📜</button><button class="btn-icon delete-btn" title="Delete draft" aria-label="Delete draft ${escapeHtml(label)}">🗑️</button><button class="btn-primary restore-btn">Resurrect</button></div>`;
      card.querySelector('.restore-btn').addEventListener('click', () => sendRestoreToActiveTab(entry.fieldName, latestVersion.text));
      card.querySelector('.delete-btn').addEventListener('click', async (e) => { e.stopPropagation(); await deleteEntryById(entry.id); });
      card.querySelector('.history-btn').addEventListener('click', async (e) => { e.stopPropagation(); showVersionHistory(entry); });
      card.querySelector('.pin-btn').addEventListener('click', async (e) => { e.stopPropagation(); await togglePinEntry(entry.id); });
      entriesContainer.appendChild(card);
    });
  }
}

async function refreshEntries() {
  loadingSpinner.style.display = 'block';
  try {
    entriesContainer.innerHTML = '';
    if (lazarus_lock_active && !lazarus_unlocked) {
      entriesContainer.innerHTML = `<div class="empty-state"><div class="empty-icon">🔒</div><div class="empty-title">Vault Locked</div><div class="empty-desc">Enter your PIN to access saved texts.</div></div>`;
      return;
    }
    // Use showAll flag to decide whether to filter by current URL
    const filterUrl = showAll ? null : currentTabUrl;
    const allEntries = await loadEntries(filterUrl);
    const searchValue = searchInput?.value.toLowerCase().trim() || '';
    const filtered = allEntries.filter(e => {
      if (!searchValue) return true;
      const latest = e.versions[e.versions.length - 1].text.toLowerCase();
      const field = e.fieldName.toLowerCase();
      const url = e.pageUrl.toLowerCase();
      return field.includes(searchValue) || latest.includes(searchValue) || url.includes(searchValue);
    });
    if (!filtered.length) {
      entriesContainer.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No matching drafts</div></div>`;
      return;
    }
    filtered.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.versions[b.versions.length - 1].timestamp - a.versions[a.versions.length - 1].timestamp);
    const pageEntries = filtered.slice(0, currentPageSize);
    renderEntries(pageEntries);
    if (filtered.length > currentPageSize) {
      const showAllBtn = document.createElement('button');
      showAllBtn.className = 'btn-primary';
      showAllBtn.style.marginTop = '8px';
      showAllBtn.textContent = `Show all (${filtered.length} entries)`;
      showAllBtn.addEventListener('click', () => {
        renderEntries(filtered);
        showAllBtn.remove();
      });
      entriesContainer.appendChild(showAllBtn);
    }
  } catch (e) {
    console.error('[Lazarus] refreshEntries error:', e);
    showToast('Failed to load entries');
  } finally {
    loadingSpinner.style.display = 'none';
  }
}

async function deleteEntryById(entryId) {
  enqueue(async () => {
    const entries = await loadEntries(null);
    const filtered = entries.filter(e => e.id !== entryId);
    await saveEntries(filtered);
    await refreshEntries();
  });
}

async function togglePinEntry(entryId) {
  enqueue(async () => {
    const entries = await loadEntries(null);
    const entry = entries.find(e => e.id === entryId);
    if (entry) {
      entry.pinned = !entry.pinned;
      await saveEntries(entries);
      await refreshEntries();
    }
  });
}

async function promoteVersion(entryId, timestamp) {
  enqueue(async () => {
    const entries = await loadEntries(null);
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;
    const idx = entry.versions.findIndex(v => v.timestamp === timestamp);
    if (idx === -1) return;
    const [version] = entry.versions.splice(idx, 1);
    version.timestamp = Date.now();
    entry.versions.push(version);
    await saveEntries(entries);
    await refreshEntries();
  });
}

async function setLockPin(pin) {
  try {
    const saltBytes = new Uint8Array(16);
    crypto.getRandomValues(saltBytes);
    const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const hash = await deriveKey(pin, salt, 'verify');
    const encSaltBytes = new Uint8Array(16);
    crypto.getRandomValues(encSaltBytes);
    const encSalt = Array.from(encSaltBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    await browser.storage.local.set({
      lazarus_lock: true,
      lazarus_salt_storage: salt,
      lazarus_pin_hash_storage: hash,
      lazarus_enc_salt_storage: encSalt
    });
    lazarus_lock_active = true;
    lazarus_salt = salt;
    lazarus_pin_hash = hash;
    lazarus_enc_salt = encSalt;

    const newEncryptionKey = await deriveEncryptionKey(pin);
    const stored = await loadBlobFromBackground(null);
    let entries = [];

    if (stored) {
      if (stored.iv) {
        if (!encryptionKey) {
          throw new Error('Old encryption key missing. Please unlock the vault first.');
        }
        entries = await decryptBlob(stored);
        if (!entries) {
          throw new Error('Failed to decrypt existing data. Incorrect old PIN?');
        }
      } else {
        entries = stored;
      }
    }

    encryptionKey = newEncryptionKey;
    const encrypted = await encryptBlob(entries);
    if (encrypted) {
      await saveBlobToBackground(encrypted);
      await storeEncryptionKeyInSession();
      await browser.runtime.sendMessage({ action: "setKey", key: await exportKeyString() });
    } else {
      throw new Error('Failed to encrypt data with new PIN.');
    }

    lazarus_unlocked = true;
    await browser.storage.session.set({ lazarus_session_unlocked: true });
    updateLockButtonText();
    applySettingsToUI();
  } catch (e) {
    showToast('Failed to set PIN: ' + e.message);
    throw e;
  }
}

async function clearLock(pin) {
  try {
    if (!(await verifyPin(pin))) return false;
    encryptionKey = await deriveEncryptionKey(pin);
    if (!encryptionKey) return false;
    const stored = await loadBlobFromBackground(null);
    if (!stored || !stored.iv) return false;
    const entries = await decryptBlob(stored);
    if (!entries) return false;
    await saveBlobToBackground(entries);
    await browser.storage.local.set({
      lazarus_lock: false,
      lazarus_salt_storage: null,
      lazarus_pin_hash_storage: null,
      lazarus_enc_salt_storage: null
    });
    lazarus_lock_active = false;
    lazarus_salt = null;
    lazarus_pin_hash = null;
    lazarus_enc_salt = null;
    encryptionKey = null;
    await browser.storage.session.set({ lazarus_encryption_key: null, lazarus_session_unlocked: false });
    await browser.runtime.sendMessage({ action: "clearKey" });
    lazarus_unlocked = false;
    updateLockButtonText();
    applySettingsToUI();
    return true;
  } catch (e) {
    showToast('Failed to clear PIN: ' + e.message);
    return false;
  }
}

async function exportKeyString() {
  if (!encryptionKey) return null;
  const rawKey = await crypto.subtle.exportKey("raw", encryptionKey);
  return Array.from(new Uint8Array(rawKey)).map(b => b.toString(16).padStart(2, '0')).join('');
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

async function ensureRestorePermission() {
  if (!cachedSettings.restoreRequiresPassword) return true;
  if (!lazarus_lock_active) return true;
  const { lazarus_session_unlocked } = await browser.storage.session.get("lazarus_session_unlocked");
  if (lazarus_session_unlocked) return true;
  return new Promise(resolve => showPinModal('verify', resolve));
}

async function sendRestoreToActiveTab(fieldName, text) {
  if (!(await ensureRestorePermission())) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  browser.tabs.sendMessage(tab.id, { action: "restoreText", data: { fieldName, text } }).catch(() => {});
}

async function showVersionHistory(entry) {
  const modal = document.createElement('div');
  modal.className = 'version-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', `Version history for ${extractLabel(entry.fieldName)}`);
  modal.innerHTML = `<div class="version-modal-content"><div class="version-header"><span class="field-tag">${escapeHtml(extractLabel(entry.fieldName))}</span><button class="btn-icon close-modal" aria-label="Close version history">✖</button></div><div class="version-list"></div></div>`;
  document.body.appendChild(modal);
  const list = modal.querySelector('.version-list');
  entry.versions.slice().reverse().forEach(version => {
    const row = document.createElement('div');
    row.className = 'version-row';
    row.innerHTML = `<span class="time-tag">${timeAgo(version.timestamp)}</span><span class="version-snippet">${escapeHtml(version.text.slice(0, 60))}</span><button class="btn-primary small restore-btn">Restore</button><button class="btn-primary small promote-btn">Set as current</button>`;
    row.querySelector('.restore-btn').addEventListener('click', async () => { if (!(await ensureRestorePermission())) return; sendRestoreToActiveTab(entry.fieldName, version.text); modal.remove(); });
    row.querySelector('.promote-btn').addEventListener('click', async () => { await promoteVersion(entry.id, version.timestamp); modal.remove(); });
    list.appendChild(row);
  });
  modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

async function resurrectFullForm() {
  if (lazarus_lock_active && !lazarus_unlocked) return;
  if (!(await ensureRestorePermission())) return;
  try {
    const entries = await loadEntries(null);
    const payload = entries.map(e => ({ fieldName: e.fieldName, text: e.versions[e.versions.length - 1].text }));
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) browser.tabs.sendMessage(tab.id, { action: "restoreAllTexts", data: payload }).catch(() => {});
  } catch (e) {
    showToast('Failed to resurrect: ' + e.message);
  }
}

async function toggleBlacklist() {
  try {
    const hostname = new URL(currentTabUrl).hostname;
    let { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
    let list = lazarus_blacklist || [];
    const index = list.indexOf(hostname);
    if (index > -1) list.splice(index, 1);
    else list.push(hostname);
    await browser.storage.local.set({ lazarus_blacklist: list });
    cachedBlacklist = list;
    updateBlacklistButton();
    browser.runtime.sendMessage({ action: "blacklist-changed" });
  } catch (e) {
    showToast('Failed to toggle blacklist: ' + e.message);
  }
}

function updateBlacklistButton() {
  const btn = $('blacklist-btn');
  if (!currentTabUrl) return;
  btn.textContent = isSiteBlacklisted() ? '🔇 Unsilence Site' : '🔕 Silence Site';
}

async function exportVault() {
  if (lazarus_lock_active && !lazarus_unlocked) return;
  if (!(await ensureRestorePermission())) return;
  enqueue(async () => {
    try {
      const entries = await loadEntries(null);
      const json = JSON.stringify(entries, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'lazarus_vault_export.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Vault exported successfully');
    } catch (e) {
      showToast('Export failed: ' + e.message);
    }
  });
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
      if (!imported.every(entry => entry.id && entry.fieldName && entry.pageUrl && Array.isArray(entry.versions))) throw new Error('Invalid entry structure');
      enqueue(async () => {
        const currentEntries = await loadEntries(null);
        const merged = currentEntries.concat(imported.filter(imp => !currentEntries.some(e => e.pageUrl === imp.pageUrl && e.fieldName === imp.fieldName)));
        await saveEntries(merged);
        await refreshEntries();
        showToast('Vault imported successfully');
      });
    } catch (e) {
      showToast('Error: ' + e.message);
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
  let showConfirm = false;
  let showCurrent = false;
  if (mode === 'set') {
    title = 'Set PIN';
    showConfirm = true;
  } else if (mode === 'unlock-session') {
    title = 'Unlock Session';
  } else if (mode === 'clear') {
    title = 'Delete PIN – Enter PIN';
  } else if (mode === 'change') {
    title = 'Change PIN';
    showCurrent = true;
    showConfirm = true;
  }
  modal.innerHTML = `<div class="pin-modal-content"><div class="pin-header"><span class="field-tag">${title}</span><button class="btn-icon close-modal" aria-label="Close">✖</button></div>${showCurrent ? '<input type="password" class="search-input pin-current" placeholder="Current PIN" aria-label="Current PIN" style="margin-bottom:8px;">' : ''}<input type="password" class="search-input pin-input" placeholder="Enter PIN" aria-label="PIN" style="margin-bottom:8px;">${showConfirm ? '<input type="password" class="search-input pin-confirm" placeholder="Confirm PIN" aria-label="Confirm PIN" style="margin-bottom:8px;">' : ''}<div class="error-text pin-error">${mode === 'set' ? 'PINs do not match' : 'Invalid PIN'}</div><button class="btn-primary pin-submit" style="margin-top:8px;">${mode === 'set' ? 'Set' : (mode === 'clear' ? 'Delete' : (mode === 'change' ? 'Change' : 'Verify'))}</button></div>`;
  document.body.appendChild(modal);
  const closeBtn = modal.querySelector('.close-modal');
  const submitBtn = modal.querySelector('.pin-submit');
  const inputField = modal.querySelector('.pin-input');
  const confirmField = modal.querySelector('.pin-confirm');
  const currentField = modal.querySelector('.pin-current');
  const errorDiv = modal.querySelector('.pin-error');
  closeBtn.addEventListener('click', () => { modal.remove(); if (callback) callback(false); });
  modal.addEventListener('click', (e) => { if (e.target === modal) { modal.remove(); if (callback) callback(false); } });
  (currentField || inputField).focus();

  function submit() {
    const pin = inputField.value.trim();
    if (!pin) return;
    if (mode === 'set') {
      const confirm = confirmField.value.trim();
      if (pin !== confirm) { errorDiv.style.display = 'block'; return; }
      errorDiv.style.display = 'none';
      (async () => {
        try {
          await setLockPin(pin);
          updateLockButtonText();
          applySettingsToUI();
          lockScreen.style.display = 'none';
          mainUi.style.display = 'flex';
          modal.remove();
          refreshEntries();
          if (callback) callback(true);
        } catch (e) {
          errorDiv.textContent = 'Failed to set PIN. ' + e.message;
          errorDiv.style.display = 'block';
          if (callback) callback(false);
        }
      })();
    } else if (mode === 'change') {
      const current = currentField.value.trim();
      if (!current) { errorDiv.textContent = 'Please enter current PIN.'; errorDiv.style.display = 'block'; return; }
      const confirm = confirmField.value.trim();
      if (pin !== confirm) { errorDiv.textContent = 'New PINs do not match.'; errorDiv.style.display = 'block'; return; }
      errorDiv.style.display = 'none';
      (async () => {
        try {
          if (!(await verifyPin(current))) {
            errorDiv.textContent = 'Current PIN is incorrect.';
            errorDiv.style.display = 'block';
            if (callback) callback(false);
            return;
          }
          const oldKey = await deriveEncryptionKey(current);
          if (!oldKey) {
            errorDiv.textContent = 'Failed to derive encryption key.';
            errorDiv.style.display = 'block';
            if (callback) callback(false);
            return;
          }
          encryptionKey = oldKey;
          await setLockPin(pin);
          updateLockButtonText();
          applySettingsToUI();
          lockScreen.style.display = 'none';
          mainUi.style.display = 'flex';
          modal.remove();
          refreshEntries();
          if (callback) callback(true);
        } catch (e) {
          errorDiv.textContent = 'Failed to change PIN. ' + e.message;
          errorDiv.style.display = 'block';
          if (callback) callback(false);
        }
      })();
    } else if (mode === 'verify' || mode === 'unlock-session') {
      verifyPin(pin).then(valid => {
        if (valid) {
          deriveEncryptionKey(pin).then(async (key) => {
            if (!key) {
              errorDiv.textContent = 'Failed to derive encryption key.';
              errorDiv.style.display = 'block';
              if (callback) callback(false);
              return;
            }
            encryptionKey = key;
            await storeEncryptionKeyInSession();
            await browser.runtime.sendMessage({ action: "setKey", key: await exportKeyString() });
            lazarus_unlocked = true;
            await browser.storage.session.set({ lazarus_session_unlocked: true });
            updateLockButtonText();
            applySettingsToUI();
            lockScreen.style.display = 'none';
            mainUi.style.display = 'flex';
            modal.remove();
            refreshEntries();
            if (callback) callback(true);
          });
        } else { errorDiv.style.display = 'block'; if (callback) callback(false); }
      });
    } else if (mode === 'clear') {
      clearLock(pin).then(success => {
        if (success) {
          lazarus_unlocked = false;
          updateLockButtonText();
          applySettingsToUI();
          modal.remove();
          refreshEntries();
          if (callback) callback(true);
        } else { errorDiv.style.display = 'block'; if (callback) callback(false); }
      });
    }
  }

  submitBtn.addEventListener('click', submit);
  inputField.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  if (confirmField) {
    confirmField.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    confirmField.addEventListener('input', () => { errorDiv.style.display = 'none'; });
  }
  if (currentField) {
    currentField.addEventListener('keydown', (e) => { if (e.key === 'Enter') { (inputField || confirmField).focus(); } });
  }
}

let searchDebounceTimer;
function debouncedRefresh() { clearTimeout(searchDebounceTimer); searchDebounceTimer = setTimeout(refreshEntries, 200); }

async function init() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tab?.url || '';
    await loadBlacklist();
    await loadLockState();
    await loadSettings();
    await loadEncryptionKeyFromSession();
    const { lazarus_session_unlocked } = await browser.storage.session.get("lazarus_session_unlocked");
    if (lazarus_session_unlocked) {
      lazarus_unlocked = true;
      if (!encryptionKey && lazarus_enc_salt) {
        showPinModal('unlock-session');
      }
    }
    if (lazarus_lock_active && !lazarus_unlocked) {
      lockScreen.style.display = 'flex';
      mainUi.style.display = 'none';
    } else {
      lockScreen.style.display = 'none';
      mainUi.style.display = 'flex';
    }
    updateLockButtonText();
    applySettingsToUI();
    if (currentTabUrl) { updateBlacklistButton(); }
    $('tab-site').addEventListener('click', () => { showAll = false; $('tab-site').classList.add('active'); $('tab-all').classList.remove('active'); refreshEntries(); });
    $('tab-all').addEventListener('click', () => { showAll = true; $('tab-all').classList.add('active'); $('tab-site').classList.remove('active'); refreshEntries(); });
    searchInput.addEventListener('input', debouncedRefresh);
    $('resurrect-all-btn').addEventListener('click', resurrectFullForm);
    $('blacklist-btn').addEventListener('click', toggleBlacklist);
    $('export-btn').addEventListener('click', exportVault);
    $('import-btn').addEventListener('click', importVault);
    $('toggle-donate').addEventListener('click', (e) => { e.preventDefault(); donateModal.style.display = donateModal.style.display === 'none' || !donateModal.style.display ? 'flex' : 'none'; settingsModal.style.display = 'none'; });
    $('settings-btn').addEventListener('click', () => { if (settingsModal.style.display === 'none' || !settingsModal.style.display) { settingsModal.style.display = 'flex'; donateModal.style.display = 'none'; } else { settingsModal.style.display = 'none'; } });
    $('settings-close-btn').addEventListener('click', () => { settingsModal.style.display = 'none'; });
    $('save-settings').addEventListener('click', saveSettingsToStorage);
    $('setting-delete-pin').addEventListener('click', () => { showPinModal('clear'); });
    $('setting-change-pin').addEventListener('click', () => { showPinModal('change'); });
    lockBtn.addEventListener('click', () => {
      enqueue(async () => {
        if (lazarus_lock_active) {
          if (lazarus_unlocked) {
            const entries = await loadEntries(null);
            const encrypted = await encryptBlob(entries);
            if (encrypted) {
              await saveBlobToBackground(encrypted);
            }
            lazarus_unlocked = false;
            encryptionKey = null;
            await browser.storage.session.set({ lazarus_session_unlocked: false, lazarus_encryption_key: null });
            await browser.runtime.sendMessage({ action: "clearKey" });
            updateLockButtonText();
            applySettingsToUI();
            lockScreen.style.display = 'flex';
            mainUi.style.display = 'none';
          } else {
            showPinModal('unlock-session');
          }
        } else {
          showPinModal('set');
        }
      });
    });
    $('unlock-btn')?.addEventListener('click', async () => {
      const pinInput = $('pin-input');
      const pinError = $('pin-error');
      pinError.style.display = 'none';
      const pin = pinInput.value.trim();
      if (!pin) return;
      if (await verifyPin(pin)) {
        encryptionKey = await deriveEncryptionKey(pin);
        if (!encryptionKey) {
          pinError.textContent = 'Failed to derive encryption key.';
          pinError.style.display = 'block';
          return;
        }
        await storeEncryptionKeyInSession();
        await browser.runtime.sendMessage({ action: "setKey", key: await exportKeyString() });
        lazarus_unlocked = true;
        await browser.storage.session.set({ lazarus_session_unlocked: true });
        updateLockButtonText();
        applySettingsToUI();
        lockScreen.style.display = 'none';
        mainUi.style.display = 'flex';
        refreshEntries();
      } else { pinError.style.display = 'block'; }
    });
    $('pin-input')?.addEventListener('input', () => { $('pin-error').style.display = 'none'; });

    document.querySelectorAll('.download-qr').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = document.createElement('a');
        a.download = btn.dataset.name;
        a.href = btn.dataset.src;
        a.click();
      });
    });
    document.querySelectorAll('.copy-address').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.address).then(() => {
          const orig = btn.textContent;
          btn.textContent = '✓ Copied';
          setTimeout(() => btn.textContent = orig, 1500);
        });
      });
    });

    await refreshEntries();
  } catch (e) {
    console.error('[Lazarus] Init error:', e);
    showToast('Failed to initialize Lazarus');
  }
}

init();