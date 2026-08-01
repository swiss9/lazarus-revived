const storage = browser.storage.local;

function saveText(data) {
  const key = `${data.pageUrl}::${data.fieldName}`;
  const entry = {
    text: data.text,
    timestamp: data.timestamp,
    pageUrl: data.pageUrl,
    fieldName: data.fieldName
  };
  return storage.set({ [key]: entry });
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "saveText") {
    saveText(message.data).then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === "getSavedData") {
    storage.get(null).then(items => {
      sendResponse({ items });
    });
    return true;
  }
  if (message.action === "restoreField") {
    (async () => {
      const key = `${message.pageUrl}::${message.fieldName}`;
      const result = await storage.get(key);
      const entry = result[key];
      if (!entry) return;
      const tabs = await browser.tabs.query({ url: message.pageUrl });
      if (tabs.length > 0) {
        await browser.tabs.sendMessage(tabs[0].id, {
          action: "restoreText",
          data: { fieldName: message.fieldName, text: entry.text }
        });
      }
    })();
    sendResponse({});
    return false;
  }
});
