'use strict';

/* Lazarus v6.0 — popup
 * The popup never touches vault storage directly: every vault read and write
 * is a message to the background, which is the single writer for the vault. */

const ERROR_BANNER_ID = 'lazarus-error-banner';

function reportPopupError(message, source, line, column, error) {
  try {
    const where = (source || 'popup.js') + (line ? ':' + line : '') +
      (column ? ':' + column : '');
    const trace = error && error.stack ? '\n\n' + error.stack : '';
    let banner = document.getElementById(ERROR_BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = ERROR_BANNER_ID;
      banner.setAttribute('role', 'alert');
      banner.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;' +
        'max-height:45vh;overflow:auto;padding:8px 10px;background:#3a0006;' +
        'color:#ffd7d9;border-bottom:2px solid #E1192A;' +
        'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
        'white-space:pre-wrap;word-break:break-word;';
      (document.body || document.documentElement).appendChild(banner);
    }
    banner.textContent = 'LAZARUS ERROR\n' + String(message || 'Unknown error') +
      '\n' + where + trace;
  } catch (loggerError) {
    /* the error logger must never break the popup */
  }
}

window.onerror = function (message, source, line, column, error) {
  reportPopupError(message, source, line, column, error);
  return false;
};

window.addEventListener('unhandledrejection', event => {
  const reason = event.reason;
  const message = reason && reason.message ? reason.message : String(reason);
  reportPopupError(
    'Unhandled promise rejection: ' + message,
    reason && reason.fileName,
    reason && reason.lineNumber,
    reason && reason.columnNumber,
    reason
  );
});

const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
const storageLocal = api.storage && api.storage.local;

const state = {
  url: null,
  host: '',
  path: '',
  tabId: null,
  hasPin: false,
  locked: false,
  legacy: false,
  blacklisted: false,
  settings: {},
  count: 0,
  siteCount: 0,
  bytes: 0,
  version: '6.0.0',
  scope: 'page',
  query: '',
  entries: [],
  view: 'main',
  history: null,
  confirmId: null,
  busy: false,
  selected: -1
};

let toastTimer = null;
let unlockAttempts = 0;

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  let u;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  for (const p of Array.from(u.searchParams.keys())) {
    if (/^(utm_|fbclid$|gclid$|mc_|igshid$|si$|ref$|ref_src$|source$|spm$)/i.test(p)) {
      u.searchParams.delete(p);
    }
  }
  u.hash = '';
  return u.toString();
}

const READ_ONLY_MESSAGES = new Set([
  'lz:state', 'lz:list', 'lz:entry', 'lz:field', 'lz:payload',
  'lz:blacklist-list', 'lz:export'
]);

function messageTimeout(type) {
  if (['lz:set-pin', 'lz:unlock', 'lz:change-pin', 'lz:remove-pin', 'lz:seal', 'lz:erase'].includes(type)) {
    return 30000;
  }
  if (['lz:restore-field', 'lz:restore-all', 'lz:import', 'lz:export'].includes(type)) {
    return 15000;
  }
  return 6000;
}

function senderMissing(error) {
  const text = String(error && (error.message || error));
  return /Receiving end does not exist|Could not establish connection|message port closed/i.test(text);
}

function sendWithTimeout(message, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('TIMEOUT');
      error.code = 'TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([api.runtime.sendMessage(message), timeout])
    .finally(() => clearTimeout(timer));
}

async function send(type, data) {
  const message = { type, ...(data || {}) };
  const readOnly = READ_ONLY_MESSAGES.has(type);
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    let retry = false;
    try {
      const response = await sendWithTimeout(message, messageTimeout(type));
      if (response) return response;
      lastError = new Error('No response from the background for "' + type + '"');
      retry = readOnly;
    } catch (e) {
      lastError = e;
      retry = readOnly || senderMissing(e);
    }
    if (!retry || attempt === 1) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const detail = lastError && lastError.message ? lastError.message : String(lastError);
  reportPopupError(
    'Message "' + type + '" failed: ' + detail,
    'popup.js',
    0,
    0,
    lastError
  );

  if (lastError && lastError.code === 'TIMEOUT') return { ok: false, error: 'TIMEOUT' };
  if (senderMissing(lastError)) return { ok: false, error: 'NO_BACKGROUND' };
  return { ok: false, error: 'NO_RESPONSE' };
}

async function ensureSettingsStored(settings) {
  if (!storageLocal || !storageLocal.set || !settings) return;
  try {
    const stored = await storageLocal.get('lz.settings');
    if (!stored || !stored['lz.settings']) {
      await storageLocal.set({ 'lz.settings': settings });
    }
  } catch (e) {
    /* best effort: the background remains the writer of record */
  }
}

/* Firefox for Android has no options UI, and some builds resolve
 * openOptionsPage() without opening anything, so open the options page in a
 * normal tab first and fall back to the native entry point. */
async function openOptions() {
  try {
    if (api.tabs && api.tabs.create) {
      await api.tabs.create({ url: api.runtime.getURL('options.html') });
      return;
    }
  } catch (e) { /* fall through to the options API */ }
  try {
    await api.runtime.openOptionsPage();
  } catch (e) { /* nothing else we can do */ }
}

const ERROR_TEXT = {
  LOCKED: 'vault sealed',
  LOCKED_OUT: 'too many attempts — wait a moment',
  WRONG_PIN: 'incorrect pin',
  WEAK_PIN: 'pin must be at least 6 characters',
  BAD_JSON: 'that file is not a lazarus export',
  BAD_FORMAT: 'that file is not a lazarus export',
  DECRYPT_FAILED: 'could not decrypt the vault',
  NOT_FOUND: 'draft no longer exists',
  FORBIDDEN: 'not allowed here',
  NO_BACKGROUND: 'lazarus is not responding',
  NO_RESPONSE: 'lazarus is not responding',
  SILENCED: 'this site is silenced',
  LEGACY: 'unlock the old vault first',
  URL_MISMATCH: 'page changed — reopen lazarus',
  NO_CONTENT: 'cannot reach this page',
  TIMEOUT: 'the page did not answer'
};

function errorText(code) {
  return ERROR_TEXT[code] || 'something went wrong';
}

function prettyField(field) {
  if (typeof field !== 'string' || !field) return 'field';
  const named = field.match(/\[name="([^"]+)"\]/);
  if (named) return named[1];
  const idMatch = field.match(/#([A-Za-z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  const parts = field.split('>').map(s => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || field;
  return last.replace(/:nth-of-type\(\d+\)/g, '').replace(/\[.*$/, '') || last;
}

function timeLabel(ts, longForm) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 45) return longForm ? 'JUST NOW' : 'NOW';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'M' + (longForm ? ' AGO' : '');
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + 'H' + (longForm ? ' AGO' : '');
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'D' + (longForm ? ' AGO' : '');
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }).toUpperCase();
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ANKH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<circle cx="12" cy="6.5" r="4"/><path d="M12 10.5V22"/><path d="M5 14.5h14"/></svg>';

function showView(name) {
  state.view = name;
  for (const view of ['main', 'sealed', 'setup', 'history']) {
    $('view-' + view).hidden = view !== name;
  }
  $('site-row').hidden = name === 'sealed' || name === 'setup';
}

/* ------------------------------------------------------------------ */
/* data                                                               */
/* ------------------------------------------------------------------ */

async function fetchEntries() {
  const response = await send('lz:list', {
    url: state.url,
    all: state.scope === 'all',
    query: state.query
  });
  state.entries = response && response.ok ? response.entries : [];
  if (response && !response.ok && response.error === 'LOCKED') {
    state.locked = true;
  }
}

async function reload(options) {
  const list = !options || options.list !== false;
  const snapshot = await send('lz:state', { url: state.url });
  if (snapshot && snapshot.ok) {
    state.hasPin = snapshot.hasPin;
    state.locked = snapshot.locked;
    state.legacy = snapshot.legacy;
    state.blacklisted = snapshot.blacklisted;
    state.settings = snapshot.settings || {};
    state.count = snapshot.count;
    state.siteCount = snapshot.siteCount;
    state.bytes = snapshot.bytes;
    state.version = snapshot.version || state.version;
    ensureSettingsStored(state.settings);
  }

  $('version-tag').textContent = 'v' + state.version.split('.')[0] + '.' + state.version.split('.')[1];

  if (state.hasPin && state.locked) {
    showView('sealed');
    renderSealed();
    renderFooter();
    return;
  }

  if (list) await fetchEntries();

  if (state.view === 'history' && state.history) renderHistory();
  else if (state.view === 'setup') { showView('setup'); renderFooter(); }
  else { showView('main'); renderMain(); }

  renderFooter();
}

/* ------------------------------------------------------------------ */
/* main view                                                          */
/* ------------------------------------------------------------------ */

function renderSite() {
  const row = $('site-row');
  const hostEl = $('site-host');
  hostEl.textContent = '';
  hostEl.appendChild(document.createTextNode(state.host || 'this page'));
  if (state.path && state.path !== '/') {
    hostEl.appendChild(el('span', 'path', state.path));
  }
  const btn = $('silence-btn');
  btn.textContent = state.blacklisted ? 'Unsilence' : 'Silence';
  btn.title = state.blacklisted
    ? 'Start recording form data on this site again'
    : 'Stop recording form data on this site';
  row.classList.toggle('silenced', state.blacklisted);
}

function renderMain() {
  renderSite();

  const button = $('resurrect-btn');
  const count = $('resurrect-count');
  const total = state.siteCount;
  button.disabled = total === 0 || state.blacklisted;
  count.textContent = total === 0
    ? (state.blacklisted ? 'silenced' : 'nothing saved')
    : total + (total === 1 ? ' field' : ' fields');

  $('count-page').textContent = state.siteCount;
  $('count-all').textContent = state.count;
  $('tab-page').classList.toggle('active', state.scope === 'page');
  $('tab-all').classList.toggle('active', state.scope === 'all');
  $('tab-page').setAttribute('aria-selected', String(state.scope === 'page'));
  $('tab-all').setAttribute('aria-selected', String(state.scope === 'all'));

  renderList();
}

function renderList() {
  const list = $('list');
  list.textContent = '';

  if (state.blacklisted) {
    const wrap = el('div', 'state');
    const mark = el('div', 'mark-lg');
    mark.innerHTML = ANKH;
    wrap.appendChild(mark);
    wrap.appendChild(el('h2', null, 'Silenced'));
    const copy = el('p');
    copy.append('Lazarus is not recording on ');
    copy.appendChild(el('b', null, state.host || 'this site'));
    copy.append('. Nothing you type here is stored — the rest of your vault is untouched.');
    wrap.appendChild(copy);
    const hint = el('span', 'hint');
    hint.appendChild(el('b', null, 'Unsilence'));
    hint.append(' to start recording again');
    wrap.appendChild(hint);
    list.appendChild(wrap);
    return;
  }

  if (!state.entries.length) {
    const wrap = el('div', 'state');
    const mark = el('div', 'mark-lg');
    mark.innerHTML = ANKH;
    wrap.appendChild(mark);

    if (state.query) {
      wrap.appendChild(el('h2', null, 'No matches'));
      const copy = el('p');
      copy.append('Nothing in the ');
      copy.appendChild(el('b', null, state.scope === 'all' ? 'whole vault' : 'page drafts'));
      copy.append(' matches “' + state.query + '”.');
      wrap.appendChild(copy);
      const hint = el('span', 'hint');
      hint.appendChild(el('b', null, 'Esc'));
      hint.append(' to clear the filter');
      wrap.appendChild(hint);
    } else if (state.scope === 'all' && state.count === 0) {
      wrap.appendChild(el('h2', null, 'Empty vault'));
      wrap.appendChild(el('p', null, 'Lazarus records the moment you type. Fill in any form field and it appears here.'));
      const hint = el('span', 'hint');
      hint.appendChild(el('b', null, 'Ctrl+Shift+L'));
      hint.append(' searches drafts on a page');
      wrap.appendChild(hint);
    } else {
      wrap.appendChild(el('h2', null, 'Nothing here yet'));
      wrap.appendChild(el('p', null, 'No drafts saved for this page. Start typing in a form and Lazarus will keep it.'));
      const hint = el('span', 'hint');
      hint.appendChild(el('b', null, String(state.count)));
      hint.append(state.count === 1 ? ' draft elsewhere in the vault' : ' drafts elsewhere in the vault');
      wrap.appendChild(hint);
    }
    list.appendChild(wrap);
    return;
  }

  state.entries.forEach(entry => list.appendChild(buildRow(entry)));
  applySelection();
}

function buildRow(entry) {
  const row = el('article', 'row' + (entry.pinned ? ' pinned' : ''));
  row.dataset.id = entry.id;
  row.setAttribute('role', 'listitem');

  const top = el('div', 'row-top');
  top.appendChild(el('span', 'field', prettyField(entry.field)));
  if (state.scope === 'all') top.appendChild(el('span', 'host-tag', entry.host));
  top.appendChild(el('span', 'time', timeLabel(entry.ts)));

  const acts = el('div', 'acts');
  acts.appendChild(actionButton('Restore', () => restoreEntry(entry)));
  acts.appendChild(actionButton('Hist', () => openHistory(entry)));
  acts.appendChild(actionButton(entry.pinned ? 'Unpin' : 'Pin', () => togglePin(entry)));
  acts.appendChild(actionButton('Del', button => confirmDelete(entry, button), 'danger'));
  top.appendChild(acts);

  const looksMono = entry.preview.length > 0 &&
    entry.preview.length <= 64 &&
    !/\s/.test(entry.preview) &&
    /^[\x21-\x7e]+$/.test(entry.preview);
  const snippet = el('p', 'snippet' + (looksMono ? ' mono' : ''), entry.preview || '(empty)');

  row.append(top, snippet);
  row.addEventListener('click', event => {
    if (event.target.closest('.act')) return;
    restoreEntry(entry);
  });
  return row;
}

function actionButton(label, handler, extraClass) {
  const button = el('button', 'act' + (extraClass ? ' ' + extraClass : ''), label);
  button.type = 'button';
  button.addEventListener('click', event => {
    event.stopPropagation();
    handler(button);
  });
  return button;
}

/* ------------------------------------------------------------------ */
/* row actions                                                        */
/* ------------------------------------------------------------------ */

function clearConfirm() {
  if (!state.confirmId) return;
  const row = document.querySelector('.row[data-id="' + state.confirmId + '"]');
  if (row) {
    const button = row.querySelector('.act.danger');
    if (button) {
      button.textContent = 'Del';
      button.classList.remove('confirm');
    }
  }
  state.confirmId = null;
}

function confirmDelete(entry, button) {
  if (!button) {
    button = document.querySelector('.row[data-id="' + entry.id + '"] .act.danger');
  }
  if (state.confirmId !== entry.id) {
    clearConfirm();
    state.confirmId = entry.id;
    if (button) {
      button.textContent = 'Confirm';
      button.classList.add('confirm');
    }
    setTimeout(() => { if (state.confirmId === entry.id) clearConfirm(); }, 4000);
    return;
  }
  state.confirmId = null;
  deleteEntry(entry);
}

async function deleteEntry(entry) {
  const row = document.querySelector('.row[data-id="' + entry.id + '"]');
  if (row) row.classList.add('busy');
  const response = await send('lz:delete', { id: entry.id });
  if (!response.ok) {
    if (row) row.classList.remove('busy');
    toast(errorText(response.error));
    return;
  }
  toast('Draft deleted');
  await reload();
}

async function togglePin(entry) {
  const response = await send('lz:pin', { id: entry.id });
  if (!response.ok) { toast(errorText(response.error)); return; }
  toast(response.pinned ? 'Pinned to top' : 'Unpinned');
  await reload();
}

async function openHistory(entry) {
  const response = await send('lz:entry', { id: entry.id });
  if (!response.ok) { toast(errorText(response.error)); return; }
  state.history = response.entry;
  showView('history');
  renderHistory();
  renderFooter();
}

function renderHistory() {
  const entry = state.history;
  if (!entry) return;
  $('history-field').textContent = prettyField(entry.field);

  const list = $('history-list');
  list.textContent = '';

  const versions = entry.versions.slice().reverse();
  const newestTs = Math.max.apply(null, entry.versions.map(v => v.ts));

  versions.forEach(version => {
    const row = el('article', 'row');
    const top = el('div', 'row-top');
    top.appendChild(el('span', 'field', timeLabel(version.ts, true)));
    top.appendChild(el('span', 'time', version.text.length + ' chars'));

    const acts = el('div', 'acts');
    acts.appendChild(actionButton('Restore', () => restoreVersion(entry, version)));
    if (version.ts === newestTs) {
      const current = el('button', 'act', 'Current');
      current.type = 'button';
      current.disabled = true;
      current.style.color = 'var(--mute)';
      acts.appendChild(current);
    } else {
      acts.appendChild(actionButton('Set current', () => promoteVersion(entry, version)));
    }
    acts.appendChild(forgetButton(entry, version));
    top.appendChild(acts);

    const snippet = el('p', 'snippet', version.text);
    row.append(top, snippet);
    row.addEventListener('click', event => {
      if (event.target.closest('.act')) return;
      restoreVersion(entry, version);
    });
    list.appendChild(row);
  });
}

async function restoreVersion(entry, version) {
  const result = await restoreInTab(entry.field, version.text);
  if (result.ok) {
    toast(version.ts === Math.max.apply(null, entry.versions.map(v => v.ts)) ? 'Restored' : 'Restored older draft');
    setTimeout(() => window.close(), 400);
  } else {
    toast(errorText(result.error));
  }
}

async function promoteVersion(entry, version) {
  const response = await send('lz:promote', { id: entry.id, ts: version.ts });
  if (!response.ok) { toast(errorText(response.error)); return; }
  const refreshed = await send('lz:entry', { id: entry.id });
  if (refreshed.ok) state.history = refreshed.entry;
  renderHistory();
  toast('Set as current');
}

/* a two-tap forget so a single stray click can never lose a draft */
function forgetButton(entry, version) {
  let armed = false;
  let timer = null;
  const button = actionButton('Forget', () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Confirm';
      button.classList.add('confirm');
      timer = setTimeout(() => {
        armed = false;
        button.textContent = 'Forget';
        button.classList.remove('confirm');
      }, 4000);
      return;
    }
    clearTimeout(timer);
    forgetVersion(entry, version);
  }, 'danger');
  return button;
}

async function forgetVersion(entry, version) {
  const response = await send('lz:forget-version', { id: entry.id, ts: version.ts });
  if (!response.ok) { toast(errorText(response.error)); return; }
  if (response.removed) {
    toast('Draft deleted');
    state.history = null;
    state.selected = -1;
    showView('main');
    await reload();
    return;
  }
  toast('Version forgotten');
  const refreshed = await send('lz:entry', { id: entry.id });
  if (refreshed.ok) state.history = refreshed.entry;
  renderHistory();
  renderFooter();
}

/* ------------------------------------------------------------------ */
/* restore                                                            */
/* ------------------------------------------------------------------ */

async function restoreInTab(field, text) {
  if (state.tabId == null) return { ok: false, error: 'NO_CONTENT' };
  /* The background owns tab messaging: if the page has no content script yet
   * (installed/updated while it was open) it injects one and retries. */
  return send('lz:restore-field', {
    tabId: state.tabId,
    url: state.url,
    field,
    text
  });
}

async function restoreEntry(entry) {
  if (entry.url && state.url && entry.url !== state.url) {
    toast('draft belongs to ' + entry.host + ' — open it there');
    return;
  }
  const response = await send('lz:entry', { id: entry.id });
  if (!response.ok) { toast(errorText(response.error)); return; }
  const versions = response.entry.versions;
  const last = versions[versions.length - 1];
  if (!last) { toast('draft is empty'); return; }

  const result = await restoreInTab(entry.field, last.text);
  if (result.ok) {
    toast('Restored “' + prettyField(entry.field) + '”');
    setTimeout(() => window.close(), 450);
  } else if (result.error === 'URL_MISMATCH') {
    toast('page changed — reopen lazarus');
  } else if (result.error === 'TIMEOUT' || result.error === 'NO_CONTENT') {
    toast('cannot reach this page');
  } else {
    toast('field not found on this page');
  }
}

async function resurrectPage() {
  if (state.busy) return;
  state.busy = true;
  const button = $('resurrect-btn');
  button.disabled = true;

  const payload = await send('lz:payload', { url: state.url });
  if (!payload.ok) {
    toast(errorText(payload.error));
    state.busy = false;
    button.disabled = false;
    return;
  }
  if (!payload.items.length) {
    toast('nothing saved for this page');
    state.busy = false;
    button.disabled = false;
    return;
  }

  let result = { ok: false, error: 'NO_CONTENT' };
  result = await send('lz:restore-all', {
    tabId: state.tabId,
    url: state.url,
    items: payload.items
  });

  if (result.ok) {
    toast('Restored ' + result.restored + (result.restored === 1 ? ' field' : ' fields'));
    setTimeout(() => window.close(), 550);
    return;
  }
  toast(errorText(result.error));
  state.busy = false;
  button.disabled = false;
}

/* ------------------------------------------------------------------ */
/* sealing                                                            */
/* ------------------------------------------------------------------ */

function renderSealed() {
  const auto = state.settings.autoLockMinutes;
  $('sealed-autolock').textContent = auto ? 'auto-lock ' + auto + ' min' : 'no auto-lock';
  $('sealed-copy').textContent = state.legacy
    ? 'This vault was written by Lazarus 5. Unlock it once and your drafts are carried over to the new format.'
    : 'Your drafts are encrypted with AES-256-GCM. Enter your PIN to unseal them for this session.';
  requestAnimationFrame(() => $('unlock-pin').focus());
}

async function unlock() {
  const input = $('unlock-pin');
  const error = $('unlock-error');
  const pin = input.value;
  if (!pin) return;

  const button = $('unlock-btn');
  button.disabled = true;
  error.hidden = true;

  const response = await send('lz:unlock', { pin });
  button.disabled = false;

  if (response.ok) {
    unlockAttempts = 0;
    input.value = '';
    toast(state.legacy ? 'Vault migrated and unsealed' : 'Vault unsealed');
    await reload();
    return;
  }

  input.value = '';
  input.focus();
  unlockAttempts++;

  if (response.error === 'LOCKED_OUT') {
    error.textContent = 'Too many attempts — wait ' + (response.retryAfter || 15) + ' seconds';
  } else if (unlockAttempts >= 3) {
    error.textContent = 'Incorrect PIN — ' + unlockAttempts + ' attempts. There is no recovery.';
  } else {
    error.textContent = 'Incorrect PIN';
  }
  error.hidden = false;
}

async function seal() {
  const response = await send('lz:seal');
  if (!response.ok) { toast(errorText(response.error)); return; }
  state.history = null;
  toast('Vault sealed');
  await reload({ list: false });
}

async function submitSetup() {
  const first = $('setup-pin');
  const second = $('setup-confirm');
  const error = $('setup-error');

  error.hidden = true;
  if (first.value.length < 6) {
    error.textContent = 'PIN must be at least 6 characters';
    error.hidden = false;
    return;
  }
  if (first.value !== second.value) {
    error.textContent = 'PINs do not match';
    error.hidden = false;
    return;
  }

  const button = $('setup-btn');
  button.disabled = true;
  const response = await send('lz:set-pin', { pin: first.value });
  button.disabled = false;

  if (!response.ok) {
    error.textContent = errorText(response.error);
    error.hidden = false;
    return;
  }

  first.value = '';
  second.value = '';
  state.view = 'main';
  state.history = null;
  toast('Vault sealed — keep the PIN safe');
  await reload();
}

/* ------------------------------------------------------------------ */
/* footer                                                             */
/* ------------------------------------------------------------------ */

function footLink(label, handler, options) {
  const button = el('button', 'foot-link' + (options && options.armed ? ' armed' : ''), label);
  button.type = 'button';
  if (options && options.title) button.title = options.title;
  if (options && options.icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.innerHTML = options.icon;
    button.prepend(svg);
  }
  button.addEventListener('click', handler);
  return button;
}

/* The Ctrl+Shift+L shortcut does not exist on Firefox for Android, where
 * there is no keyboard. This footer link gives the palette a touch entry
 * point on every platform. */
async function openPalette() {
  if (state.tabId == null || !state.url) { toast(errorText('NO_CONTENT')); return; }
  const response = await send('lz:toggle-palette', { tabId: state.tabId });
  if (response && response.ok) window.close();
  else toast(errorText(response && response.error));
}

function renderFooter() {
  const actions = $('foot-actions');
  actions.textContent = '';

  if (state.view === 'sealed') {
    actions.appendChild(footLink('Forgot PIN?', () => {
      openOptions().finally(() => window.close());
    }));
    return;
  }

  if (state.view === 'setup') {
    actions.appendChild(footLink('Cancel', () => {
      state.view = 'main';
      reload({ list: false });
    }));
    return;
  }

  actions.appendChild(footLink('Export', exportVault, { title: 'Download every draft as JSON' }));
  actions.appendChild(footLink('Import', () => $('import-file').click(), { title: 'Restore from a Lazarus export' }));

  if (state.url && state.count > 0 && state.settings.paletteEnabled !== false) {
    actions.appendChild(footLink('Palette', openPalette, { title: 'Open the command palette on this page' }));
  }

  const sealLabel = state.hasPin ? 'Seal' : 'Set pin';
  actions.appendChild(footLink(sealLabel, () => {
    if (state.hasPin) seal();
    else { showView('setup'); renderFooter(); $('setup-pin').focus(); }
  }, {
    title: state.hasPin ? 'Lock the vault now' : 'Encrypt the vault with a PIN',
    icon: '<rect x="4" y="10.5" width="16" height="10.5"/><path d="M8 10.5V7a4 4 0 018 0v3.5"/>'
  }));
}

/* ------------------------------------------------------------------ */
/* import / export                                                    */
/* ------------------------------------------------------------------ */

async function exportVault() {
  const response = await send('lz:export');
  if (!response.ok) { toast(errorText(response.error)); return; }
  const blob = new Blob([response.json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'lazarus-vault-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Exported ' + response.count + (response.count === 1 ? ' draft' : ' drafts'));
}

async function importVault(file) {
  let text;
  try {
    text = await file.text();
  } catch (e) {
    toast('could not read that file');
    return;
  }
  const response = await send('lz:import', { json: text });
  if (!response.ok) { toast(errorText(response.error)); return; }
  toast('Imported ' + response.added + ', skipped ' + response.skipped);
  await reload();
}

/* ------------------------------------------------------------------ */
/* selection + keyboard                                               */
/* ------------------------------------------------------------------ */

function visibleRows() {
  return Array.from(document.querySelectorAll('#list .row'));
}

function applySelection() {
  const rows = visibleRows();
  rows.forEach((row, index) => row.classList.toggle('sel', index === state.selected));
}

function moveSelection(delta) {
  const rows = visibleRows();
  if (!rows.length) return;
  if (state.selected === -1) state.selected = delta > 0 ? 0 : rows.length - 1;
  else state.selected = Math.min(Math.max(state.selected + delta, 0), rows.length - 1);
  applySelection();
  rows[state.selected].scrollIntoView({ block: 'nearest' });
}

function activateSelection() {
  const rows = visibleRows();
  const row = rows[state.selected];
  if (!row) return;
  const entry = state.entries.find(e => e.id === row.dataset.id);
  if (entry) restoreEntry(entry);
}

/* ------------------------------------------------------------------ */
/* wiring                                                             */
/* ------------------------------------------------------------------ */

function wire() {
  $('settings-btn').addEventListener('click', () => {
    openOptions().finally(() => window.close());
  });

  $('silence-btn').addEventListener('click', async () => {
    const response = await send('lz:blacklist', { url: state.url });
    if (!response.ok) { toast(errorText(response.error)); return; }
    state.blacklisted = response.blacklisted;
    toast(response.blacklisted ? 'Silenced — nothing will be saved here' : 'Recording this site again');
    await reload();
  });

  $('resurrect-btn').addEventListener('click', resurrectPage);

  $('tab-page').addEventListener('click', async () => {
    state.scope = 'page';
    state.selected = -1;
    await fetchEntries();
    renderMain();
    renderFooter();
  });

  $('tab-all').addEventListener('click', async () => {
    state.scope = 'all';
    state.selected = -1;
    await fetchEntries();
    renderMain();
    renderFooter();
  });

  let filterTimer = null;
  $('filter').addEventListener('input', event => {
    state.query = event.target.value.trim();
    state.selected = -1;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(async () => {
      await fetchEntries();
      renderList();
    }, 140);
  });

  $('unlock-btn').addEventListener('click', unlock);
  $('unlock-pin').addEventListener('keydown', event => {
    if (event.key === 'Enter') unlock();
  });
  $('unlock-pin').addEventListener('input', () => { $('unlock-error').hidden = true; });

  $('setup-btn').addEventListener('click', submitSetup);
  for (const id of ['setup-pin', 'setup-confirm']) {
    $(id).addEventListener('keydown', event => {
      if (event.key === 'Enter') submitSetup();
    });
    $(id).addEventListener('input', () => { $('setup-error').hidden = true; });
  }

  $('history-back').addEventListener('click', () => {
    state.history = null;
    state.selected = -1;
    showView('main');
    renderMain();
    renderFooter();
  });

  $('import-file').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) importVault(file);
  });

  document.addEventListener('keydown', event => {
    const typing = event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA';

    if (event.key === 'Escape' && typing) {
      if (event.target.id === 'filter' && event.target.value) {
        event.target.value = '';
        state.query = '';
        fetchEntries().then(renderList);
      } else {
        event.target.blur();
      }
      return;
    }

    if (event.key === '/' && !typing) {
      event.preventDefault();
      $('filter').focus();
      return;
    }

    if (state.view !== 'main') return;

    if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
    else if (event.key === 'Enter' && !typing) { event.preventDefault(); activateSelection(); }
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

const REQUIRED_IDS = [
  'version-tag', 'settings-btn', 'site-row', 'site-host', 'silence-btn',
  'view-main', 'resurrect-btn', 'resurrect-count', 'filter', 'tab-page',
  'count-page', 'tab-all', 'count-all', 'list', 'view-sealed', 'sealed-copy',
  'sealed-autolock', 'unlock-pin', 'unlock-error', 'unlock-btn', 'view-setup',
  'setup-pin', 'setup-confirm', 'setup-error', 'setup-btn', 'view-history',
  'history-back', 'history-field', 'history-list', 'foot-actions',
  'toast', 'import-file'
];

function validateDom() {
  const missing = REQUIRED_IDS.filter(id => !document.getElementById(id));
  if (missing.length) {
    reportPopupError(
      'popup.html is missing required element(s): ' + missing.join(', '),
      'popup.html',
      0,
      0
    );
  }
  return missing.length === 0;
}

(async function init() {
  validateDom();

  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      state.tabId = tab.id;
      if (typeof tab.url === 'string') {
        state.url = normalizeUrl(tab.url);
        try {
          const parsed = new URL(state.url || tab.url);
          state.host = parsed.hostname.replace(/^www\./, '');
          state.path = parsed.pathname + parsed.search;
        } catch (e) { /* keep defaults */ }
      }
    }
  } catch (e) {
    toast('could not read the active tab');
  }

  wire();
  await reload();
})();
