const browser = globalThis.browser || globalThis.chrome;

(function() {
  if (!window.CSS || !window.CSS.escape) {
    window.CSS = window.CSS || {};
    window.CSS.escape = function(value) {
      if (arguments.length === 0) throw new TypeError('Failed to execute "escape" on "CSS": 1 argument required, but only 0 present.');
      var string = String(value);
      var length = string.length;
      var index = -1;
      var codeUnit;
      var result = '';
      while (++index < length) {
        codeUnit = string.charCodeAt(index);
        if (codeUnit === 0x0000) {
          result += '\uFFFD';
          continue;
        }
        if (
          (codeUnit >= 0x0001 && codeUnit <= 0x001F) ||
          (codeUnit === 0x007F) ||
          (codeUnit >= 0x0080 && codeUnit <= 0x009F) ||
          (codeUnit === 0x000D) ||
          (codeUnit === 0x000C)
        ) {
          result += '\\' + codeUnit.toString(16) + ' ';
          continue;
        }
        if (codeUnit === 0x005C) {
          result += '\\\\';
          continue;
        }
        if (
          (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
          (codeUnit >= 0x0041 && codeUnit <= 0x005A) ||
          (codeUnit >= 0x0061 && codeUnit <= 0x007A) ||
          (codeUnit === 0x002D) ||
          (codeUnit === 0x005F)
        ) {
          result += string.charAt(index);
          continue;
        }
        if (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) {
          result += '\\3' + string.charAt(index) + ' ';
          continue;
        }
        result += '\\' + codeUnit.toString(16) + ' ';
      }
      return result;
    };
  }
})();

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
  if (field.name) return field.name;
  if (field.id) return field.id;
  const cls = typeof field.className === 'string' ? field.className.trim() : '';
  return cls || 'unnamed';
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
  }).catch(err => console.error('Lazarus save error:', err));
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
  const escapedName = CSS.escape(name);
  try {
    const byNameOrId = document.querySelector(`[name="${escapedName}"], #${escapedName}`);
    if (byNameOrId) return byNameOrId;
  } catch (e) {}
  if (name.indexOf(' ') === -1) {
    try {
      const byClass = document.querySelector('.' + CSS.escape(name));
      if (byClass) return byClass;
    } catch (e) {}
  }
  const all = document.querySelectorAll('input, textarea, [contenteditable="true"]');
  for (const el of all) {
    const elId = el.name || el.id || (typeof el.className === 'string' ? el.className : '') || 'unnamed';
    if (elId === name) return el;
  }
  return null;
}

function restoreTextDirect(fieldName, text) {
  const field = findFieldByName(fieldName);
  if (field) {
    if (field.isContentEditable) field.innerText = text;
    else field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.classList.add('lazarus-glow');
    setTimeout(() => field.classList.remove('lazarus-glow'), 600);
  } else {
    console.warn('Lazarus: field not found for', fieldName);
  }
}

browser.runtime.onMessage.addListener(msg => {
  if (msg.action === "restoreText") {
    const { fieldName, text } = msg.data;
    restoreTextDirect(fieldName, text);
  }
  if (msg.action === "restoreAllTexts") {
    msg.data.forEach(item => {
      restoreTextDirect(item.fieldName, item.text);
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

(function mobileFriendlyInFieldUI() {
  const iconHost = document.createElement('div');
  iconHost.id = 'lazarus-icon-host';
  iconHost.style.cssText = 'position:fixed;display:none;z-index:2147483647;pointer-events:auto;';
  iconHost.innerHTML = '<div id="lazarus-icon-btn" style="width:30px;height:30px;background:#1A1A1D;color:#D4AF37;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.5);opacity:0.9;transition:transform 0.1s;">☥</div>';
  document.body.appendChild(iconHost);
  const iconBtn = iconHost.querySelector('#lazarus-icon-btn');

  const dropdownHost = document.createElement('div');
  dropdownHost.id = 'lazarus-dropdown-host';
  dropdownHost.style.cssText = 'position:fixed;display:none;z-index:2147483646;';
  dropdownHost.innerHTML = '<div class="lazarus-list" style="background:#1A1A1D;color:#E0E0E0;border:1px solid #D4AF37;border-radius:8px;min-width:240px;max-width:360px;max-height:220px;overflow-y:auto;font-family:sans-serif;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.5);"></div>';
  document.body.appendChild(dropdownHost);
  const listContainer = dropdownHost.querySelector('.lazarus-list');

  let activeField = null;
  let dropdownVisible = false;
  let iconVisible = false;
  let fieldJustFocused = false;
  let iconTouched = false;

  function positionIcon(field) {
    const rect = field.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      hideIcon();
      return;
    }
    const isTextArea = field.tagName.toLowerCase() === 'textarea' || field.isContentEditable;
    const x = isTextArea ? rect.right - 32 : rect.right - 30;
    const y = isTextArea ? rect.bottom - 32 : rect.top + (rect.height / 2) - 15;
    iconHost.style.left = x + 'px';
    iconHost.style.top = y + 'px';
    iconHost.style.display = 'block';
    iconVisible = true;
  }

  function hideIcon() {
    if (dropdownVisible || iconTouched) return;
    iconHost.style.display = 'none';
    iconVisible = false;
    iconBtn.style.transform = 'scale(1)';
  }

  function hideDropdown() {
    dropdownHost.style.display = 'none';
    dropdownVisible = false;
    iconBtn.style.transform = 'scale(1)';
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

      listContainer.innerHTML = '';

      if (!entries || entries.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'padding:10px 12px;color:#9E9E9E;font-size:12px;text-align:center;';
        emptyMsg.textContent = 'No saved text for this field';
        listContainer.appendChild(emptyMsg);
      } else {
        const entry = entries[0];
        const latestVersion = entry.versions[entry.versions.length - 1];
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;padding:8px 10px;cursor:pointer;border-bottom:1px solid #333;';
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
          restoreTextDirect(entry.fieldName, latestVersion.text);
          hideDropdown();
          hideIcon();
          iconTouched = false;
        });
        listContainer.appendChild(item);
      }

      const rect = field.getBoundingClientRect();
      const dropdownWidth = 360;
      let left = rect.left;
      if (left + dropdownWidth > window.innerWidth) {
        left = window.innerWidth - dropdownWidth - 5;
      }
      if (left < 5) left = 5;
      dropdownHost.style.left = left + 'px';
      dropdownHost.style.top = (rect.bottom + 4) + 'px';
      dropdownHost.style.display = 'block';
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

  function onFieldActivate(field) {
    if (!field.dataset.lazarusTracked || isSensitive(field)) return;
    activeField = field;
    fieldJustFocused = true;
    positionIcon(field);
    setTimeout(() => { fieldJustFocused = false; }, 300);
  }

  document.addEventListener('focusin', e => {
    const target = e.target;
    if (target.matches && target.matches('input, textarea, [contenteditable="true"]')) {
      onFieldActivate(target);
    }
  }, true);

  document.addEventListener('touchstart', e => {
    const target = e.target;
    if (target.matches && target.matches('input, textarea, [contenteditable="true"]')) {
      onFieldActivate(target);
    }
  }, { passive: true });

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!iconTouched && !dropdownVisible && !fieldJustFocused) {
        hideIcon();
      }
    }, 200);
  }, true);

  window.addEventListener('scroll', () => {
    if (activeField && iconVisible) {
      positionIcon(activeField);
      if (dropdownVisible) hideDropdown();
    }
  }, { passive: true, capture: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dropdownVisible) {
      hideDropdown();
      hideIcon();
      iconTouched = false;
    }
  });

  iconBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    iconTouched = true;
    iconBtn.style.transform = 'scale(0.9)';
    if (activeField && activeField.isConnected) {
      showDropdown(activeField);
    }
  });

  document.addEventListener('click', (e) => {
    if (!iconHost.contains(e.target) && !dropdownHost.contains(e.target)) {
      hideDropdown();
      hideIcon();
      iconTouched = false;
    }
  }, true);
})();
