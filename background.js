'use strict';

/* Lazarus v6.0 — background
 *
 * Single writer for the vault. Every mutation is serialized through one queue,
 * so the popup and content scripts can never clobber each other.
 *
 * Storage (v6):
 *   lz.meta       { v, locked, salt, iter, wrapped }        plaintext
 *   lz.index      [ {id,url,host,field,ts,pinned,preview,size} ]   sealed when locked
 *   lz.e.<id>     { v, versions:[{text,ts}] }                       sealed when locked
 *   lz.settings   { ... }                                   plaintext
 *   lz.blacklist  [ host ]                                  plaintext
 *   storage.session.lz.key                                  raw data key (hex)
 *
 * The PIN never derives the data key directly: a random data key (DEK) is
 * wrapped by a PIN-derived KEK, so changing a PIN never touches the data.
 */

const api = globalThis.browser || globalThis.chrome;

const K = {
  meta: 'lz.meta',
  index: 'lz.index',
  entryPrefix: 'lz.e.',
  settings: 'lz.settings',
  blacklist: 'lz.blacklist',
  sessionKey: 'lz.key',
  legacy: {
    blob: 'lazarus_entries',
    settings: 'lazarus_settings',
    blacklist: 'lazarus_blacklist',
    lock: 'lazarus_lock',
    salt: 'lazarus_salt_storage',
    hash: 'lazarus_pin_hash_storage',
    encSalt: 'lazarus_enc_salt_storage',
    session: 'lazarus_session_unlocked',
    key: 'lazarus_encryption_key'
  }
};

const MAX_ENTRIES = 500;
const MAX_VERSIONS = 10;
const MAX_TEXT = 10000;
const MAX_FIELD = 300;
const MAX_URL = 2048;
const PREVIEW = 180;
const KDF_ITER = 600000;
const LEGACY_ITER = 100000;

const DEFAULT_SETTINGS = {
  savePasswords: false,
  retentionHours: 720,
  searchIndexing: true,
  paletteEnabled: true,
  autoLockMinutes: 15
};

let meta = null;
let key = null;
let indexCache = null;
let settings = { ...DEFAULT_SETTINGS };
let blacklist = [];
let ready = null;
let writeChain = Promise.resolve();
let savesSincePrune = 0;
let failures = 0;
let lockoutUntil = 0;

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let out = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(out);
}

function unb64(str) {
  const raw = atob(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeUrl(input) {
  if (typeof input !== 'string' || input.length > MAX_URL) return null;
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

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function err(code, extra) {
  return { ok: false, error: code, ...(extra || {}) };
}

/* Options is opened in a normal tab, so an extension page may legitimately
 * arrive with sender.tab set. Check the sender URL instead of the presence of
 * a tab, otherwise every options-page action (settings, PIN, import/export,
 * erase) is rejected with FORBIDDEN. */
function assertExtensionPage(sender) {
  if (!sender) throw new Error('FORBIDDEN');
  if (sender.id && api.runtime.id && sender.id !== api.runtime.id) throw new Error('FORBIDDEN');
  const base = api.runtime.getURL('');
  const url = typeof sender.url === 'string' && sender.url
    ? sender.url
    : sender.tab && typeof sender.tab.url === 'string' ? sender.tab.url : '';
  if (!url || !url.startsWith(base)) throw new Error('FORBIDDEN');
}

const storage = api.storage && api.storage.local;
const session = api.storage && api.storage.session;

async function getVal(name) {
  if (!storage) throw new Error('STORAGE_UNAVAILABLE');
  const got = await storage.get(name);
  return got[name];
}

async function setVal(name, value) {
  if (!storage) throw new Error('STORAGE_UNAVAILABLE');
  await storage.set({ [name]: value });
}

async function delVals(names) {
  if (!storage) throw new Error('STORAGE_UNAVAILABLE');
  if (names.length) await storage.remove(names);
}

/* ------------------------------------------------------------------ */
/* crypto                                                              */
/* ------------------------------------------------------------------ */

async function deriveKEK(pin, saltBytes, iterations) {
  const material = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: iterations || KDF_ITER, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function rawKeyBytes(k) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', k));
}

async function importKeyBytes(bytes, extractable) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, extractable !== false, ['encrypt', 'decrypt']);
}

async function encryptJSON(k, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(value)));
  return { v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function decryptJSON(k, envelope) {
  const iv = typeof envelope.iv === 'string' ? unb64(envelope.iv) : new Uint8Array(envelope.iv);
  const ct = typeof envelope.ct === 'string' ? unb64(envelope.ct) : new Uint8Array(envelope.ct);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct);
  return JSON.parse(dec.decode(pt));
}

async function wrapRaw(kek, raw) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw);
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function unwrapRaw(kek, wrapped) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(wrapped.iv) },
    kek,
    unb64(wrapped.ct)
  );
  return new Uint8Array(pt);
}

async function saveSessionKey(k) {
  try {
    await session.set({ [K.sessionKey]: hex(await rawKeyBytes(k)) });
  } catch (e) { /* session storage is best effort */ }
}

async function loadSessionKey() {
  try {
    const got = await session.get(K.sessionKey);
    const value = got[K.sessionKey];
    if (!value) return null;
    const bytes = new Uint8Array(value.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    return await importKeyBytes(bytes, true);
  } catch { return null; }
}

async function clearSessionKey() {
  try { await session.remove(K.sessionKey); } catch (e) { /* ignore */ }
}

/* legacy v5 crypto — PBKDF2/100k over a hex salt string + purpose */
async function legacyBits(pin, salt, purpose) {
  const material = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt + purpose), iterations: LEGACY_ITER, hash: 'SHA-256' },
    material,
    256
  );
  return new Uint8Array(bits);
}

async function legacyKey(pin, encSalt) {
  return importKeyBytes(await legacyBits(pin, encSalt, 'encrypt'), false);
}

async function legacyHash(pin, salt) {
  return hex(await legacyBits(pin, salt, 'verify'));
}

/* ------------------------------------------------------------------ */
/* state guards                                                        */
/* ------------------------------------------------------------------ */

function isSealed() {
  return !!(meta && meta.locked);
}

function isUnlocked() {
  return !isSealed() || !!key;
}

function mutex(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/* ------------------------------------------------------------------ */
/* talking to the page                                                */
/* ------------------------------------------------------------------ */

/* A tab that was already open when Lazarus was installed, updated or
 * reloaded has no content script until it is reloaded. Restore used to fail
 * there with "cannot reach this page". Injecting content.js on demand (the
 * `scripting` permission, plus activeTab from the toolbar click) makes
 * restore work in those tabs too. */
async function injectContentScript(tabId) {
  if (!Number.isInteger(tabId) || !api.scripting || !api.scripting.executeScript) return false;
  try {
    await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (e) {
    return false;
  }
}

async function callTab(tabId, message, timeout) {
  if (!Number.isInteger(tabId)) return { ok: false, error: 'NO_CONTENT' };
  try {
    return await Promise.race([
      api.tabs.sendMessage(tabId, message),
      new Promise(resolve => setTimeout(
        () => resolve({ ok: false, error: 'TIMEOUT' }),
        timeout || 5000
      ))
    ]);
  } catch (e) {
    return { ok: false, error: 'NO_CONTENT' };
  }
}

async function messageTab(tabId, message, timeout) {
  const first = await callTab(tabId, message, timeout);
  if (!first || (first.error !== 'NO_CONTENT' && first.error !== 'TIMEOUT')) {
    return first || { ok: false, error: 'NO_CONTENT' };
  }
  if (!(await injectContentScript(tabId))) return first;
  /* content.js is idempotent (window.__lazarusInstalled), so a retry is safe
   * even if the first message only timed out. */
  await new Promise(resolve => setTimeout(resolve, 60));
  return callTab(tabId, message, timeout);
}

/* Best effort: after a fresh install/update, give already-open tabs the
 * content script so capture starts without asking the user to reload. */
async function injectIntoOpenTabs() {
  if (!api.scripting || !api.tabs) return;
  let tabs;
  try { tabs = await api.tabs.query({}); } catch { return; }
  for (const tab of tabs) {
    if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) continue;
    await injectContentScript(tab.id);
  }
}

/* context menus are rebuilt on every worker wake; serialise those rebuilds so
 * a recreate can never race the one triggered by onInstalled/onStartup. */
let menuQueue = Promise.resolve();
function menuChain(fn) {
  const run = menuQueue.then(fn, fn);
  menuQueue = run.then(() => undefined, () => undefined);
  return run;
}

/* ------------------------------------------------------------------ */
/* vault primitives                                                    */
/* ------------------------------------------------------------------ */

async function loadIndex() {
  if (indexCache) return indexCache;
  if (isSealed() && !key) throw new Error('LOCKED');
  const raw = await getVal(K.index);
  if (!raw) {
    indexCache = [];
    return indexCache;
  }
  let value;
  try {
    value = raw.v === 1 && raw.ct ? await decryptJSON(key, raw) : raw;
  } catch (e) {
    throw new Error('DECRYPT_FAILED');
  }
  indexCache = Array.isArray(value) ? value : [];
  return indexCache;
}

async function saveIndex(idx) {
  indexCache = idx;
  const sealed = isSealed() ? await encryptJSON(key, idx) : idx;
  await setVal(K.index, sealed);
}

async function readBody(id) {
  const raw = await getVal(K.entryPrefix + id);
  if (!raw) return null;
  if (raw.v === 1 && raw.ct) {
    if (!key) throw new Error('LOCKED');
    return decryptJSON(key, raw);
  }
  return raw;
}

async function writeBody(id, body) {
  const sealed = isSealed() ? await encryptJSON(key, body) : body;
  await setVal(K.entryPrefix + id, sealed);
}

async function deleteBodies(ids) {
  await delVals(ids.map(id => K.entryPrefix + id));
}

function sortIndex(idx) {
  return idx.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
}

function makeItem(id, url, field, versions, pinned) {
  const last = versions[versions.length - 1];
  return {
    id,
    url,
    host: hostOf(url),
    field,
    ts: last.ts,
    pinned: !!pinned,
    preview: last.text.replace(/\s+/g, ' ').slice(0, PREVIEW),
    size: versions.reduce((n, v) => n + v.text.length, 0)
  };
}

/* ------------------------------------------------------------------ */
/* pruning                                                             */
/* ------------------------------------------------------------------ */

async function pruneIndex(force) {
  if (!isUnlocked()) return 0;
  let idx;
  try { idx = await loadIndex(); } catch { return 0; }
  if (!idx.length) return 0;

  const cutoff = settings.retentionHours > 0
    ? Date.now() - settings.retentionHours * 3600000
    : 0;

  const drop = [];
  let next = idx.filter(item => {
    if (item.pinned) return true;
    if (cutoff && item.ts <= cutoff) { drop.push(item.id); return false; }
    return true;
  });

  if (next.length > MAX_ENTRIES) {
    const removable = next.filter(i => !i.pinned).sort((a, b) => a.ts - b.ts);
    const excess = next.length - MAX_ENTRIES;
    const doomed = new Set(removable.slice(0, excess).map(i => i.id));
    next = next.filter(i => !doomed.has(i.id));
    doomed.forEach(id => drop.push(id));
  }

  if (drop.length || force) {
    await saveIndex(next);
    await deleteBodies(drop);
  }
  return drop.length;
}

/* ------------------------------------------------------------------ */
/* migration from v5                                                   */
/* ------------------------------------------------------------------ */

function convertLegacyEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const url = normalizeUrl(entry.pageUrl) || normalizeUrl(entry.url);
  const field = typeof entry.fieldName === 'string' ? entry.fieldName.slice(0, MAX_FIELD) : null;
  const versions = Array.isArray(entry.versions)
    ? entry.versions
        .filter(v => v && typeof v.text === 'string')
        .map(v => ({ text: v.text.slice(0, MAX_TEXT), ts: Number(v.timestamp) || Date.now() }))
        .slice(-MAX_VERSIONS)
    : [];
  if (!url || !field || !versions.length) return null;
  return { url, field, pinned: !!entry.pinned, versions };
}

async function migratePlaintextV5() {
  const blob = await getVal(K.legacy.blob);
  if (blob && blob.iv) return false; // encrypted, needs PIN

  const idx = [];
  const bodies = new Map();
  if (Array.isArray(blob)) {
    for (const raw of blob) {
      const converted = convertLegacyEntry(raw);
      if (!converted) continue;
      const id = raw.id || crypto.randomUUID();
      bodies.set(id, { v: 1, versions: converted.versions });
      idx.push(makeItem(id, converted.url, converted.field, converted.versions, converted.pinned));
    }
  }

  const payload = {};
  for (const [id, body] of bodies) payload[K.entryPrefix + id] = body;
  payload[K.index] = idx;
  payload[K.meta] = { v: 6, locked: false, createdAt: Date.now(), migratedFrom: 5 };
  await storage.set(payload);
  meta = payload[K.meta];
  indexCache = idx;
  await delVals([
    K.legacy.blob, K.legacy.lock, K.legacy.salt, K.legacy.hash,
    K.legacy.encSalt, K.legacy.session, K.legacy.key
  ]);
  return true;
}

async function readLegacyEntries(pin) {
  const blob = await getVal(K.legacy.blob);
  const encSalt = await getVal(K.legacy.encSalt);
  const salt = await getVal(K.legacy.salt);
  const hash = await getVal(K.legacy.hash);

  if (blob && blob.iv) {
    if (!encSalt) throw new Error('WRONG_PIN');
    let plain;
    try {
      const k = await legacyKey(pin, encSalt);
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(blob.iv) },
        k,
        new Uint8Array(blob.data)
      );
      plain = JSON.parse(dec.decode(pt));
    } catch {
      throw new Error('WRONG_PIN');
    }
    return Array.isArray(plain) ? plain : [];
  }

  if (salt && hash) {
    if (await legacyHash(pin, salt) !== hash) throw new Error('WRONG_PIN');
  }
  return Array.isArray(blob) ? blob : [];
}

async function unlockLegacy(pin, newMeta) {
  const legacyEntries = await readLegacyEntries(pin);

  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await rawKeyBytes(dek);
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const kek = await deriveKEK(pin, saltBytes, KDF_ITER);
  const wrapped = await wrapRaw(kek, raw);

  const idx = [];
  const payload = {};
  for (const rawEntry of legacyEntries) {
    const converted = convertLegacyEntry(rawEntry);
    if (!converted) continue;
    const id = rawEntry.id || crypto.randomUUID();
    const body = { v: 1, versions: converted.versions };
    payload[K.entryPrefix + id] = await encryptJSON(dek, body);
    idx.push(makeItem(id, converted.url, converted.field, converted.versions, converted.pinned));
  }

  const nextMeta = {
    v: 6,
    locked: true,
    salt: b64(saltBytes),
    iter: KDF_ITER,
    wrapped,
    createdAt: Date.now(),
    migratedFrom: 5
  };
  payload[K.index] = await encryptJSON(dek, idx);
  payload[K.meta] = nextMeta;

  await storage.set(payload);
  await delVals([
    K.legacy.blob, K.legacy.lock, K.legacy.salt, K.legacy.hash,
    K.legacy.encSalt, K.legacy.session, K.legacy.key
  ]);

  meta = nextMeta;
  key = dek;
  indexCache = idx;
  await saveSessionKey(dek);
  return { ok: true, state: await buildState(null), migrated: true };
}

async function prepareLegacyMeta() {
  const lock = await getVal(K.legacy.lock);
  const blob = await getVal(K.legacy.blob);
  const salt = await getVal(K.legacy.salt);
  const hash = await getVal(K.legacy.hash);
  const encSalt = await getVal(K.legacy.encSalt);
  if (!blob && !lock) return null;
  if (!lock) return null; // plaintext, handled by migratePlaintextV5

  const legacyMeta = {
    v: 6,
    locked: true,
    legacy: 'v5',
    legacySalt: salt || null,
    legacyEncSalt: encSalt || null,
    legacyHash: hash || null,
    createdAt: Date.now()
  };
  await setVal(K.meta, legacyMeta);
  meta = legacyMeta;
  return legacyMeta;
}

/* ------------------------------------------------------------------ */
/* public ops                                                          */
/* ------------------------------------------------------------------ */

async function buildState(url) {
  const unlocked = isUnlocked();
  let count = 0;
  let siteCount = 0;
  let bytes = 0;
  if (unlocked) {
    try {
      const idx = await loadIndex();
      count = idx.length;
      for (const item of idx) {
        bytes += (item.size || 0) + 96;
        if (url && item.url === url) siteCount++;
      }
    } catch (e) { /* locked or corrupt: report zero */ }
  }
  return {
    ok: true,
    locked: isSealed() && !key,
    hasPin: isSealed(),
    legacy: !!(meta && meta.legacy === 'v5'),
    url,
    host: url ? hostOf(url) : '',
    blacklisted: !!(url && blacklist.includes(hostOf(url))),
    settings,
    count,
    siteCount,
    bytes,
    version: '6.0.0'
  };
}

async function saveText({ url, field, text, ts }) {
  if (!isUnlocked()) return err('LOCKED');
  const cleanUrl = normalizeUrl(url);
  if (!cleanUrl) return err('BAD_URL');
  if (typeof field !== 'string' || !field) return err('BAD_FIELD');
  if (typeof text !== 'string') return err('BAD_TEXT');

  const host = hostOf(cleanUrl);
  if (blacklist.includes(host)) return err('SILENCED');

  const cleanField = field.slice(0, MAX_FIELD);
  const cleanText = text.slice(0, MAX_TEXT);
  if (!cleanText.trim()) return err('EMPTY');

  const stamp = Number(ts) > 0 ? Number(ts) : Date.now();

  return mutex(async () => {
    const idx = await loadIndex();
    let item = idx.find(i => i.url === cleanUrl && i.field === cleanField);
    let body;
    const cutoff = settings.retentionHours > 0
      ? Date.now() - settings.retentionHours * 3600000
      : 0;

    if (item) {
      body = await readBody(item.id);
      if (!body || !Array.isArray(body.versions)) body = { v: 1, versions: [] };
      const last = body.versions[body.versions.length - 1];
      if (last && last.text === cleanText) {
        return { ok: true, unchanged: true };
      }
      if (cutoff && !item.pinned) {
        body.versions = body.versions.filter(v => v.ts > cutoff);
      }
      body.versions.push({ text: cleanText, ts: stamp });
      if (body.versions.length > MAX_VERSIONS) body.versions = body.versions.slice(-MAX_VERSIONS);
      const refreshed = makeItem(item.id, cleanUrl, cleanField, body.versions, item.pinned);
      item.ts = refreshed.ts;
      item.preview = refreshed.preview;
      item.size = refreshed.size;
      item.host = refreshed.host;
    } else {
      const id = crypto.randomUUID();
      body = { v: 1, versions: [{ text: cleanText, ts: stamp }] };
      item = makeItem(id, cleanUrl, cleanField, body.versions, false);
      idx.push(item);
    }

    await writeBody(item.id, body);
    await saveIndex(idx);

    savesSincePrune++;
    if (savesSincePrune >= 25) {
      savesSincePrune = 0;
      await pruneIndex(false).catch(() => {});
    }
    return { ok: true, id: item.id };
  });
}

async function listEntries({ url, all, query }) {
  if (!isUnlocked()) return err('LOCKED');
  const idx = await loadIndex();
  let list = all ? idx.slice() : idx.filter(i => i.url === url);
  const q = (query || '').trim().toLowerCase();
  if (q) {
    list = list.filter(i =>
      i.field.toLowerCase().includes(q) ||
      i.url.toLowerCase().includes(q) ||
      (i.preview || '').toLowerCase().includes(q)
    );
  }
  return { ok: true, entries: sortIndex(list) };
}

async function getEntry({ id }) {
  if (!isUnlocked()) return err('LOCKED');
  if (!id) return err('NO_ID');
  const idx = await loadIndex();
  const item = idx.find(i => i.id === id);
  if (!item) return err('NOT_FOUND');
  const body = await readBody(id);
  if (!body) return err('NOT_FOUND');
  return { ok: true, entry: { ...item, versions: body.versions || [] } };
}

async function getField({ url, fields }) {
  if (!isUnlocked()) return err('LOCKED');
  const cleanUrl = normalizeUrl(url);
  if (!cleanUrl) return err('BAD_URL');
  const idx = await loadIndex();
  const candidates = (Array.isArray(fields) ? fields : []).filter(f => typeof f === 'string');
  let item = null;
  for (const field of candidates) {
    item = idx.find(i => i.url === cleanUrl && i.field === field);
    if (item) break;
  }
  if (!item) return err('NONE');
  const body = await readBody(item.id);
  if (!body) return err('NONE');
  return { ok: true, entry: { id: item.id, field: item.field, versions: body.versions || [] } };
}

async function restorePayload({ url }) {
  if (!isUnlocked()) return err('LOCKED');
  const cleanUrl = normalizeUrl(url);
  if (!cleanUrl) return err('BAD_URL');
  const idx = sortIndex((await loadIndex()).filter(i => i.url === cleanUrl));
  const items = [];
  for (const item of idx) {
    let body;
    try { body = await readBody(item.id); } catch { continue; }
    const last = body && body.versions && body.versions[body.versions.length - 1];
    if (last && last.text) items.push({ field: item.field, text: last.text });
  }
  return { ok: true, items };
}

async function deleteEntry({ id }) {
  if (!isUnlocked()) return err('LOCKED');
  return mutex(async () => {
    const idx = await loadIndex();
    const next = idx.filter(i => i.id !== id);
    if (next.length === idx.length) return err('NOT_FOUND');
    await saveIndex(next);
    await deleteBodies([id]);
    return { ok: true };
  });
}

async function togglePin({ id }) {
  if (!isUnlocked()) return err('LOCKED');
  return mutex(async () => {
    const idx = await loadIndex();
    const item = idx.find(i => i.id === id);
    if (!item) return err('NOT_FOUND');
    item.pinned = !item.pinned;
    await saveIndex(idx);
    return { ok: true, pinned: item.pinned };
  });
}

async function promoteVersion({ id, ts }) {
  if (!isUnlocked()) return err('LOCKED');
  return mutex(async () => {
    const idx = await loadIndex();
    const item = idx.find(i => i.id === id);
    if (!item) return err('NOT_FOUND');
    const body = await readBody(id);
    if (!body || !Array.isArray(body.versions)) return err('NOT_FOUND');
    const at = body.versions.findIndex(v => v.ts === ts);
    if (at === -1) return err('NOT_FOUND');
    const [version] = body.versions.splice(at, 1);
    version.ts = Date.now();
    body.versions.push(version);
    await writeBody(id, body);
    const refreshed = makeItem(item.id, item.url, item.field, body.versions, item.pinned);
    item.ts = refreshed.ts;
    item.preview = refreshed.preview;
    item.size = refreshed.size;
    await saveIndex(idx);
    return { ok: true };
  });
}

async function forgetVersion({ id, ts }) {
  if (!isUnlocked()) return err('LOCKED');
  return mutex(async () => {
    const idx = await loadIndex();
    const item = idx.find(i => i.id === id);
    if (!item) return err('NOT_FOUND');
    const body = await readBody(id);
    if (!body || !Array.isArray(body.versions)) return err('NOT_FOUND');
    const at = body.versions.findIndex(v => v.ts === ts);
    if (at === -1) return err('NOT_FOUND');
    body.versions.splice(at, 1);

    if (!body.versions.length) {
      await saveIndex(idx.filter(i => i.id !== id));
      await deleteBodies([id]);
      return { ok: true, removed: true };
    }

    await writeBody(id, body);
    const refreshed = makeItem(item.id, item.url, item.field, body.versions, item.pinned);
    item.ts = refreshed.ts;
    item.preview = refreshed.preview;
    item.size = refreshed.size;
    await saveIndex(idx);
    return { ok: true, removed: false, versions: body.versions.length };
  });
}

async function exportVault() {
  if (!isUnlocked()) return err('LOCKED');
  const idx = sortIndex(await loadIndex());
  const entries = [];
  for (const item of idx) {
    const body = await readBody(item.id).catch(() => null);
    if (!body) continue;
    entries.push({
      id: item.id,
      pageUrl: item.url,
      fieldName: item.field,
      pinned: !!item.pinned,
      versions: (body.versions || []).map(v => ({ text: v.text, timestamp: v.ts }))
    });
  }
  return {
    ok: true,
    json: JSON.stringify({ app: 'lazarus', version: 6, exportedAt: new Date().toISOString(), entries }, null, 2),
    count: entries.length
  };
}

function sanitizeImported(entry) {
  const converted = convertLegacyEntry(entry);
  if (!converted) return null;
  return { ...converted, id: crypto.randomUUID() };
}

async function importVault({ json }) {
  if (!isUnlocked()) return err('LOCKED');
  let parsed;
  try { parsed = JSON.parse(json); } catch { return err('BAD_JSON'); }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.entries) ? parsed.entries : null;
  if (!list) return err('BAD_FORMAT');

  return mutex(async () => {
    const idx = await loadIndex();
    let added = 0;
    let skipped = 0;
    for (const raw of list) {
      const entry = sanitizeImported(raw);
      if (!entry) { skipped++; continue; }
      if (idx.some(i => i.url === entry.url && i.field === entry.field)) { skipped++; continue; }
      const body = { v: 1, versions: entry.versions };
      await writeBody(entry.id, body);
      idx.push(makeItem(entry.id, entry.url, entry.field, entry.versions, entry.pinned));
      added++;
    }
    if (added) await saveIndex(idx);
    return { ok: true, added, skipped };
  });
}

/* ------------------------------------------------------------------ */
/* PIN                                                                 */
/* ------------------------------------------------------------------ */

async function setupPin({ pin }) {
  if (typeof pin !== 'string' || pin.length < 6) return err('WEAK_PIN');
  if (pin.length > 200) return err('BAD_PIN');
  if (isSealed()) return err('ALREADY_SEALED');

  return mutex(async () => {
    const idx = await loadIndex();
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = await rawKeyBytes(dek);
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKEK(pin, saltBytes, KDF_ITER);
    const wrapped = await wrapRaw(kek, raw);

    const payload = {};
    for (const item of idx) {
      const body = await readBody(item.id);
      if (!body) continue;
      payload[K.entryPrefix + item.id] = await encryptJSON(dek, body);
    }
    payload[K.index] = await encryptJSON(dek, idx);

    const nextMeta = {
      v: 6,
      locked: true,
      salt: b64(saltBytes),
      iter: KDF_ITER,
      wrapped,
      createdAt: Date.now()
    };
    payload[K.meta] = nextMeta;

    await storage.set(payload);
    meta = nextMeta;
    key = dek;
    indexCache = idx;
    await saveSessionKey(dek);
    return { ok: true, state: await buildState(null) };
  });
}

async function unlockVault({ pin }) {
  if (!isSealed()) return { ok: true, state: await buildState(null) };
  if (Date.now() < lockoutUntil) {
    return err('LOCKED_OUT', { retryAfter: Math.ceil((lockoutUntil - Date.now()) / 1000) });
  }
  if (typeof pin !== 'string' || !pin) return err('BAD_PIN');

  if (meta.legacy === 'v5') {
    return mutex(async () => {
      try {
        const result = await unlockLegacy(pin, meta);
        failures = 0;
        return result;
      } catch (e) {
        noteFailure();
        return err(e.message === 'WRONG_PIN' ? 'WRONG_PIN' : 'UNLOCK_FAILED');
      }
    });
  }

  return mutex(async () => {
    try {
      const kek = await deriveKEK(pin, unb64(meta.salt), meta.iter || KDF_ITER);
      let raw;
      try {
        raw = await unwrapRaw(kek, meta.wrapped);
      } catch {
        noteFailure();
        return err('WRONG_PIN');
      }
      const dek = await importKeyBytes(raw, true);
      const rawIdx = await getVal(K.index);
      const idx = rawIdx ? await decryptJSON(dek, rawIdx) : [];
      key = dek;
      indexCache = Array.isArray(idx) ? idx : [];
      failures = 0;
      await saveSessionKey(dek);
      return { ok: true, state: await buildState(null) };
    } catch (e) {
      return err('UNLOCK_FAILED');
    }
  });
}

function noteFailure() {
  failures++;
  if (failures >= 5) {
    lockoutUntil = Date.now() + 15000;
    failures = 0;
  }
}

async function sealVault() {
  key = null;
  indexCache = null;
  await clearSessionKey();
  return { ok: true, state: await buildState(null) };
}

async function changePin({ oldPin, newPin }) {
  if (!isSealed()) return err('NOT_SEALED');
  if (meta.legacy === 'v5') return err('LEGACY');
  if (typeof newPin !== 'string' || newPin.length < 6) return err('WEAK_PIN');
  if (Date.now() < lockoutUntil) return err('LOCKED_OUT');

  return mutex(async () => {
    let raw;
    try {
      const kek = await deriveKEK(oldPin, unb64(meta.salt), meta.iter || KDF_ITER);
      raw = await unwrapRaw(kek, meta.wrapped);
    } catch {
      noteFailure();
      return err('WRONG_PIN');
    }
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const kek = await deriveKEK(newPin, saltBytes, KDF_ITER);
    const wrapped = await wrapRaw(kek, raw);
    const nextMeta = { ...meta, salt: b64(saltBytes), iter: KDF_ITER, wrapped, changedAt: Date.now() };
    await setVal(K.meta, nextMeta);
    meta = nextMeta;
    key = await importKeyBytes(raw, true);
    await saveSessionKey(key);
    return { ok: true };
  });
}

async function removePin({ pin }) {
  if (!isSealed()) return err('NOT_SEALED');
  if (meta.legacy === 'v5') {
    const unlocked = await unlockVault({ pin });
    if (!unlocked.ok) return unlocked;
  }

  return mutex(async () => {
    let dek;
    try {
      const kek = await deriveKEK(pin, unb64(meta.salt), meta.iter || KDF_ITER);
      dek = await importKeyBytes(await unwrapRaw(kek, meta.wrapped), false);
    } catch {
      noteFailure();
      return err('WRONG_PIN');
    }

    const payload = {};
    let idx;
    try {
      const rawIdx = await getVal(K.index);
      idx = rawIdx ? await decryptJSON(dek, rawIdx) : [];
      for (const item of idx) {
        const rawBody = await getVal(K.entryPrefix + item.id);
        if (!rawBody) continue;
        const body = rawBody.v === 1 && rawBody.ct ? await decryptJSON(dek, rawBody) : rawBody;
        payload[K.entryPrefix + item.id] = body;
      }
    } catch {
      return err('DECRYPT_FAILED');
    }

    payload[K.index] = idx;
    const nextMeta = { v: 6, locked: false, createdAt: Date.now() };
    payload[K.meta] = nextMeta;
    await storage.set(payload);

    meta = nextMeta;
    key = null;
    indexCache = idx;
    await clearSessionKey();
    return { ok: true, state: await buildState(null) };
  });
}

async function eraseVault() {
  if (!isUnlocked()) return err('LOCKED');
  return mutex(async () => {
    const idx = await loadIndex().catch(() => []);
    await deleteBodies(idx.map(i => i.id));
    await delVals([K.index, K.meta, K.sessionKey]);
    meta = { v: 6, locked: false, createdAt: Date.now() };
    await setVal(K.meta, meta);
    indexCache = [];
    key = null;
    await clearSessionKey();
    return { ok: true, state: await buildState(null) };
  });
}

/* ------------------------------------------------------------------ */
/* settings + blacklist                                                */
/* ------------------------------------------------------------------ */

function coerceSettings(input) {
  const next = { ...settings };
  if (!input || typeof input !== 'object') return next;
  if (typeof input.savePasswords === 'boolean') next.savePasswords = input.savePasswords;
  if (typeof input.searchIndexing === 'boolean') next.searchIndexing = input.searchIndexing;
  if (typeof input.paletteEnabled === 'boolean') next.paletteEnabled = input.paletteEnabled;
  if (Number.isFinite(input.retentionHours)) {
    next.retentionHours = Math.min(8760, Math.max(0, Math.round(input.retentionHours)));
  }
  if (Number.isFinite(input.autoLockMinutes)) {
    next.autoLockMinutes = [0, 5, 15, 30, 60].includes(Math.round(input.autoLockMinutes))
      ? Math.round(input.autoLockMinutes)
      : 15;
  }
  return next;
}

async function saveSettings(input) {
  settings = coerceSettings(input);
  await setVal(K.settings, settings);
  configureIdle();
  // prune through the single-writer queue so it can never clobber a concurrent save
  await mutex(() => pruneIndex(false)).catch(() => {});
  return { ok: true, settings };
}

async function toggleBlacklist({ url }) {
  const host = hostOf(normalizeUrl(url) || '');
  if (!host) return err('BAD_URL');
  const at = blacklist.indexOf(host);
  if (at === -1) blacklist.push(host);
  else blacklist.splice(at, 1);
  await setVal(K.blacklist, blacklist);
  return { ok: true, blacklisted: blacklist.includes(host) };
}

function configureIdle() {
  try {
    api.idle.setDetectionInterval(settings.autoLockMinutes > 0 ? settings.autoLockMinutes * 60 : 86400);
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  try {
    const stored = await storage.get([
      K.settings, K.blacklist, K.meta,
      K.legacy.settings, K.legacy.blacklist, K.legacy.lock,
      K.legacy.blob, K.legacy.salt, K.legacy.hash, K.legacy.encSalt
    ]);

    const rawSettings = stored[K.settings] || stored[K.legacy.settings];
    settings = { ...DEFAULT_SETTINGS, ...(rawSettings || {}) };
    blacklist = stored[K.blacklist] || stored[K.legacy.blacklist] || [];

    if (!stored[K.settings]) await setVal(K.settings, settings);
    if (!stored[K.blacklist] && Array.isArray(stored[K.legacy.blacklist])) {
      await setVal(K.blacklist, blacklist);
    }

    if (stored[K.meta]) {
      meta = stored[K.meta];
    } else if (stored[K.legacy.lock] === true) {
      await prepareLegacyMeta();
    } else {
      await migratePlaintextV5();
    }

    if (isSealed()) {
      key = await loadSessionKey();
    } else {
      key = null;
      await clearSessionKey();
    }

    configureIdle();

    if (isUnlocked()) {
      await loadIndex().catch(() => { indexCache = []; });
      await pruneIndex(false).catch(() => {});
    }

    // remove any stale v5 artefacts once v6 is healthy
    if (meta && !meta.legacy) {
      await delVals([K.legacy.blob, K.legacy.lock, K.legacy.salt, K.legacy.hash,
        K.legacy.encSalt, K.legacy.session, K.legacy.key,
        K.legacy.settings, K.legacy.blacklist]).catch(() => {});
    }
  } catch (e) {
    console.error('[Lazarus] init failed:', e);
  }
}

async function buildContextMenu() {
  /* Firefox for Android has no contextMenus API; skip it silently. */
  if (!api.contextMenus) return;
  return menuChain(async () => {
    try { await api.contextMenus.removeAll(); } catch (e) { /* ignore */ }
    createMenus();
  });
}

function createMenus() {
  if (!api.contextMenus) return;
  try {
    api.contextMenus.create({
      id: 'lz-restore-field',
      title: 'Resurrect this field',
      contexts: ['editable']
    });
    api.contextMenus.create({
      id: 'lz-restore-page',
      title: 'Resurrect this page',
      contexts: ['page']
    });
    api.contextMenus.create({ id: 'lz-sep', type: 'separator', contexts: ['page'] });
    api.contextMenus.create({
      id: 'lz-silence',
      title: 'Silence / unsilence this site',
      contexts: ['page']
    });
  } catch (e) { /* menus are best effort */ }
}

/* listeners are registered synchronously so nothing is missed on wake */
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  (async () => {
    await ready;
    switch (msg.type) {
      case 'lz:state':
        return buildState(normalizeUrl(msg.url));

      case 'lz:save':
        return saveText({
          url: sender.tab && sender.tab.url ? sender.tab.url : msg.url,
          field: msg.field,
          text: msg.text,
          ts: msg.ts
        });

      case 'lz:list':
        return listEntries({ url: normalizeUrl(msg.url), all: !!msg.all, query: msg.query });

      case 'lz:entry':
        return getEntry({ id: msg.id });

      case 'lz:field':
        return getField({ url: normalizeUrl(msg.url), fields: msg.fields });

      case 'lz:payload':
        return restorePayload({ url: normalizeUrl(msg.url) });

      case 'lz:delete':
        return deleteEntry({ id: msg.id });

      case 'lz:pin':
        assertExtensionPage(sender);
        return togglePin({ id: msg.id });

      case 'lz:promote':
        assertExtensionPage(sender);
        return promoteVersion({ id: msg.id, ts: msg.ts });

      case 'lz:forget-version':
        return forgetVersion({ id: msg.id, ts: msg.ts });

      case 'lz:export':
        assertExtensionPage(sender);
        return exportVault();

      case 'lz:import':
        assertExtensionPage(sender);
        return importVault({ json: msg.json });

      case 'lz:set-pin':
        assertExtensionPage(sender);
        return setupPin({ pin: msg.pin });

      case 'lz:unlock':
        assertExtensionPage(sender);
        return unlockVault({ pin: msg.pin });

      case 'lz:seal':
        assertExtensionPage(sender);
        return sealVault();

      case 'lz:change-pin':
        assertExtensionPage(sender);
        return changePin({ oldPin: msg.oldPin, newPin: msg.newPin });

      case 'lz:remove-pin':
        assertExtensionPage(sender);
        return removePin({ pin: msg.pin });

      case 'lz:erase':
        assertExtensionPage(sender);
        return eraseVault();

      case 'lz:blacklist':
        assertExtensionPage(sender);
        return toggleBlacklist({ url: msg.url });

      case 'lz:settings':
        assertExtensionPage(sender);
        return saveSettings(msg.settings);

      case 'lz:blacklist-list':
        assertExtensionPage(sender);
        return { ok: true, blacklist: blacklist.slice().sort() };

      case 'lz:remove-site':
        assertExtensionPage(sender);
        blacklist = blacklist.filter(h => h !== msg.host);
        await setVal(K.blacklist, blacklist);
        return { ok: true, blacklist: blacklist.slice().sort() };

      case 'lz:restore-field':
        assertExtensionPage(sender);
        return messageTab(msg.tabId, {
          type: 'lz:restore',
          url: normalizeUrl(msg.url),
          field: msg.field,
          text: msg.text
        }, 5000);

      case 'lz:restore-all':
        assertExtensionPage(sender);
        return messageTab(msg.tabId, {
          type: 'lz:restore-all',
          url: normalizeUrl(msg.url),
          items: Array.isArray(msg.items) ? msg.items : []
        }, 8000);

      case 'lz:toggle-palette':
        assertExtensionPage(sender);
        return messageTab(msg.tabId, { type: 'lz:toggle-palette' }, 4000);

      default:
        return { ok: false, error: 'UNKNOWN' };
    }
  })().then(sendResponse).catch(e => {
    console.error('[Lazarus] message failed:', msg.type, e);
    sendResponse({ ok: false, error: e && e.message === 'FORBIDDEN' ? 'FORBIDDEN' : 'ERROR' });
  });

  return true;
});

if (api.idle && api.idle.onStateChanged) {
  api.idle.onStateChanged.addListener(state => {
    if (state === 'active') return;
    /* On Chromium the service worker may have been woken by this very event,
     * so meta/key/settings are still empty until init() resolves. */
    ready.then(() => {
      if (!meta || !meta.locked || !key) return;
      if (settings.autoLockMinutes <= 0) return;
      return sealVault();
    }).catch(() => {});
  });
}

api.runtime.onInstalled.addListener(() => { buildContextMenu(); injectIntoOpenTabs(); });
api.runtime.onStartup.addListener(() => { buildContextMenu(); injectIntoOpenTabs(); });

if (api.contextMenus && api.contextMenus.onClicked) {
  api.contextMenus.onClicked.addListener(async info => {
    await ready;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    if (info.menuItemId === 'lz-silence' && tab.url) {
      await toggleBlacklist({ url: tab.url });
      return;
    }

    if (!isUnlocked()) {
      /* openPopup is desktop-only on some Chromium builds and may be missing
       * or unimplemented on Android; never let that break the menu action. */
      try {
        if (api.action && api.action.openPopup) {
          const opening = api.action.openPopup();
          if (opening && opening.catch) opening.catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return;
    }

    if (info.menuItemId === 'lz-restore-field') {
      try {
        const active = await callTab(tab.id, { type: 'lz:get-active-field' }, 2500);
        if (!active || !active.field) return;
        const url = normalizeUrl(tab.url);
        const idx = await loadIndex();
        const item = idx.find(i => i.url === url && i.field === active.field);
        if (!item) return;
        const body = await readBody(item.id);
        const last = body && body.versions && body.versions[body.versions.length - 1];
        if (!last) return;
        await messageTab(tab.id, {
          type: 'lz:restore',
          url,
          field: item.field,
          text: last.text
        }, 5000);
      } catch (e) { /* tab without a content script */ }
    }

    if (info.menuItemId === 'lz-restore-page') {
      try {
        const url = normalizeUrl(tab.url);
        const payload = await restorePayload({ url });
        if (payload.ok && payload.items.length) {
          await messageTab(tab.id, { type: 'lz:restore-all', url, items: payload.items }, 8000);
        }
      } catch (e) { /* ignore */ }
    }
  });
}

if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(async command => {
    if (command !== 'open-command-palette') return;
    await ready;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      await messageTab(tab.id, { type: 'lz:toggle-palette' }, 4000);
    }
  });
}

ready = init();
buildContextMenu();
