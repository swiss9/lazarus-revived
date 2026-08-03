const browser = globalThis.browser || globalThis.chrome;

const STORAGE_KEY = "lazarus_entries";
const MAX_ENTRIES = 500;
const MAX_AGE_DAYS = 30;
const MAX_VERSIONS = 10;

console.log('[Lazarus] Service worker started');

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
  console.log('[Lazarus] saveEntry called with:', newEntry);
  if (await isBlacklisted(newEntry.pageUrl)) {
    console.log('[Lazarus] Site blacklisted, not saving');
    return;
  }

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
    newEntry.id = crypto.randomUUID ? crypto.randomUUID() : 'fallback-uuid-' + Date.now();
    newEntry.versions = [{ text: newEntry.text, timestamp: Date.now() }];
    entries.push(newEntry);
  }

  entries.sort((a, b) => b.versions[b.versions.length - 1].timestamp - a.versions[a.versions.length - 1].timestamp);
  entries = entries.slice(0, MAX_ENTRIES);
  entries = await cleanExpired(entries);
  await browser.storage.local.set({ [STORAGE_KEY]: entries });
  console.log('[Lazarus] Entry saved. Total entries:', entries.length);
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[Lazarus] Message received:', msg.action);
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
      console.log('[Lazarus] Returning entries:', list.length);
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
      imported.forEach(e => { e.id = crypto.randomUUID ? crypto.randomUUID() : 'imp-' + Date.now(); });
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
