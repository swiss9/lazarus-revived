const browser = globalThis.browser || globalThis.chrome;

const STORAGE_KEY = "lazarus_entries";
const MAX_ENTRIES = 500;
const MAX_AGE_DAYS = 30;

async function cleanExpired(entries) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter(e => e.timestamp > cutoff);
}

async function saveEntry(newEntry) {
  let { [STORAGE_KEY]: raw } = await browser.storage.local.get(STORAGE_KEY);
  let entries = raw || [];
  entries = entries.filter(e => e.pageUrl !== newEntry.pageUrl || e.fieldName !== newEntry.fieldName);
  entries.push(newEntry);
  entries.sort((a, b) => b.timestamp - a.timestamp);
  entries = entries.slice(0, MAX_ENTRIES);
  entries = await cleanExpired(entries);
  await browser.storage.local.set({ [STORAGE_KEY]: entries });
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "saveText") {
    const entry = {
      id: uuid(),
      pageUrl: msg.data.pageUrl,
      fieldName: msg.data.fieldName,
      text: msg.data.text,
      timestamp: Date.now()
    };
    saveEntry(entry).then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.action === "getSavedData") {
    (async () => {
      const { [STORAGE_KEY]: entries } = await browser.storage.local.get(STORAGE_KEY);
      const { currentTabUrl, fieldName } = msg;
      let list = entries || [];
      if (currentTabUrl) {
        list = list.filter(e => e.pageUrl === currentTabUrl);
      }
      if (fieldName) {
        list = list.filter(e => e.fieldName === fieldName);
      }
      sendResponse({ entries: list });
    })();
    return true;
  }

  if (msg.action === "restoreField") {
    (async () => {
      const { [STORAGE_KEY]: entries } = await browser.storage.local.get(STORAGE_KEY);
      const match = (entries || []).find(e => e.id === msg.entryId);
      if (!match) return;

      // Send to the active tab, avoiding strict URL matching issues
      const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await browser.tabs.sendMessage(activeTab.id, {
          action: "restoreText",
          data: { fieldName: match.fieldName, text: match.text }
        });
      }
    })();
    return false;
  }
});
