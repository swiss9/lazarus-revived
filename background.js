const browser = globalThis.browser || globalThis.chrome;

const STORAGE_KEY = "lazarus_entries";
const MAX_ENTRIES = 500;
const MAX_AGE_DAYS = 30;
const MAX_VERSIONS = 10;

async function getBlacklist() {
  const { lazarus_blacklist } = await browser.storage.local.get("lazarus_blacklist");
  return lazarus_blacklist || [];
}

async function isBlacklisted(url) {
  try {
    const hostname = new URL(url).hostname;
    const list = await getBlacklist();
    return list.includes(hostname);
  } catch {
    return false;
  }
}

async function cleanExpired(entries) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter(e => e.versions.length && e.versions[e.versions.length - 1].timestamp > cutoff);
}

async function saveEntry(newEntry) {
  if (await isBlacklisted(newEntry.pageUrl)) return;

  let { [STORAGE_KEY]: raw } = await browser.storage.local.get(STORAGE_KEY);
  let entries = raw || [];
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
    newEntry.id = uuid();
    newEntry.versions = [{ text: newEntry.text, timestamp: Date.now() }];
    entries.push(newEntry);
  }

  entries.sort((a, b) => b.versions[b.versions.length - 1].timestamp - a.versions[a.versions.length - 1].timestamp);
  entries = entries.slice(0, MAX_ENTRIES);
  entries = await cleanExpired(entries);
  await browser.storage.local.set({ [STORAGE_KEY]: entries });
}

function uuid() {
  const arr = new Uint32Array(4);
  crypto.getRandomValues(arr);
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = arr[0] & 0x3 | 0x8;
    arr[0] >>= 4;
    return c === 'x' ? r.toString(16) : ((crypto.getRandomValues(new Uint8Array(1))[0] & 0xf) >>> 0).toString(16);
  });
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
      const { [STORAGE_KEY]: entries } = await browser.storage.local.get(STORAGE_KEY);
      let list = entries || [];
      if (msg.currentTabUrl) list = list.filter(e => e.pageUrl === msg.currentTabUrl);
      if (msg.fieldName) list = list.filter(e => e.fieldName === msg.fieldName);
      sendResponse({ entries: list });
    })();
    return true;
  }

  if (msg.action === "deleteEntry") {
    (async () => {
      const { [STORAGE_KEY]: raw } = await browser.storage.local.get(STORAGE_KEY);
      let entries = raw || [];
      entries = entries.filter(e => e.id !== msg.entryId);
      await browser.storage.local.set({ [STORAGE_KEY]: entries });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "restoreField") {
    (async () => {
      const { [STORAGE_KEY]: entries } = await browser.storage.local.get(STORAGE_KEY);
      const match = (entries || []).find(e => e.id === msg.entryId);
      if (!match) return;
      const version = match.versions[match.versions.length - 1];
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await browser.tabs.sendMessage(activeTab.id, {
          action: "restoreText",
          data: { fieldName: match.fieldName, text: version.text }
        });
      }
    })();
    return false;
  }

  if (msg.action === "restoreAllFields") {
    (async () => {
      const { [STORAGE_KEY]: entries } = await browser.storage.local.get(STORAGE_KEY);
      const pageUrl = msg.currentTabUrl;
      const relevant = (entries || []).filter(e => e.pageUrl === pageUrl);
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
      const { [STORAGE_KEY]: entries } = await browser.storage.local.get(STORAGE_KEY);
      const match = (entries || []).find(e => e.id === msg.entryId);
      if (!match) return;
      const version = match.versions.find(v => v.timestamp === msg.timestamp);
      if (!version) return;
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await browser.tabs.sendMessage(activeTab.id, {
          action: "restoreText",
          data: { fieldName: match.fieldName, text: version.text }
        });
      }
    })();
    return false;
  }

  if (msg.action === "getExportData") {
    (async () => {
      const { [STORAGE_KEY]: entries } = await browser.storage.local.get(STORAGE_KEY);
      sendResponse({ entries: entries || [] });
    })();
    return true;
  }

  if (msg.action === "importData") {
    (async () => {
      const imported = msg.entries;
      imported.forEach(e => { e.id = uuid(); });
      const { [STORAGE_KEY]: current } = await browser.storage.local.get(STORAGE_KEY);
      let existing = current || [];
      const merged = existing.concat(imported.filter(imp => !existing.some(e => e.pageUrl === imp.pageUrl && e.fieldName === imp.fieldName)));
      await browser.storage.local.set({ [STORAGE_KEY]: merged });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (msg.action === "clearBlacklist") {
    await browser.storage.local.remove("lazarus_blacklist");
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
    const { [STORAGE_KEY]: entries } = await browser.storage.local.get(STORAGE_KEY);
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
