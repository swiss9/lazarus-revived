const saveTimers = new Map();

function saveFieldState(field) {
  const text = field.value || field.innerText || '';
  const pageUrl = window.location.href;
  const fieldName = field.name || field.id || field.className || 'unnamed';
  browser.runtime.sendMessage({
    action: "saveText",
    data: {
      pageUrl,
      fieldName,
      text,
      timestamp: Date.now()
    }
  });
}

function debouncedSave(field) {
  const key = field.dataset.lazarusKey;
  if (saveTimers.has(key)) {
    clearTimeout(saveTimers.get(key));
  }
  saveTimers.set(key, setTimeout(() => {
    saveFieldState(field);
    saveTimers.delete(key);
  }, 500));
}

function attachListeners(root) {
  const fields = root.querySelectorAll('input[type="text"], input:not([type]), textarea, [contenteditable="true"]');
  fields.forEach(field => {
    if (field.dataset.lazarusTracked) return;
    field.dataset.lazarusTracked = 'true';
    const key = Math.random().toString(36).substr(2, 9);
    field.dataset.lazarusKey = key;
    field.addEventListener('input', () => debouncedSave(field));
  });
}

attachListeners(document);

const observer = new MutationObserver(mutations => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node.nodeType === 1) {
        attachListeners(node);
        if (node.matches && node.matches('input, textarea, [contenteditable="true"]')) {
          const key = Math.random().toString(36).substr(2, 9);
          node.dataset.lazarusKey = key;
          node.addEventListener('input', () => debouncedSave(node));
        }
      }
    });
  });
});
observer.observe(document.body, { childList: true, subtree: true });

browser.runtime.onMessage.addListener((message) => {
  if (message.action === "restoreText") {
    const { fieldName, text } = message.data;
    const field = document.querySelector(`[name="${fieldName}"], #${fieldName}, .${fieldName}`);
    if (field) {
      if (field.isContentEditable) {
        field.innerText = text;
      } else {
        field.value = text;
      }
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
});
