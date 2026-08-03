const browser = globalThis.browser || globalThis.chrome;

function isSensitive(field) {
  const type = (field.type || '').toLowerCase();
  if (type === 'password' || type === 'hidden') return true;
  const attrs = (field.getAttribute('autocomplete') || '').toLowerCase();
  if (attrs.includes('cc-') || attrs === 'one-time-code') return true;
  const name = (field.name || field.id || '').toLowerCase();
  const sensitiveNames = ['cvv', 'cardnumber', 'ssn', 'pin', 'ccnum', 'creditcard', 'cvc', 'expiry'];
  return sensitiveNames.some(s => name.includes(s));
}

function getFieldIdentifier(field) {
  return field.name || field.id || field.className || 'unnamed';
}

const saveTimers = new Map();
function saveField(field) {
  if (isSensitive(field)) return;
  if (field.type === 'search' || field.getAttribute('role') === 'searchbox') return;
  if (!field.isConnected) return;
  const text = (field.value || field.innerText || '').trim();
  if (!text || text.length < 4) return;
  browser.runtime.sendMessage({
    action: "saveText",
    data: {
      pageUrl: window.location.href,
      fieldName: getFieldIdentifier(field),
      text,
      timestamp: Date.now()
    }
  }).catch(() => {});
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
    const elName = el.name || el.id || el.className || 'unnamed';
    if (elName === name) return el;
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
      field.classList.add('lazarus-glow');
      setTimeout(() => field.classList.remove('lazarus-glow'), 600);
    }
  }
  if (msg.action === "restoreAllTexts") {
    msg.data.forEach(item => {
      const field = findFieldByName(item.fieldName);
      if (field) {
        if (field.isContentEditable) field.innerText = item.text;
        else field.value = item.text;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        field.classList.add('lazarus-glow');
        setTimeout(() => field.classList.remove('lazarus-glow'), 600);
      }
    });
  }
  if (msg.action === "toggleCommandPalette") {
    toggleCommandPalette();
  }
});

(function injectGlowStyle() {
  const style = document.createElement('style');
  style.textContent = `.lazarus-glow { box-shadow: 0 0 10px 3px #D4AF37 !important; transition: box-shadow 0.3s ease-out; }`;
  document.head.appendChild(style);
})();

(function simpleUI() {
  const iconHost = document.createElement('div');
  iconHost.id = 'lazarus-icon-host';
  iconHost.style.cssText = 'position:fixed;display:none;z-index:2147483647;pointer-events:auto;';
  iconHost.innerHTML = '<div style="width:24px;height:24px;background:#1A1A1D;color:#D4AF37;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.4);opacity:0.8;">☥</div>';
  document.body.appendChild(iconHost);
  const iconDiv = iconHost.querySelector('div');

  const dropdownHost = document.createElement('div');
  dropdownHost.id = 'lazarus-dropdown-host';
  dropdownHost.style.cssText = 'position:fixed;display:none;z-index:2147483646;';
  dropdownHost.innerHTML = '<div class="list" style="background:#1A1A1D;color:#E0E0E0;border:1px solid #D4AF37;border-radius:8px;min-width:240px;max-width:360px;max-height:220px;overflow-y:auto;font-family:sans-serif;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.5);"></div>';
  document.body.appendChild(dropdownHost);
  const listContainer = dropdownHost.querySelector('.list');

  let activeField = null;
  let dropdownVisible = false;
  let isHoveringIcon = false;

  iconHost.addEventListener('mouseenter', () => isHoveringIcon = true);
  iconHost.addEventListener('mouseleave', () => isHoveringIcon = false);

  function positionIcon(field) {
    const rect = field.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return hideIcon();
    const isTextArea = field.tagName.toLowerCase() === 'textarea' || field.isContentEditable;
    iconHost.style.display = 'block';
    if (isTextArea) {
      iconHost.style.left = (rect.right - 28) + 'px';
      iconHost.style.top = (rect.bottom - 28) + 'px';
    } else {
      iconHost.style.left = (rect.right - 26) + 'px';
      iconHost.style.top = (rect.top + (rect.height / 2) - 12) + 'px';
    }
  }

  function hideIcon() {
    if (!dropdownVisible && !isHoveringIcon) {
      iconHost.style.display = 'none';
    }
  }

  function hideDropdown() {
    dropdownHost.style.display = 'none';
    dropdownVisible = false;
  }

  async function deleteEntry(entryId) {
    await browser.runtime.sendMessage({ action: "deleteEntry", entryId });
    hideDropdown();
    hideIcon();
    if (activeField) showDropdown(activeField);
  }

  async function showDropdown(field) {
    dropdownVisible = true;
    try {
      const identifier = getFieldIdentifier(field);
      const { entries } = await browser.runtime.sendMessage({
        action: "getSavedData",
        currentTabUrl: window.location.href,
        fieldName: identifier
      });
      if (!entries || entries.length === 0) {
        hideDropdown();
        return;
      }
      const entry = entries[0];
      const latestVersion = entry.versions[entry.versions.length - 1];
      listContainer.innerHTML = '';
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;padding:6px 8px;cursor:pointer;border-bottom:1px solid #333;';
      const textDiv = document.createElement('div');
      textDiv.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px;';
      textDiv.textContent = latestVersion.text.slice(0, 60) + (latestVersion.text.length > 60 ? '…' : '');
      const timeDiv = document.createElement('div');
      timeDiv.style.cssText = 'font-size:11px;color:#9E9E9E;margin-right:8px;white-space:nowrap;';
      timeDiv.textContent = timeAgo(latestVersion.timestamp);
      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑️';
      delBtn.style.cssText = 'cursor:pointer;opacity:0.6;background:none;border:none;color:#E0E0E0;font-size:14px;padding:0;margin-left:4px;';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteEntry(entry.id);
      });
      item.append(textDiv, timeDiv, delBtn);
      item.addEventListener('click', (e) => {
        if (e.target === delBtn) return;
        browser.runtime.sendMessage({ action: "restoreField", entryId: entry.id });
        hideDropdown();
        hideIcon();
      });
      listContainer.appendChild(item);
      const rect = field.getBoundingClientRect();
      dropdownHost.style.display = 'block';
      dropdownHost.style.left = rect.left + 'px';
      dropdownHost.style.top = (rect.bottom + 4) + 'px';
    } catch (err) {
      hideDropdown();
    }
  }

  function timeAgo(ms) {
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  document.addEventListener('focusin', e => {
    const target = e.target;
    if (target.matches && target.matches('input, textarea, [contenteditable="true"]')) {
      if (!target.dataset.lazarusTracked || isSensitive(target)) return;
      activeField = target;
      positionIcon(target);
    }
  }, true);

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!isHoveringIcon && !dropdownVisible) hideIcon();
    }, 150);
  }, true);

  window.addEventListener('scroll', () => {
    if (activeField && iconHost.style.display === 'block') {
      positionIcon(activeField);
      if (dropdownVisible) hideDropdown();
    }
  }, { passive: true, capture: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dropdownVisible) {
      hideDropdown();
      hideIcon();
    }
  });

  iconDiv.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (activeField) showDropdown(activeField);
    alert('Icon tapped'); // temporary debug
  });

  document.addEventListener('click', (e) => {
    if (!dropdownHost.contains(e.target) && e.target !== iconHost) {
      hideDropdown();
      hideIcon();
    }
  }, true);
})();
