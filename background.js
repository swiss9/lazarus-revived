const browser = globalThis.browser || globalThis.chrome;

const STORAGE_KEY = "lazarus_entries";
const MAX_ENTRIES = 500;
const MAX_VERSIONS = 10;
const MAX_TEXT_LENGTH = 10000;
const MAX_FIELD_NAME_LENGTH = 200;

let cachedBlacklist = [];
let cachedSettings = {};
let encryptionKey = null;

async function loadSettings() {
  const { lazarus_settings } = await browser.storage.local.get("lazarus_settings");
  cachedSettings = lazarus_settings || {};
}

async function loadBlacklist() {
  const { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
  cachedBlacklist = lazarus_blacklist || [];
}

function isBlacklisted(url) {
  try {
    const hostname = new URL(url).hostname;
    return cachedBlacklist.includes(hostname);
  } catch { return false; }
}

function cleanExpired(entries) {
  const retention = cachedSettings.retentionHours || 0;
  if (retention === 0) return entries;
  const cutoff = Date.now() - retention * 60 * 60 * 1000;
  return entries.map(entry => {
    if (entry.pinned) return entry;
    const validVersions = entry.versions.filter(v => v.timestamp > cutoff);
    if (validVersions.length === 0) return null;
    entry.versions = validVersions;
    return entry;
  }).filter(e => e !== null);
}

async function getLockState() {
  const { lazarus_lock } = await browser.storage.local.get("lazarus_lock");
  return lazarus_lock === true;
}

async function getSessionUnlocked() {
  const { lazarus_session_unlocked } = await browser.storage.session.get("lazarus_session_unlocked");
  return lazarus_session_unlocked === true;
}

async function encryptData(plaintext) {
  if (!encryptionKey) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, encoded);
  return { iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
}

async function decryptData(encrypted) {
  if (!encryptionKey) return null;
  const iv = new Uint8Array(encrypted.iv);
  const ciphertext = new Uint8Array(encrypted.ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encryptionKey, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function getEntries() {
  const lock = await getLockState();
  const unlocked = await getSessionUnlocked();
  if (lock && !unlocked) return null;

  const raw = await browser.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY] || [];

  if (stored.encrypted) {
    if (!encryptionKey) return null;
    const decrypted = await decryptData(stored.data);
    if (!decrypted) return null;
    try { return JSON.parse(decrypted); } catch { return []; }
  }
  return Array.isArray(stored) ? stored : [];
}

async function saveEntries(entries) {
  let toStore = entries;
  if (encryptionKey) {
    const encrypted = await encryptData(JSON.stringify(entries));
    if (encrypted) {
      toStore = { encrypted: true, data: encrypted };
    }
  }
  await browser.storage.local.set({ [STORAGE_KEY]: toStore });
}

async function saveEntry(newEntry) {
  if (typeof newEntry.pageUrl !== 'string' || typeof newEntry.fieldName !== 'string' || typeof newEntry.text !== 'string') return;
  newEntry.text = newEntry.text.slice(0, MAX_TEXT_LENGTH);
  newEntry.fieldName = newEntry.fieldName.slice(0, MAX_FIELD_NAME_LENGTH);
  if (!newEntry.pageUrl || !newEntry.fieldName || !newEntry.text) return;

  if (isBlacklisted(newEntry.pageUrl)) return;

  let entries = await getEntries();
  if (entries === null) return;

  const existingIndex = entries.findIndex(e => e.pageUrl === newEntry.pageUrl && e.fieldName === newEntry.fieldName);
  if (existingIndex !== -1) {
    const existing = entries[existingIndex];
    const lastVersion = existing.versions[existing.versions.length - 1];
    if (newEntry.text !== lastVersion.text) {
      existing.versions.push({ text: newEntry.text, timestamp: Date.now() });
      if (existing.versions.length > MAX_VERSIONS) {
        existing.versions = existing.versions.slice(-MAX_VERSIONS);
      }
    }
  } else {
    newEntry.id = crypto.randomUUID ? crypto.randomUUID() : uuidFallback();
    newEntry.versions = [{ text: newEntry.text, timestamp: Date.now() }];
    newEntry.pinned = false;
    entries.push(newEntry);
  }

  entries.sort((a, b) => b.versions[b.versions.length - 1].timestamp - a.versions[a.versions.length - 1].timestamp);
  entries = entries.slice(0, MAX_ENTRIES);
  entries = cleanExpired(entries);
  await saveEntries(entries);
}

function uuidFallback() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "saveText") {
    saveEntry({
      pageUrl: msg.data.pageUrl,
      fieldName: msg.data.fieldName,
      text: msg.data.text
    }).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.action === "getSavedData") {
    (async () => {
      const lock = await getLockState();
      const unlocked = await getSessionUnlocked();
      if (lock && !unlocked) {
        sendResponse({ entries: [], locked: true });
        return;
      }
      const entries = await getEntries();
      if (entries === null) {
        sendResponse({ entries: [], locked: true });
        return;
      }
      let list = entries;
      if (msg.currentTabUrl) list = list.filter(e => e.pageUrl === msg.currentTabUrl);
      if (msg.fieldName) list = list.filter(e => e.fieldName === msg.fieldName);
      sendResponse({ entries: list });
    })();
    return true;
  }

  if (msg.action === "deleteEntry") {
    (async () => {
      const entries = await getEntries();
      if (entries === null) { sendResponse({ success: false }); return; }
      const filtered = entries.filter(e => e.id !== msg.entryId);
      await saveEntries(filtered);
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "togglePin") {
    (async () => {
      const entries = await getEntries();
      if (entries === null) { sendResponse({ success: false }); return; }
      const entry = entries.find(e => e.id === msg.entryId);
      if (entry) {
        entry.pinned = !entry.pinned;
        await saveEntries(entries);
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "promoteVersion") {
    (async () => {
      const entries = await getEntries();
      if (!entries) { sendResponse({ success: false }); return; }
      const entry = entries.find(e => e.id === msg.entryId);
      if (!entry) return sendResponse({ success: false });
      const idx = entry.versions.findIndex(v => v.timestamp === msg.timestamp);
      if (idx === -1) return sendResponse({ success: false });
      const [version] = entry.versions.splice(idx, 1);
      version.timestamp = Date.now();
      entry.versions.push(version);
      await saveEntries(entries);
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "restoreField") {
    (async () => {
      const entries = await getEntries();
      if (!entries) { sendResponse({ success: false }); return; }
      const match = entries.find(e => e.id === msg.entryId);
      if (!match) { sendResponse({ success: false }); return; }
      const version = match.versions[match.versions.length - 1];
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await browser.tabs.sendMessage(activeTab.id, {
          action: "restoreText",
          data: { fieldName: match.fieldName, text: version.text }
        });
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "restoreAllFields") {
    (async () => {
      const entries = await getEntries();
      if (!entries) { sendResponse({ success: false }); return; }
      const pageUrl = msg.currentTabUrl;
      const relevant = entries.filter(e => e.pageUrl === pageUrl);
      const payload = relevant.map(e => ({
        fieldName: e.fieldName,
        text: e.versions[e.versions.length - 1].text
      }));
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await browser.tabs.sendMessage(activeTab.id, {
          action: "restoreAllTexts",
          data: payload
        });
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "restoreVersion") {
    (async () => {
      const entries = await getEntries();
      if (!entries) { sendResponse({ success: false }); return; }
      const match = entries.find(e => e.id === msg.entryId);
      if (!match) { sendResponse({ success: false }); return; }
      const version = match.versions.find(v => v.timestamp === msg.timestamp);
      if (!version) { sendResponse({ success: false }); return; }
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await browser.tabs.sendMessage(activeTab.id, {
          action: "restoreText",
          data: { fieldName: match.fieldName, text: version.text }
        });
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "getExportData") {
    (async () => {
      const entries = await getEntries();
      sendResponse({ entries: entries || [] });
    })();
    return true;
  }

  if (msg.action === "importData") {
    (async () => {
      const imported = msg.entries;
      imported.forEach(e => { e.id = crypto.randomUUID ? crypto.randomUUID() : uuidFallback(); });
      const current = await getEntries();
      if (current === null) { sendResponse({ success: false }); return; }
      let merged;
      if (msg.replace) {
        merged = imported;
      } else {
        merged = current.concat(imported.filter(imp => !current.some(e => e.pageUrl === imp.pageUrl && e.fieldName === imp.fieldName)));
      }
      await saveEntries(merged);
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "clearBlacklist") {
    (async () => {
      await browser.storage.local.remove("lazarus_blacklist");
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "setEncryptionKey") {
    encryptionKey = msg.key;
    sendResponse({ success: true });
    return true;
  }

  if (msg.action === "clearEncryptionKey") {
    encryptionKey = null;
    sendResponse({ success: true });
    return true;
  }

  return false;
});

browser.contextMenus.removeAll();
browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: "lazarus-resurrect",
    title: "☥ Restore latest text for this page",
    contexts: ["editable"]
  });
  browser.contextMenus.create({
    id: "lazarus-blacklist-toggle",
    title: "☥ Toggle recording for this site",
    contexts: ["page"]
  });
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "lazarus-resurrect" && tab) {
    const entries = await getEntries();
    if (!entries || entries.length === 0) return;
    const match = entries.find(e => e.pageUrl === tab.url) || entries[0];
    if (match) {
      const version = match.versions[match.versions.length - 1];
      browser.tabs.sendMessage(tab.id, {
        action: "restoreText",
        data: { fieldName: match.fieldName, text: version.text }
      });
    }
  }
  if (info.menuItemId === "lazarus-blacklist-toggle" && tab) {
    const hostname = new URL(tab.url).hostname;
    let { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
    let list = lazarus_blacklist || [];
    if (list.includes(hostname)) {
      list = list.filter(h => h !== hostname);
    } else {
      list.push(hostname);
    }
    await browser.storage.local.set({ lazarus_blacklist: list });
    browser.runtime.sendMessage({ action: "blacklist-changed" });
  }
});

browser.commands.onCommand.addListener(async (command) => {
  if (command === "open-command-palette") {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      browser.tabs.sendMessage(activeTab.id, { action: "toggleCommandPalette" });
    }
  }
});

(async function initBackground() {
  await loadSettings();
  await loadBlacklist();
})();