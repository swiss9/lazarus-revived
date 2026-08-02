const browser = globalThis.browser || globalThis.chrome;

let lazarus_entries_cache = [];
let lazarus_lock_active = false;
let lazarus_unlocked = false;
let lazarus_salt = null;
let lazarus_pin_hash = null;

async function loadLockState() {
  const { lazarus_lock, lazarus_salt_storage, lazarus_pin_hash_storage } = await browser.storage.local.get(["lazarus_lock", "lazarus_salt_storage", "lazarus_pin_hash_storage"]);
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
  const salt = Math.random().toString(36).substr(2, 16);
  const hash = await deriveKey(pin, salt);
  await browser.storage.local.set({ lazarus_lock: true, lazarus_salt_storage: salt, lazarus_pin_hash_storage: hash });
  lazarus_lock_active = true;
  lazarus_salt = salt;
  lazarus_pin_hash = hash;
}

async function disableLock() {
  await browser.storage.local.set({ lazarus_lock: false, lazarus_salt_storage: null, lazarus_pin_hash_storage: null });
  lazarus_lock_active = false;
  lazarus_salt = null;
  lazarus_pin_hash = null;
}

let showAll = false;
let currentTabUrl = '';

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

async function getEntriesFromStorage() {
  const resp = await browser.runtime.sendMessage({ action: "getSavedData", currentTabUrl: showAll ? null : currentTabUrl, fieldName: null });
  return resp.entries;
}

async function refreshEntries() {
  const container = document.getElementById('entries');
  container.innerHTML = '';
  if (lazarus_lock_active && !lazarus_unlocked) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔒</div><div class="empty-title">Vault Locked</div><div class="empty-desc">Enter your PIN to access saved texts.</div></div>`;
    return;
  }
  const searchValue = document.getElementById('search-input') ? document.getElementById('search-input').value.toLowerCase().trim() : '';
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
    if (searchValue) {
      const latestText = e.versions[e.versions.length - 1].text.toLowerCase();
      const field = e.fieldName.toLowerCase();
      const url = e.pageUrl.toLowerCase();
      return field.includes(searchValue) || latestText.includes(searchValue) || url.includes(searchValue);
    }
    return true;
  });
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No matching drafts</div></div>`;
    return;
  }
  filtered.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'entry-card';
    const latestVersion = entry.versions[entry.versions.length - 1];
    let hostname = 'Unknown Site';
    try {
      hostname = new URL(entry.pageUrl).hostname.replace('www.', '') || entry.pageUrl;
    } catch (e) {
      hostname = entry.pageUrl;
    }
    card.innerHTML = `
      <div class="entry-meta">
        <span class="field-tag">${escapeHtml(entry.fieldName)}</span>
        <span class="time-tag">${timeAgo(latestVersion.timestamp)} · ${escapeHtml(hostname)}</span>
      </div>
      <div class="snippet">${escapeHtml(latestVersion.text)}</div>
      <div class="card-actions">
        <button class="btn-icon history-btn" title="View version history">📜</button>
        <button class="btn-icon delete-btn" title="Delete draft">🗑️</button>
        <button class="btn-primary restore-btn">Resurrect</button>
      </div>
    `;

    card.querySelector('.restore-btn').addEventListener('click', () => {
      browser.runtime.sendMessage({ action: "restoreField", entryId: entry.id });
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

    container.appendChild(card);
  });
}

async function showVersionHistory(entry) {
  const modal = document.createElement('div');
  modal.className = 'version-modal';
  modal.innerHTML = `
    <div class="version-modal-content">
      <div class="version-header">
        <span class="field-tag">${escapeHtml(entry.fieldName)}</span>
        <button class="btn-icon close-modal">✖</button>
      </div>
      <div class="version-list"></div>
    </div>
  `;
  document.body.appendChild(modal);
  const list = modal.querySelector('.version-list');
  entry.versions.slice().reverse().forEach(version => {
    const row = document.createElement('div');
    row.className = 'version-row';
    row.innerHTML = `<span class="time-tag">${timeAgo(version.timestamp)}</span><span class="version-snippet">${escapeHtml(version.text.slice(0, 60))}</span><button class="btn-primary small">Restore</button>`;
    row.querySelector('button').addEventListener('click', () => {
      browser.runtime.sendMessage({ action: "restoreVersion", entryId: entry.id, timestamp: version.timestamp });
      modal.remove();
    });
    list.appendChild(row);
  });
  modal.querySelector('.close-modal').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

async function resurrectFullForm() {
  if (lazarus_lock_active && !lazarus_unlocked) return;
  await browser.runtime.sendMessage({ action: "restoreAllFields", currentTabUrl: currentTabUrl });
}

async function toggleBlacklist() {
  const hostname = new URL(currentTabUrl).hostname;
  let { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
  let list = lazarus_blacklist || [];
  const index = list.indexOf(hostname);
  if (index > -1) {
    list.splice(index, 1);
  } else {
    list.push(hostname);
  }
  await browser.storage.local.set({ lazarus_blacklist: list });
  updateBlacklistButton();
}

async function updateBlacklistButton() {
  const btn = document.getElementById('blacklist-btn');
  const hostname = new URL(currentTabUrl).hostname;
  let { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
  const list = lazarus_blacklist || [];
  btn.textContent = list.includes(hostname) ? '🔇 Unsilence Site' : '🔕 Silence Site';
}

async function exportVault() {
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

async function init() {
  await loadLockState();
  if (lazarus_lock_active) {
    document.getElementById('lock-screen').style.display = 'flex';
  } else {
    document.getElementById('lock-screen').style.display = 'none';
    document.getElementById('main-ui').style.display = 'flex';
  }

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tab ? tab.url : '';
  } catch (e) {
    currentTabUrl = '';
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

  document.getElementById('search-input').addEventListener('input', refreshEntries);

  document.getElementById('resurrect-all-btn').addEventListener('click', resurrectFullForm);

  document.getElementById('blacklist-btn').addEventListener('click', toggleBlacklist);
  updateBlacklistButton();

  document.getElementById('export-btn').addEventListener('click', exportVault);
  document.getElementById('import-btn').addEventListener('click', importVault);

  document.getElementById('toggle-donate').addEventListener('click', (e) => {
    e.preventDefault();
    const modal = document.getElementById('donate-modal');
    modal.style.display = modal.style.display === 'none' || !modal.style.display ? 'flex' : 'none';
  });

  document.getElementById('lock-btn').addEventListener('click', async () => {
    if (lazarus_lock_active) {
      await disableLock();
      document.getElementById('lock-btn').textContent = '🔓 Unlocked';
      document.getElementById('lock-screen').style.display = 'none';
      document.getElementById('main-ui').style.display = 'flex';
      refreshEntries();
    } else {
      const pin = prompt('Enter new PIN:');
      if (!pin) return;
      await setLockPin(pin);
      document.getElementById('lock-btn').textContent = '🔒 Locked';
      document.getElementById('lock-screen').style.display = 'none';
      document.getElementById('main-ui').style.display = 'flex';
      refreshEntries();
    }
  });

  document.getElementById('unlock-btn').addEventListener('click', async () => {
    const pin = document.getElementById('pin-input').value;
    if (await verifyPin(pin)) {
      lazarus_unlocked = true;
      document.getElementById('lock-screen').style.display = 'none';
      document.getElementById('main-ui').style.display = 'flex';
      refreshEntries();
    } else {
      document.getElementById('pin-error').style.display = 'block';
    }
  });

  if (!lazarus_lock_active) {
    document.getElementById('lock-btn').textContent = '🔓 Unlocked';
  } else {
    document.getElementById('lock-btn').textContent = '🔒 Locked';
  }

  await refreshEntries();
}

init();
