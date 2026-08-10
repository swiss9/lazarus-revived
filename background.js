const browser = globalThis.browser || globalThis.chrome;

const STORAGE_KEY = "lazarus_entries";
const MAX_ENTRIES = 500;
const MAX_VERSIONS = 10;
const MAX_TEXT_LENGTH = 10000;
const MAX_FIELD_NAME_LENGTH = 200;

let cachedBlacklist = [];
let cachedSettings = {
  savePasswords: false,
  retentionHours: 720,
  restoreRequiresPassword: false,
  searchIndexing: true
};
let encryptionKey = null;

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch { return url; }
}

async function loadSettings() {
  try {
    const { lazarus_settings } = await browser.storage.local.get("lazarus_settings");
    cachedSettings = { ...cachedSettings, ...(lazarus_settings || {}) };
  } catch (e) { console.error(e); }
}

async function loadEncryptionKey() {
  try {
    const { lazarus_encryption_key } = await browser.storage.session.get("lazarus_encryption_key");
    if (lazarus_encryption_key) {
      const keyBytes = new Uint8Array(lazarus_encryption_key.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      encryptionKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
    }
  } catch (e) { encryptionKey = null; }
}

async function decryptBlob(encrypted) {
  if (!encryptionKey) return null;
  try {
    const iv = new Uint8Array(encrypted.iv);
    const ciphertext = new Uint8Array(encrypted.data);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encryptionKey, ciphertext);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (e) {
    return null;
  }
}

async function encryptBlob(entries) {
  if (!encryptionKey) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(entries));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, encoded);
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(ciphertext)) };
}

async function cleanupEntries(entries) {
  if (!entries || !entries.length) return entries;
  const retention = cachedSettings.retentionHours;
  if (retention > 0) {
    const cutoff = Date.now() - retention * 60 * 60 * 1000;
    entries = entries.map(e => {
      if (e.pinned) return e;
      const valid = e.versions.filter(v => v.timestamp > cutoff);
      return valid.length ? { ...e, versions: valid } : null;
    }).filter(e => e);
  }
  if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
  return entries;
}

async function applyRetentionAndSave(entries) {
  const cleaned = await cleanupEntries(entries);
  if (encryptionKey) {
    const encrypted = await encryptBlob(cleaned);
    await browser.storage.local.set({ [STORAGE_KEY]: encrypted });
  } else {
    await browser.storage.local.set({ [STORAGE_KEY]: cleaned });
  }
}

async function getDecryptedEntries() {
  const { [STORAGE_KEY]: stored } = await browser.storage.local.get(STORAGE_KEY);
  if (!stored) return [];
  if (stored.iv) {
    if (!encryptionKey) return null;
    const decrypted = await decryptBlob(stored);
    return decrypted || [];
  }
  return stored;
}

(async function init() {
  await loadSettings();
  await loadEncryptionKey();

  const { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
  cachedBlacklist = lazarus_blacklist || [];

  const entries = await getDecryptedEntries();
  if (entries) await applyRetentionAndSave(entries);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.lazarus_blacklist) {
        cachedBlacklist = changes.lazarus_blacklist.newValue || [];
      }
      if (changes.lazarus_settings) {
        cachedSettings = { ...cachedSettings, ...(changes.lazarus_settings.newValue || {}) };
        getDecryptedEntries().then(entries => {
          if (entries) applyRetentionAndSave(entries);
        });
      }
    }
  });

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "saveText") {
      (async () => {
        try {
          const { pageUrl, fieldName, text, timestamp } = msg.data;
          if (typeof pageUrl !== 'string' || typeof fieldName !== 'string' || typeof text !== 'string') return sendResponse({ success: false });
          const cleanedText = text.slice(0, MAX_TEXT_LENGTH);
          const cleanedField = fieldName.slice(0, MAX_FIELD_NAME_LENGTH);
          if (!pageUrl || !cleanedField || !cleanedText) return sendResponse({ success: false });

          let actualUrl = pageUrl;
          if (sender.tab && sender.tab.url) {
            actualUrl = sender.tab.url;
          }
          actualUrl = normalizeUrl(actualUrl);

          const { lazarus_lock } = await browser.storage.local.get("lazarus_lock");
          if (lazarus_lock && !encryptionKey) return sendResponse({ success: false });

          const hostname = (() => { try { return new URL(actualUrl).hostname; } catch { return ''; } })();
          if (cachedBlacklist.includes(hostname)) return sendResponse({ success: false });

          let entries = await getDecryptedEntries();
          if (entries === null) return sendResponse({ success: false });
          if (!entries) entries = [];

          const existingIndex = entries.findIndex(e => e.pageUrl === actualUrl && e.fieldName === cleanedField);
          if (existingIndex !== -1) {
            const existing = entries[existingIndex];
            const lastVersion = existing.versions[existing.versions.length - 1];
            if (cleanedText !== lastVersion.text) {
              existing.versions.push({ text: cleanedText, timestamp: timestamp || Date.now() });
              if (existing.versions.length > MAX_VERSIONS) existing.versions = existing.versions.slice(-MAX_VERSIONS);
            }
          } else {
            const newEntry = {
              id: crypto.randomUUID ? crypto.randomUUID() : uuidFallback(),
              pageUrl: actualUrl,
              fieldName: cleanedField,
              pinned: false,
              versions: [{ text: cleanedText, timestamp: timestamp || Date.now() }]
            };
            entries.push(newEntry);
          }

          entries.sort((a, b) => b.versions[b.versions.length - 1].timestamp - a.versions[a.versions.length - 1].timestamp);
          await applyRetentionAndSave(entries);
          sendResponse({ success: true });
        } catch (e) {
          console.error('[Lazarus] saveText error:', e);
          sendResponse({ success: false });
        }
      })();
      return true;
    }

    if (msg.action === "getSavedData") {
      (async () => {
        try {
          let entries = await getDecryptedEntries();
          if (!entries) entries = [];
          if (msg.currentTabUrl) {
            const norm = normalizeUrl(msg.currentTabUrl);
            entries = entries.filter(e => normalizeUrl(e.pageUrl) === norm);
          }
          if (msg.fieldName) {
            entries = entries.filter(e => e.fieldName === msg.fieldName);
          }
          sendResponse({ entries });
        } catch (e) {
          sendResponse({ entries: [] });
        }
      })();
      return true;
    }

    if (msg.action === "saveBlob") {
      (async () => {
        try {
          await browser.storage.local.set({ [STORAGE_KEY]: msg.blob });
          sendResponse({ success: true });
        } catch (e) { sendResponse({ success: false }); }
      })();
      return true;
    }

    if (msg.action === "setKey") {
      (async () => {
        try {
          const keyBytes = new Uint8Array(msg.key.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
          encryptionKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
          sendResponse({ success: true });
        } catch (e) {
          encryptionKey = null;
          sendResponse({ success: false });
        }
      })();
      return true;
    }

    if (msg.action === "clearKey") {
      encryptionKey = null;
      sendResponse({ success: true });
      return true;
    }

    if (msg.action === "deleteEntry") {
      (async () => {
        try {
          const entries = await getDecryptedEntries();
          if (!entries) return sendResponse({ success: false });
          const filtered = entries.filter(e => e.id !== msg.entryId);
          await applyRetentionAndSave(filtered);
          sendResponse({ success: true });
        } catch (e) { sendResponse({ success: false }); }
      })();
      return true;
    }

    if (msg.action === "atomicSetLock") {
      (async () => {
        try {
          const data = msg.data;
          await browser.storage.local.set({
            lazarus_lock: data.lazarus_lock,
            lazarus_salt_storage: data.lazarus_salt_storage,
            lazarus_pin_hash_storage: data.lazarus_pin_hash_storage,
            lazarus_enc_salt_storage: data.lazarus_enc_salt_storage,
            [STORAGE_KEY]: data.encryptedBlob
          });
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false });
        }
      })();
      return true;
    }

    if (msg.action === "atomicClearLock") {
      (async () => {
        try {
          await browser.storage.local.set({
            lazarus_lock: false,
            lazarus_salt_storage: null,
            lazarus_pin_hash_storage: null,
            lazarus_enc_salt_storage: null,
            [STORAGE_KEY]: msg.data.entries
          });
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ success: false });
        }
      })();
      return true;
    }
  });

  browser.contextMenus.removeAll();
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: "lazarus-resurrect",
      title: "☥ Resurrect Last Text",
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
      const entries = await getDecryptedEntries();
      if (!entries || !entries.length) return;
      const normalizedTabUrl = normalizeUrl(tab.url);
      const match = entries.find(e => e.pageUrl === normalizedTabUrl) || entries[0];
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
      if (list.includes(hostname)) list = list.filter(h => h !== hostname);
      else list.push(hostname);
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
})();

function uuidFallback() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}