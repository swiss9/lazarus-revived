'use strict';

/* Lazarus v6.0 — options
 * Like the popup, this page never touches storage directly: every read and
 * write is a message to the background, the single writer for the vault. */

const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
const storageLocal = api.storage && api.storage.local;
const SETTINGS_KEY = 'lz.settings';

const DEFAULT_SETTINGS = {
  savePasswords: false,
  retentionHours: 720,
  searchIndexing: true,
  paletteEnabled: true,
  autoLockMinutes: 15
};

const state = {
  url: null
};

let vault = {
  hasPin: false,
  locked: false,
  legacy: false,
  settings: {},
  count: 0,
  bytes: 0,
  entries: []
};

let flashTimer = null;
const busy = new Set();

const ERROR_TEXT = {
  LOCKED: 'vault is sealed',
  LOCKED_OUT: 'too many attempts — wait a moment',
  WRONG_PIN: 'incorrect PIN',
  WEAK_PIN: 'PIN must be at least 6 characters',
  BAD_PIN: 'that PIN is not valid',
  ALREADY_SEALED: 'a PIN is already set',
  NOT_SEALED: 'no PIN is set',
  LEGACY: 'unlock the old vault first',
  BAD_JSON: 'that file is not a Lazarus export',
  BAD_FORMAT: 'that file is not a Lazarus export',
  DECRYPT_FAILED: 'could not decrypt the vault',
  NO_BACKGROUND: 'Lazarus is not responding',
  NO_RESPONSE: 'Lazarus is not responding'
};

function errorText(code) {
  return ERROR_TEXT[code] || 'something went wrong';
}

async function send(type, data) {
  try {
    const response = await api.runtime.sendMessage({ type, ...(data || {}) });
    return response || { ok: false, error: 'NO_RESPONSE' };
  } catch (e) {
    return { ok: false, error: 'NO_BACKGROUND' };
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function flash(message, kind) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  // restart the fade even when a toast is already on screen
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.classList.remove('show');
  }, kind === 'err' ? 4200 : 2600);
}

function status(el, message, kind) {
  el.textContent = message;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/* run one action at a time and disable its button while it is in flight */
async function guard(key, button, fn) {
  if (busy.has(key)) return;
  busy.add(key);
  if (button) button.disabled = true;
  try {
    await fn();
  } finally {
    busy.delete(key);
    if (button) button.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* tabs                                                               */
/* ------------------------------------------------------------------ */

const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('section[data-tab]'));

function showTab(name) {
  for (const tab of tabs) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.tab !== name;
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                          */
/* ------------------------------------------------------------------ */

function renderVault() {
  $('stat-drafts').textContent = vault.count;
  $('stat-size').textContent = formatBytes(vault.bytes);
  $('stat-sites').textContent = String(new Set(vault.entries.map(e => e.host)).size);

  const tag = $('vault-tag');

  if (!vault.hasPin) {
    tag.textContent = 'plaintext';
    tag.className = 'tag warn';
    status($('vault-status'), 'vault is not encrypted', 'err');
  } else if (vault.locked) {
    tag.textContent = vault.legacy ? 'legacy · sealed' : 'sealed';
    tag.className = 'tag warn';
    status($('vault-status'), 'vault is sealed — unseal below to read or change anything', 'err');
  } else {
    tag.textContent = 'unlocked · aes-256-gcm';
    tag.className = 'tag ok';
    status($('vault-status'), 'vault is unsealed for this session', 'ok');
  }

  status($('pin-status'),
    !vault.hasPin ? 'no PIN set — anyone using this browser profile can read the vault'
      : vault.locked ? 'PIN set · vault sealed'
        : 'PIN set · vault unsealed',
    vault.hasPin && !vault.locked ? 'ok' : '');

  $('pin-setup').hidden = vault.hasPin;
  $('pin-unseal').hidden = !(vault.hasPin && vault.locked);
  $('pin-manage').hidden = !vault.hasPin;

  resetErase();
}

function renderSettings() {
  const s = vault.settings || {};
  $('set-savePasswords').checked = !!s.savePasswords;
  $('set-paletteEnabled').checked = s.paletteEnabled !== false;
  $('set-searchIndexing').checked = s.searchIndexing !== false;
  $('set-retentionHours').value = Number.isFinite(s.retentionHours) ? s.retentionHours : 720;

  const select = $('set-autoLockMinutes');
  const wanted = String(Number.isFinite(s.autoLockMinutes) ? s.autoLockMinutes : 15);
  select.value = wanted;
  if (select.value !== wanted) select.value = '15';
}

function renderSites(hosts) {
  const list = $('site-list');
  list.textContent = '';

  if (!hosts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No silenced sites. Silence a site from its popup or with the right-click menu.';
    list.appendChild(empty);
    return;
  }

  hosts.forEach(host => {
    const row = document.createElement('div');
    row.className = 'site';
    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = host;
    const button = document.createElement('button');
    button.className = 'btn ghost';
    button.type = 'button';
    button.textContent = 'Remove';
    button.addEventListener('click', () => guard('site:' + host, button, async () => {
      const response = await send('lz:remove-site', { host });
      if (!response.ok) { flash(errorText(response.error), 'err'); return; }
      renderSites(response.blacklist || []);
      flash('Recording ' + host + ' again', 'ok');
    }));
    row.append(name, button);
    list.appendChild(row);
  });
}

async function load() {
  const snapshot = await send('lz:state');

  if (!snapshot.ok) {
    if (storageLocal && storageLocal.get) {
      try {
        const stored = await storageLocal.get(SETTINGS_KEY);
        const saved = stored && stored[SETTINGS_KEY];
        if (saved) {
          vault.settings = { ...DEFAULT_SETTINGS, ...saved };
          renderSettings();
        }
      } catch (e) { /* keep current values */ }
    }
    status($('vault-status'), errorText(snapshot.error), 'err');
    return;
  }

  vault.hasPin = !!snapshot.hasPin;
  vault.locked = !!snapshot.locked;
  vault.legacy = !!snapshot.legacy;
  vault.settings = snapshot.settings || {};
  vault.count = snapshot.count || 0;
  vault.bytes = snapshot.bytes || 0;
  vault.entries = [];

  $('version-meta').textContent = 'v' + String(snapshot.version || '6.0.0').split('.').slice(0, 2).join('.');

  if (!vault.locked) {
    const list = await send('lz:list', { all: true });
    if (list.ok) vault.entries = list.entries || [];
  }

  renderVault();
  renderSettings();

  const hosts = await send('lz:blacklist-list');
  renderSites(hosts.ok ? hosts.blacklist : []);
}

/* ------------------------------------------------------------------ */
/* settings                                                           */
/* ------------------------------------------------------------------ */

async function saveSetting(patch) {
  const next = { ...(vault.settings || {}), ...(patch || {}) };
  vault.settings = next;
  renderSettings();

  let persisted = false;
  if (storageLocal && storageLocal.set) {
    try {
      await storageLocal.set({ [SETTINGS_KEY]: next });
      persisted = true;
    } catch (e) {
      flash('could not save settings: ' + (e && e.message ? e.message : e), 'err');
      return;
    }
  }

  const response = await send('lz:settings', { settings: next });
  if (response.ok) {
    vault.settings = response.settings || next;
  } else if (!persisted) {
    flash(errorText(response.error), 'err');
    return;
  }

  renderSettings();
  flash('Settings saved', 'ok');
}

/* ------------------------------------------------------------------ */
/* PIN                                                                */
/* ------------------------------------------------------------------ */

function setupPin() {
  return guard('setup', $('pin-set-btn'), async () => {
    const pin = $('new-pin').value;
    const confirm = $('new-pin2').value;
    if (pin.length < 6) { status($('pin-status'), 'PIN must be at least 6 characters', 'err'); return; }
    if (pin !== confirm) { status($('pin-status'), 'PINs do not match', 'err'); return; }

    const response = await send('lz:set-pin', { pin });
    if (!response.ok) { status($('pin-status'), errorText(response.error), 'err'); return; }
    $('new-pin').value = '';
    $('new-pin2').value = '';
    flash('PIN created — keep it safe', 'ok');
    await load();
  });
}

function unseal() {
  return guard('unseal', $('pin-unseal-btn'), async () => {
    const pin = $('unseal-pin').value;
    if (!pin) return;
    const response = await send('lz:unlock', { pin });
    if (!response.ok) { status($('pin-status'), errorText(response.error), 'err'); return; }
    $('unseal-pin').value = '';
    flash('Vault unsealed', 'ok');
    await load();
  });
}

function changePin() {
  return guard('change', $('pin-change-btn'), async () => {
    const oldPin = $('old-pin').value;
    const next = $('new-pin-c').value;
    const confirm = $('new-pin-c2').value;
    if (next.length < 6) { status($('pin-status'), 'new PIN must be at least 6 characters', 'err'); return; }
    if (next !== confirm) { status($('pin-status'), 'new PINs do not match', 'err'); return; }

    const response = await send('lz:change-pin', { oldPin, newPin: next });
    if (!response.ok) { status($('pin-status'), errorText(response.error), 'err'); return; }
    for (const id of ['old-pin', 'new-pin-c', 'new-pin-c2']) $(id).value = '';
    flash('PIN changed', 'ok');
    await load();
  });
}

function removePin() {
  return guard('remove', $('pin-remove-btn'), async () => {
    const pin = $('remove-pin').value;
    if (!pin) { status($('pin-status'), 'enter the current PIN', 'err'); return; }
    const response = await send('lz:remove-pin', { pin });
    if (!response.ok) { status($('pin-status'), errorText(response.error), 'err'); return; }
    $('remove-pin').value = '';
    flash('PIN removed — vault is unencrypted', 'err');
    await load();
  });
}

/* ------------------------------------------------------------------ */
/* erase (two taps + a guard so a double click cannot erase twice)     */
/* ------------------------------------------------------------------ */

let eraseArmed = false;
let eraseTimer = null;

function resetErase() {
  eraseArmed = false;
  clearTimeout(eraseTimer);
  const button = $('erase-btn');
  if (button) button.textContent = 'Erase all drafts';
}

function eraseVault() {
  const button = $('erase-btn');

  if (!eraseArmed) {
    eraseArmed = true;
    button.textContent = 'Confirm erase';
    eraseTimer = setTimeout(resetErase, 4000);
    return;
  }

  return guard('erase', button, async () => {
    eraseArmed = false;
    clearTimeout(eraseTimer);
    button.textContent = 'Erase all drafts';

    const response = await send('lz:erase');
    if (!response.ok) { flash(errorText(response.error), 'err'); return; }
    flash('All drafts erased', 'ok');
    await load();
  });
}

/* ------------------------------------------------------------------ */
/* backup                                                             */
/* ------------------------------------------------------------------ */

async function exportVault() {
  const button = $('export-btn');
  return guard('export', button, async () => {
    const response = await send('lz:export');
    if (!response.ok) { flash(errorText(response.error), 'err'); return; }
    const blob = new Blob([response.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lazarus-vault-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    flash('Exported ' + response.count + (response.count === 1 ? ' draft' : ' drafts'), 'ok');
  });
}

async function importVault(file) {
  let text;
  try {
    text = await file.text();
  } catch (e) {
    flash('could not read that file', 'err');
    return;
  }
  const response = await send('lz:import', { json: text });
  if (!response.ok) { flash(errorText(response.error), 'err'); return; }
  flash('Imported ' + response.added + ', skipped ' + response.skipped, 'ok');
  await load();
}

/* ------------------------------------------------------------------ */
/* donation                                                           */
/* ------------------------------------------------------------------ */

async function copyAddress(button) {
  const value = button.getAttribute('data-copy');
  if (!value) return;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      flash('Address copied', 'ok');
      return;
    } catch (e) { /* fall through to the legacy path */ }
  }

  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
  field.remove();

  if (copied) {
    flash('Address copied', 'ok');
    return;
  }

  // last resort: select the visible address so Ctrl+C / ⌘C still works
  const code = button.closest && button.closest('.qr') && button.closest('.qr').querySelector('code');
  if (code && window.getSelection && document.createRange) {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    flash('Address selected — press Ctrl+C to copy', 'err');
    return;
  }

  flash('Copy failed — select the address manually', 'err');
}

/* ------------------------------------------------------------------ */
/* wiring                                                             */
/* ------------------------------------------------------------------ */

function wire() {
  for (const tab of tabs) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  }

  document.querySelector('.tabs').addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const index = tabs.findIndex(tab => tab.classList.contains('active'));
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    event.preventDefault();
    showTab(next.dataset.tab);
    next.focus();
  });

  $('set-savePasswords').addEventListener('change', e => saveSetting({ savePasswords: e.target.checked }));
  $('set-paletteEnabled').addEventListener('change', e => saveSetting({ paletteEnabled: e.target.checked }));
  $('set-searchIndexing').addEventListener('change', e => saveSetting({ searchIndexing: e.target.checked }));
  $('set-autoLockMinutes').addEventListener('change', e => saveSetting({ autoLockMinutes: Number(e.target.value) }));

  let retentionTimer = null;
  $('set-retentionHours').addEventListener('change', e => {
    const value = Math.min(8760, Math.max(0, Math.round(Number(e.target.value) || 0)));
    clearTimeout(retentionTimer);
    retentionTimer = setTimeout(() => saveSetting({ retentionHours: value }), 200);
  });

  $('pin-set-btn').addEventListener('click', setupPin);
  $('pin-unseal-btn').addEventListener('click', unseal);
  $('pin-change-btn').addEventListener('click', changePin);
  $('pin-remove-btn').addEventListener('click', removePin);
  $('erase-btn').addEventListener('click', eraseVault);

  $('unseal-pin').addEventListener('keydown', e => { if (e.key === 'Enter') unseal(); });
  $('new-pin2').addEventListener('keydown', e => { if (e.key === 'Enter') setupPin(); });
  $('new-pin-c2').addEventListener('keydown', e => { if (e.key === 'Enter') changePin(); });
  $('remove-pin').addEventListener('keydown', e => { if (e.key === 'Enter') removePin(); });

  $('export-btn').addEventListener('click', exportVault);
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) importVault(file);
  });

  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', () => guard('copy', button, () => copyAddress(button)));
  }
}

wire();
showTab('overview');
load();
