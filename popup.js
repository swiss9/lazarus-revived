const browser = globalThis.browser || globalThis.chrome;

let showAll = false;
let currentTabUrl = '';
let currentTabId = null;
let lazarus_lock_active = false;
let lazarus_unlocked = false;
let lazarus_salt = null;
let lazarus_pin_hash = null;
let lazarus_encryption_key = null;
let cachedBlacklist = [];
let cachedSettings = {
  savePasswords: false,
  retentionHours: 720,
  restoreRequiresPassword: false,
  searchIndexing: true,
  minChar: 4,
  captureRich: true,
  autoPurge: false,
  showBadge: true
};
let displayLimit = 20;
let displayOffset = 0;

const $ = id => document.getElementById(id);
const entryList = $('entry-list');
const filterInput = $('filter-input');
const tabCurrent = $('tab-current');
const tabAll = $('tab-all');
const currentBadge = $('current-badge');
const allBadge = $('all-badge');
const emptyState = $('empty-state');
const lockOverlay = $('lock-overlay');
const lockPinInput = $('lock-pin-input');
const lockUnlockBtn = $('lock-unlock-btn');
const lockError = $('lock-error');
const headerTitle = $('header-title');
const settingsToggleBtn = $('settings-toggle-btn');
const viewMain = $('view-main');
const viewSettings = $('view-settings');
const saveSettingsBtn = $('save-settings-btn');
const exportBtn = $('export-btn');
const importBtn = $('import-btn');
const importFileInput = $('import-file-input');
const cryptoBtn = $('crypto-btn');
const cryptoModal = $('crypto-modal');
const cryptoModalClose = $('crypto-modal-close');
const domainTagsContainer = $('domain-tags-container');
const newDomainInput = $('new-domain-input');
const addDomainBtn = $('add-domain-btn');

const settingSavePasswords = $('setting-savePasswords');
const settingRestoreRequiresPassword = $('setting-restoreRequiresPassword');
const settingRetentionHours = $('setting-retentionHours');
const settingMinChar = $('setting-minChar');
const settingCaptureRich = $('setting-captureRich');
const settingAutoPurge = $('setting-autoPurge');
const settingSearchIndexing = $('setting-searchIndexing');
const settingShowBadge = $('setting-showBadge');
const settingCurrentPin = $('setting-current-pin');
const settingNewPin = $('setting-new-pin');
const settingConfirmPin = $('setting-confirm-pin');
const settingSetPinBtn = $('setting-set-pin-btn');
const settingClearPin = $('setting-clear-pin');
const pinStatus = $('pin-status');

function showToast(msg) {
  const toast = $('toast');
  $('toastMsg').textContent = msg;
  $('toastUndo').style.display = 'none';
  toast.classList.add('visible');
  clearTimeout(window.toastTimeout);
  window.toastTimeout = setTimeout(() => toast.classList.remove('visible'), 3000);
}

async function deriveKey(pin, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function derivePinHash(pin, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPin(pin) {
  if (!lazarus_salt || !lazarus_pin_hash) return false;
  const hash = await derivePinHash(pin, lazarus_salt);
  return hash === lazarus_pin_hash;
}

async function setLockPin(pin) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await derivePinHash(pin, salt);
  const key = await deriveKey(pin, salt);
  await browser.storage.local.set({
    lazarus_lock: true,
    lazarus_salt_storage: salt,
    lazarus_pin_hash_storage: hash
  });
  lazarus_lock_active = true;
  lazarus_salt = salt;
  lazarus_pin_hash = hash;
  lazarus_unlocked = true;
  lazarus_encryption_key = key;
  await browser.storage.session.set({ lazarus_session_unlocked: true });
  const rawKey = await crypto.subtle.exportKey('raw', key);
  await browser.storage.session.set({ lazarus_encryption_key_raw: Array.from(new Uint8Array(rawKey)) });
  await browser.runtime.sendMessage({ action: 'setEncryptionKey', key: key });
  updateLockUI();
  updatePinUI();
  showToast('PIN set successfully.');
}

async function clearLock(pin) {
  if (!await verifyPin(pin)) {
    showToast('Incorrect PIN.');
    return false;
  }
  await browser.storage.local.remove(['lazarus_lock', 'lazarus_salt_storage', 'lazarus_pin_hash_storage']);
  await browser.storage.session.set({
    lazarus_session_unlocked: false,
    lazarus_encryption_key_raw: null
  });
  await browser.runtime.sendMessage({ action: 'clearEncryptionKey' });
  lazarus_lock_active = false;
  lazarus_unlocked = false;
  lazarus_salt = null;
  lazarus_pin_hash = null;
  lazarus_encryption_key = null;
  updateLockUI();
  updatePinUI();
  showToast('Lock removed.');
  return true;
}

async function unlockVault(pin) {
  if (!await verifyPin(pin)) return false;
  const key = await deriveKey(pin, lazarus_salt);
  lazarus_unlocked = true;
  lazarus_encryption_key = key;
  await browser.storage.session.set({ lazarus_session_unlocked: true });
  const rawKey = await crypto.subtle.exportKey('raw', key);
  await browser.storage.session.set({ lazarus_encryption_key_raw: Array.from(new Uint8Array(rawKey)) });
  await browser.runtime.sendMessage({ action: 'setEncryptionKey', key: key });
  updateLockUI();
  refreshEntries();
  return true;
}

lockUnlockBtn.addEventListener('click', async () => {
  const pin = lockPinInput.value.trim();
  if (!pin) { lockError.textContent = 'Please enter PIN.'; return; }
  lockError.textContent = '';
  if (await unlockVault(pin)) {
    lockPinInput.value = '';
    showToast('Vault unlocked');
  } else {
    lockError.textContent = 'Incorrect PIN.';
    lockPinInput.value = '';
    lockPinInput.focus();
  }
});
lockPinInput.addEventListener('keydown', e => { if (e.key === 'Enter') lockUnlockBtn.click(); });

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.lazarus_session_unlocked) {
    const newVal = changes.lazarus_session_unlocked.newValue;
    if (newVal) {
      lazarus_unlocked = true;
      updateLockUI();
      refreshEntries();
    } else {
      lazarus_unlocked = false;
      lazarus_encryption_key = null;
      updateLockUI();
    }
  }
  if (area === 'local') {
    if (changes.lazarus_settings) {
      cachedSettings = { ...cachedSettings, ...(changes.lazarus_settings.newValue || {}) };
      applySettingsToUI();
    }
    if (changes.lazarus_blacklist) {
      cachedBlacklist = changes.lazarus_blacklist.newValue || [];
      renderDomainTags(cachedBlacklist);
    }
    if (changes.lazarus_lock || changes.lazarus_salt_storage || changes.lazarus_pin_hash_storage) {
      loadLockState();
    }
  }
});

async function loadLockState() {
  const { lazarus_lock, lazarus_salt_storage, lazarus_pin_hash_storage } = await browser.storage.local.get([
    'lazarus_lock', 'lazarus_salt_storage', 'lazarus_pin_hash_storage'
  ]);
  lazarus_lock_active = lazarus_lock === true;
  lazarus_salt = lazarus_salt_storage || null;
  lazarus_pin_hash = lazarus_pin_hash_storage || null;
  const { lazarus_session_unlocked } = await browser.storage.session.get('lazarus_session_unlocked');
  lazarus_unlocked = lazarus_session_unlocked === true;
  if (lazarus_unlocked) {
    const { lazarus_encryption_key_raw } = await browser.storage.session.get('lazarus_encryption_key_raw');
    if (lazarus_encryption_key_raw) {
      try {
        const key = await crypto.subtle.importKey(
          'raw',
          new Uint8Array(lazarus_encryption_key_raw),
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        await browser.runtime.sendMessage({ action: 'setEncryptionKey', key: key });
        lazarus_encryption_key = key;
      } catch {}
    }
  }
  updateLockUI();
  updatePinUI();
}

function updateLockUI() {
  const locked = lazarus_lock_active && !lazarus_unlocked;
  lockOverlay.classList.toggle('active', locked);
  if (locked) lockPinInput.focus();
}

function updatePinUI() {
  if (lazarus_lock_active) {
    pinStatus.textContent = 'PIN is set.';
    settingCurrentPin.placeholder = 'Current PIN';
    settingCurrentPin.disabled = false;
    settingNewPin.disabled = false;
    settingConfirmPin.disabled = false;
    settingSetPinBtn.textContent = 'Change PIN';
    settingClearPin.style.display = 'inline-block';
  } else {
    pinStatus.textContent = 'No PIN set.';
    settingCurrentPin.placeholder = '(none)';
    settingCurrentPin.disabled = true;
    settingCurrentPin.value = '';
    settingNewPin.disabled = false;
    settingConfirmPin.disabled = false;
    settingSetPinBtn.textContent = 'Set PIN';
    settingClearPin.style.display = 'none';
  }
}

async function loadSettings() {
  const { lazarus_settings } = await browser.storage.local.get('lazarus_settings');
  cachedSettings = { ...cachedSettings, ...(lazarus_settings || {}) };
  applySettingsToUI();
}

function applySettingsToUI() {
  settingSavePasswords.checked = cachedSettings.savePasswords;
  settingRestoreRequiresPassword.checked = cachedSettings.restoreRequiresPassword;
  settingRetentionHours.value = cachedSettings.retentionHours;
  settingMinChar.value = cachedSettings.minChar || 4;
  settingCaptureRich.checked = cachedSettings.captureRich !== false;
  settingAutoPurge.checked = cachedSettings.autoPurge || false;
  settingSearchIndexing.checked = cachedSettings.searchIndexing;
  settingShowBadge.checked = cachedSettings.showBadge !== false;
  filterInput.style.display = cachedSettings.searchIndexing ? '' : 'none';
  updatePinUI();
}

async function saveSettingsToStorage() {
  const newSettings = {
    savePasswords: settingSavePasswords.checked,
    retentionHours: parseInt(settingRetentionHours.value, 10) || 0,
    restoreRequiresPassword: settingRestoreRequiresPassword.checked,
    searchIndexing: settingSearchIndexing.checked,
    minChar: parseInt(settingMinChar.value, 10) || 4,
    captureRich: settingCaptureRich.checked,
    autoPurge: settingAutoPurge.checked,
    showBadge: settingShowBadge.checked
  };
  await browser.storage.local.set({ lazarus_settings: newSettings });
  cachedSettings = newSettings;
  applySettingsToUI();
  await syncBlacklistFromUI();
  refreshEntries();
  showToast('Settings saved');
}

settingSetPinBtn.addEventListener('click', async () => {
  const current = settingCurrentPin.value.trim();
  const newPin = settingNewPin.value.trim();
  const confirm = settingConfirmPin.value.trim();

  if (lazarus_lock_active) {
    if (!current || current.length < 4) {
      showToast('Please enter your current PIN (min 4 chars).');
      return;
    }
    if (!await verifyPin(current)) {
      showToast('Current PIN is incorrect.');
      return;
    }
    if (!newPin || newPin.length < 4) {
      showToast('New PIN must be at least 4 characters.');
      return;
    }
    if (newPin !== confirm) {
      showToast('New PINs do not match.');
      return;
    }
    await browser.storage.local.remove(['lazarus_lock', 'lazarus_salt_storage', 'lazarus_pin_hash_storage']);
    await setLockPin(newPin);
    settingCurrentPin.value = '';
    settingNewPin.value = '';
    settingConfirmPin.value = '';
    showToast('PIN changed successfully.');
  } else {
    if (!newPin || newPin.length < 4) {
      showToast('PIN must be at least 4 characters.');
      return;
    }
    if (newPin !== confirm) {
      showToast('PINs do not match.');
      return;
    }
    await setLockPin(newPin);
    settingNewPin.value = '';
    settingConfirmPin.value = '';
    showToast('PIN set successfully.');
  }
  updatePinUI();
  refreshEntries();
});

settingClearPin.addEventListener('click', async () => {
  if (!lazarus_lock_active) return;
  const current = settingCurrentPin.value.trim();
  if (!current) {
    showToast('Please enter your current PIN to remove the lock.');
    return;
  }
  if (!await verifyPin(current)) {
    showToast('Incorrect PIN.');
    return;
  }
  if (confirm('Remove PIN lock? All data will remain stored unencrypted.')) {
    await clearLock(current);
    settingCurrentPin.value = '';
    updatePinUI();
    refreshEntries();
  }
});

function showView(view) {
  if (view === 'settings') {
    viewMain.classList.add('hidden');
    viewSettings.classList.remove('hidden');
    settingsToggleBtn.classList.add('active');
    headerTitle.textContent = 'SETTINGS';
  } else {
    viewMain.classList.remove('hidden');
    viewSettings.classList.add('hidden');
    settingsToggleBtn.classList.remove('active');
    headerTitle.textContent = 'LAZARUS';
  }
}
settingsToggleBtn.addEventListener('click', () => {
  const isSettings = !viewSettings.classList.contains('hidden');
  showView(isSettings ? 'main' : 'settings');
});

saveSettingsBtn.addEventListener('click', saveSettingsToStorage);

async function loadBlacklist() {
  const { lazarus_blacklist } = await browser.storage.local.get('lazarus_blacklist');
  cachedBlacklist = lazarus_blacklist || [];
  renderDomainTags(cachedBlacklist);
}

function getBlacklistFromUI() {
  const tags = document.querySelectorAll('#domain-tags-container .domain-tag:not(.removed)');
  return Array.from(tags).map(tag => tag.dataset.domain);
}

async function syncBlacklistFromUI() {
  const list = getBlacklistFromUI();
  await browser.storage.local.set({ lazarus_blacklist: list });
  cachedBlacklist = list;
  browser.runtime.sendMessage({ action: 'blacklist-changed' });
}

function renderDomainTags(blacklist) {
  domainTagsContainer.innerHTML = '';
  (blacklist || []).forEach(domain => {
    const tag = document.createElement('div');
    tag.className = 'domain-tag';
    tag.dataset.domain = domain;
    tag.innerHTML = `<span>${domain}</span><button class="tag-action-btn" title="Remove">✕</button>`;
    tag.querySelector('.tag-action-btn').addEventListener('click', () => {
      tag.classList.toggle('removed');
    });
    domainTagsContainer.appendChild(tag);
  });
}

addDomainBtn.addEventListener('click', () => {
  const val = newDomainInput.value.trim().toLowerCase();
  if (val && !document.querySelector(`#domain-tags-container .domain-tag[data-domain="${val}"]`)) {
    const tag = document.createElement('div');
    tag.className = 'domain-tag';
    tag.dataset.domain = val;
    tag.innerHTML = `<span>${val}</span><button class="tag-action-btn" title="Remove">✕</button>`;
    tag.querySelector('.tag-action-btn').addEventListener('click', () => {
      tag.classList.toggle('removed');
    });
    domainTagsContainer.appendChild(tag);
    newDomainInput.value = '';
  }
});
newDomainInput.addEventListener('keydown', e => { if (e.key === 'Enter') addDomainBtn.click(); });

async function ensureRestorePermission() {
  if (!cachedSettings.restoreRequiresPassword) return true;
  if (!lazarus_lock_active) return true;
  if (lazarus_unlocked) return true;
  updateLockUI();
  return new Promise((resolve) => {
    const listener = (changes, area) => {
      if (area === 'session' && changes.lazarus_session_unlocked?.newValue === true) {
        browser.storage.onChanged.removeListener(listener);
        resolve(true);
      }
    };
    browser.storage.onChanged.addListener(listener);
    setTimeout(() => {
      browser.storage.onChanged.removeListener(listener);
      resolve(false);
    }, 30000);
  });
}

async function sendRestoreToActiveTab(fieldName, text) {
  if (!(await ensureRestorePermission())) return;
  const tabId = await getActiveTabId();
  if (!tabId) return;
  browser.tabs.sendMessage(tabId, {
    action: 'restoreText',
    data: { fieldName, text }
  }).catch(() => showToast('Restore failed.'));
}

async function togglePin(entryId) {
  await browser.runtime.sendMessage({ action: 'togglePin', entryId });
  refreshEntries();
}

async function deleteEntry(entryId) {
  await browser.runtime.sendMessage({ action: 'deleteEntry', entryId });
  refreshEntries();
}

async function showVersionHistory(entry) {
  const modal = document.createElement('div');
  modal.className = 'version-modal';
  modal.innerHTML = `
    <div class="version-modal-content">
      <div class="version-header">
        <span class="field-tag">${escapeHtml(entry.fieldName)}</span>
        <button class="close-btn-icon" data-close>✖</button>
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
      <button class="btn-primary restore-btn">Restore</button>
      <button class="btn-secondary promote-btn">Set current</button>
    `;
    row.querySelector('.restore-btn').addEventListener('click', async () => {
      if (!(await ensureRestorePermission())) return;
      sendRestoreToActiveTab(entry.fieldName, version.text);
      modal.remove();
    });
    row.querySelector('.promote-btn').addEventListener('click', async () => {
      await browser.runtime.sendMessage({
        action: 'promoteVersion',
        entryId: entry.id,
        timestamp: version.timestamp
      });
      modal.remove();
      refreshEntries();
    });
    list.appendChild(row);
  });
  modal.querySelector('[data-close]').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

function getDomain(entry) {
  try { return new URL(entry.pageUrl).hostname.replace('www.', ''); } catch { return entry.pageUrl; }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

async function getEntriesFromStorage() {
  try {
    const resp = await browser.runtime.sendMessage({
      action: 'getSavedData',
      currentTabUrl: showAll ? null : currentTabUrl
    });
    return resp.entries || [];
  } catch { return []; }
}

async function getActiveTabId() {
  if (currentTabId) return currentTabId;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;
  currentTabUrl = tab?.url || '';
  return currentTabId;
}

function renderEntries(entries, append = false) {
  if (!append) {
    entryList.innerHTML = '';
    displayOffset = 0;
  }
  const slice = entries.slice(displayOffset, displayOffset + displayLimit);
  slice.forEach(entry => {
    const latest = entry.versions[entry.versions.length - 1];
    const hostname = getDomain(entry);
    const fieldLabel = entry.fieldName.split('>').pop().trim() || entry.fieldName;
    const card = document.createElement('div');
    card.className = `item-row${entry.pinned ? ' pinned' : ''}`;
    card.dataset.id = entry.id;
    card.innerHTML = `
      <div class="item-header">
        <div class="site-info">
          <img class="site-icon" src="https://www.google.com/s2/favicons?domain=${hostname}&sz=32" alt="${hostname}">
          <span class="site-domain">${hostname}</span>
        </div>
        <div class="item-meta">${timeAgo(latest.timestamp)}</div>
      </div>
      <div class="field-target">${escapeHtml(fieldLabel)}</div>
      <div class="item-snippet">${escapeHtml(latest.text)}</div>
      <div class="action-bar">
        <button class="action-btn primary" data-action="restore">Restore</button>
        <button class="action-btn secondary" data-action="copy">Copy</button>
        <button class="action-btn danger" data-action="delete">Purge</button>
        <button class="action-btn secondary" data-action="pin" style="flex:0.4;">
          <span class="pin-indicator">${entry.pinned ? '⭐' : '☆'}</span>
        </button>
        <button class="action-btn secondary" data-action="history" style="flex:0.4;">📜</button>
      </div>
    `;
    entryList.appendChild(card);

    card.querySelector('[data-action="restore"]').addEventListener('click', (e) => {
      e.stopPropagation();
      sendRestoreToActiveTab(entry.fieldName, latest.text);
    });
    card.querySelector('[data-action="copy"]').addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(latest.text).catch(() => showToast('Copy failed.'));
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteEntry(entry.id);
    });
    card.querySelector('[data-action="pin"]').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(entry.id);
    });
    card.querySelector('[data-action="history"]').addEventListener('click', (e) => {
      e.stopPropagation();
      showVersionHistory(entry);
    });
    card.addEventListener('click', () => {
      sendRestoreToActiveTab(entry.fieldName, latest.text);
    });
  });

  const remaining = entries.length - (displayOffset + displayLimit);
  if (remaining > 0 && !append) {
    const loadMore = document.createElement('div');
    loadMore.className = 'load-more-btn';
    loadMore.textContent = `Load ${Math.min(remaining, displayLimit)} more`;
    loadMore.style.cssText = 'padding:8px; text-align:center; color: var(--text-muted); cursor:pointer; border-top:1px solid var(--border-subtle);';
    loadMore.addEventListener('click', () => {
      displayOffset += displayLimit;
      renderEntries(entries, true);
    });
    entryList.appendChild(loadMore);
  }
}

async function refreshEntries() {
  if (lazarus_lock_active && !lazarus_unlocked) {
    entryList.innerHTML = '';
    emptyState.style.display = 'flex';
    document.body.classList.add('popup-empty');
    currentBadge.textContent = '0';
    allBadge.textContent = '0';
    return;
  }

  const searchValue = filterInput.value.toLowerCase().trim();
  const resp = await browser.runtime.sendMessage({
    action: 'getSavedData',
    currentTabUrl: showAll ? null : currentTabUrl
  });
  const entries = resp.entries || [];
  const filtered = entries.filter(e => {
    if (!searchValue) return true;
    const latest = e.versions[e.versions.length - 1].text.toLowerCase();
    return e.fieldName.toLowerCase().includes(searchValue) ||
           latest.includes(searchValue) ||
           e.pageUrl.toLowerCase().includes(searchValue);
  });

  const allEntries = entries || [];
  const currentEntries = allEntries.filter(e => e.pageUrl === currentTabUrl);
  currentBadge.textContent = currentEntries.length;
  allBadge.textContent = allEntries.length;

  if (filtered.length === 0) {
    entryList.innerHTML = '';
    emptyState.style.display = 'flex';
    document.body.classList.add('popup-empty');
    return;
  }
  emptyState.style.display = 'none';
  document.body.classList.remove('popup-empty');

  filtered.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
                           b.versions[b.versions.length - 1].timestamp -
                           a.versions[a.versions.length - 1].timestamp);
  renderEntries(filtered, false);
}

tabCurrent.addEventListener('click', () => {
  showAll = false;
  tabCurrent.classList.add('active');
  tabAll.classList.remove('active');
  refreshEntries();
});
tabAll.addEventListener('click', () => {
  showAll = true;
  tabAll.classList.add('active');
  tabCurrent.classList.remove('active');
  refreshEntries();
});

filterInput.addEventListener('input', refreshEntries);

async function encryptExportData(plaintext) {
  if (!lazarus_encryption_key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    lazarus_encryption_key,
    encoded
  );
  return {
    encrypted: true,
    data: {
      iv: Array.from(iv),
      ciphertext: Array.from(new Uint8Array(ciphertext))
    }
  };
}

exportBtn.addEventListener('click', async () => {
  if (lazarus_lock_active && !lazarus_unlocked) {
    showToast('Vault is locked. Please unlock first.');
    return;
  }
  const { entries } = await browser.runtime.sendMessage({ action: 'getExportData' });
  const json = JSON.stringify(entries, null, 2);
  let exportData = json;
  let fileName = 'lazarus_vault_export.json';
  let mimeType = 'application/json';
  if (lazarus_encryption_key) {
    const encrypted = await encryptExportData(json);
    if (encrypted) {
      exportData = JSON.stringify(encrypted);
      fileName = 'lazarus_vault_export.encrypted.json';
      mimeType = 'application/json';
    }
  } else {
    if (!confirm('The exported file will contain all your saved form data in plain text. Are you sure you want to proceed?')) return;
  }
  const blob = new Blob([exportData], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Export saved.');
});

importBtn.addEventListener('click', () => importFileInput.click());
importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    let importedData = JSON.parse(text);
    let entries;
    if (importedData.encrypted) {
      if (!lazarus_lock_active) {
        showToast('Encrypted import requires a PIN set.');
        return;
      }
      if (!lazarus_unlocked) {
        showToast('Please unlock the vault first.');
        return;
      }
      if (!lazarus_encryption_key) {
        showToast('Encryption key not available.');
        return;
      }
      const iv = new Uint8Array(importedData.data.iv);
      const ciphertext = new Uint8Array(importedData.data.ciphertext);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        lazarus_encryption_key,
        ciphertext
      );
      entries = JSON.parse(new TextDecoder().decode(plaintext));
    } else {
      entries = importedData;
    }
    if (!Array.isArray(entries)) throw new Error('Invalid format');
    for (const entry of entries) {
      if (!entry.id || typeof entry.pageUrl !== 'string' || typeof entry.fieldName !== 'string' ||
          !Array.isArray(entry.versions) || entry.versions.length === 0) {
        throw new Error('Invalid entry structure');
      }
    }
    const action = confirm(`Import ${entries.length} entries? Choose OK to merge, Cancel to replace all.`);
    await browser.runtime.sendMessage({
      action: 'importData',
      entries: entries,
      replace: !action
    });
    refreshEntries();
    showToast('Import successful.');
  } catch (e) {
    showToast('Invalid vault file: ' + e.message);
  }
  importFileInput.value = '';
});

cryptoBtn.addEventListener('click', () => cryptoModal.classList.add('active'));
cryptoModalClose.addEventListener('click', () => cryptoModal.classList.remove('active'));
cryptoModal.addEventListener('click', (e) => { if (e.target === cryptoModal) cryptoModal.classList.remove('active'); });

browser.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'blacklist-changed') {
    loadBlacklist();
  }
});

(async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;
  currentTabUrl = tab?.url || '';
  const hostname = new URL(currentTabUrl).hostname;
  document.getElementById('current-favicon').src = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  await loadBlacklist();
  await loadLockState();
  await loadSettings();
  updateLockUI();
  refreshEntries();
})();