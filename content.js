const browser = globalThis.browser || globalThis.chrome;

function isSensitive(field) {
  const type = (field.type || '').toLowerCase();
  if (type === 'password' || type === 'hidden') return true;

  const attrs = (field.getAttribute('autocomplete') || '').toLowerCase();
  if (attrs.includes('cc-') || attrs === 'one-time-code') return true;

  const name = (field.name || field.id || '').toLowerCase();
  return name.includes('cvv') || name.includes('cardnumber') || name.includes('ssn') || name.includes('pin');
}

const saveTimers = new Map();

function saveField(field) {
  if (isSensitive(field)) return;
  const text = (field.value || field.innerText || '').trim();
  if (!text) return;

  browser.runtime.sendMessage({
    action: "saveText",
    data: {
      pageUrl: window.location.href,
      fieldName: field.name || field.id || field.className || 'unnamed',
      text,
      timestamp: Date.now()
    }
  });
}

function debouncedSave(field) {
  const key = field.dataset.lazarusKey;
  if (saveTimers.has(key)) clearTimeout(saveTimers.get(key));
  saveTimers.set(key, setTimeout(() => {
    saveField(field);
    saveTimers.delete(key);
  }, 500));
}

function attach(root) {
  const fields = root.querySelectorAll(
    'input:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]'
  );
  fields.forEach(field => {
    if (field.dataset.lazarusTracked || isSensitive(field)) return;
    field.dataset.lazarusTracked = 'true';
    const key = Math.random().toString(36).substr(2, 9);
    field.dataset.lazarusKey = key;
    field.addEventListener('input', () => debouncedSave(field));
  });
}

attach(document);

const observer = new MutationObserver(mutations => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.matches && node.matches('input, textarea, [contenteditable="true"]')) {
        if (!node.dataset.lazarusTracked && !isSensitive(node)) {
          node.dataset.lazarusTracked = 'true';
          const key = Math.random().toString(36).substr(2, 9);
          node.dataset.lazarusKey = key;
          node.addEventListener('input', () => debouncedSave(node));
        }
      }
      attach(node);
    });
  });
});
observer.observe(document.body, { childList: true, subtree: true });

function findFieldByName(name) {
  if (!name || name === 'unnamed') return null;
  try {
    const escaped = CSS.escape(name);
    const match = document.querySelector(`[name="${escaped}"], #${escaped}, .${escaped}`);
    if (match) return match;
  } catch (e) {}
  const all = document.querySelectorAll('input, textarea, [contenteditable="true"]');
  for (const el of all) {
    if (el.name === name || el.id === name || el.className.includes(name)) {
      return el;
    }
  }
  return null;
}

browser.runtime.onMessage.addListener(msg => {
  if (msg.action === "restoreText") {
    const { fieldName, text } = msg.data;
    const field = findFieldByName(fieldName);
    if (field) {
      if (field.isContentEditable) field.innerText = text;
      else field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
});
