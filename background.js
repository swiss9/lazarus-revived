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

async function loadSettings() {
  const { lazarus_settings } = await browser.storage.local.get("lazarus_settings");
  cachedSettings = { ...cachedSettings, ...(lazarus_settings || {}) };
}

async function loadEncryptionKey() {
  const { lazarus_encryption_key } = await browser.storage.session.get("lazarus_encryption_key");
  if (lazarus_encryption_key) {
    try {
      const keyBytes = new Uint8Array(lazarus_encryption_key.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      encryptionKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    } catch (e) {
      encryptionKey = null;
    }
  }
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

(async function init() {
  await loadSettings();
  await loadEncryptionKey();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.lazarus_blacklist) {
        cachedBlacklist = changes.lazarus_blacklist.newValue || [];
      }
      if (changes.lazarus_settings) {
        cachedSettings = { ...cachedSettings, ...(changes.lazarus_settings.newValue || {}) };
      }
    }
  });

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "saveText") {
      (async () => {
        const { pageUrl, fieldName, text, timestamp } = msg.data;
        if (typeof pageUrl !== 'string' || typeof fieldName !== 'string' || typeof text !== 'string') return sendResponse({ success: false });
        const cleanedText = text.slice(0, MAX_TEXT_LENGTH);
        const cleanedField = fieldName.slice(0, MAX_FIELD_NAME_LENGTH);
        if (!pageUrl || !cleanedField || !cleanedText) return sendResponse({ success: false });

        const { lazarus_lock } = await browser.storage.local.get("lazarus_lock");
        if (lazarus_lock && !encryptionKey) return sendResponse({ success: false });

        if (cachedBlacklist.includes((() => { try { return new URL(pageUrl).hostname; } catch { return ''; } })())) return sendResponse({ success: false });

        const { [STORAGE_KEY]: stored } = await browser.storage.local.get(STORAGE_KEY);
        let entries = stored || [];
        if (entries.iv) {
          if (!encryptionKey) return sendResponse({ success: false });
          entries = await decryptBlob(entries);
          if (!entries) return sendResponse({ success: false });
        }

        const existingIndex = entries.findIndex(e => e.pageUrl === pageUrl && e.fieldName === cleanedField);
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
            pageUrl,
            fieldName: cleanedField,
            pinned: false,
            versions: [{ text: cleanedText, timestamp: timestamp || Date.now() }]
          };
          entries.push(newEntry);
        }

        entries.sort((a, b) => b.versions[b.versions.length - 1].timestamp - a.versions[a.versions.length - 1].timestamp);
        entries = entries.slice(0, MAX_ENTRIES);
        if (cachedSettings.retentionHours > 0) {
          const cutoff = Date.now() - cachedSettings.retentionHours * 60 * 60 * 1000;
          entries = entries.map(e => {
            if (e.pinned) return e;
            const valid = e.versions.filter(v => v.timestamp > cutoff);
            return valid.length ? { ...e, versions: valid } : null;
          }).filter(e => e);
        }

        if (encryptionKey) {
          const encrypted = await encryptBlob(entries);
          await browser.storage.local.set({ [STORAGE_KEY]: encrypted });
        } else {
          await browser.storage.local.set({ [STORAGE_KEY]: entries });
        }
        sendResponse({ success: true });
      })();
      return true;
    }

    if (msg.action === "getSavedData") {
      (async () => {
        const { [STORAGE_KEY]: stored } = await browser.storage.local.get(STORAGE_KEY);
        sendResponse({ entries: stored || [] });
      })();
      return true;
    }

    if (msg.action === "saveBlob") {
      (async () => {
        await browser.storage.local.set({ [STORAGE_KEY]: msg.blob });
        sendResponse({ success: true });
      })();
      return true;
    }

    if (msg.action === "setKey") {
      (async () => {
        try {
          const keyBytes = new Uint8Array(msg.key.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
          encryptionKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
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
      const { [STORAGE_KEY]: stored } = await browser.storage.local.get(STORAGE_KEY);
      if (!stored || (stored.iv && !encryptionKey)) return;
      let entries = stored;
      if (stored.iv) {
        entries = await decryptBlob(stored);
        if (!entries) return;
      }
      if (!entries.length) return;
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