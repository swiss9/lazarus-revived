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
  if (field.type === 'search' || field.getAttribute('role') === 'searchbox') return;
  const text = (field.value || field.innerText || '').trim();
  if (!text || text.length < 4) return;
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
      field.classList.add('lazarus-glow');
      setTimeout(() => field.classList.remove('lazarus-glow'), 600);
    }
  }
  if (msg.action === "restoreAllTexts") {
    const payload = msg.data;
    payload.forEach(item => {
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

(function inFieldUI() {
  const iconHost = document.createElement('div');
  iconHost.id = 'lazarus-icon-host';
  const shadow = iconHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { position: fixed; display: none; z-index: 2147483647; pointer-events: auto; }
      .icon { width: 24px; height: 24px; background: #1A1A1D; color: #D4AF37; border-radius: 50%;
              display: flex; align-items: center; justify-content: center; font-size: 16px;
              cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.4); opacity: 0.8; transition: opacity 0.2s; user-select: none; }
      .icon:hover { opacity: 1; transform: scale(1.05); }
    </style>
    <div class="icon">☥</div>
  `;
  document.body.appendChild(iconHost);
  const iconDiv = iconHost.shadowRoot.querySelector('.icon');

  const dropdownHost = document.createElement('div');
  dropdownHost.id = 'lazarus-dropdown-host';
  const dropShadow = dropdownHost.attachShadow({ mode: 'open' });
  dropShadow.innerHTML = `
    <style>
      :host { position: fixed; display: none; z-index: 2147483646; }
      .list { background: #1A1A1D; color: #E0E0E0; border: 1px solid #D4AF37; border-radius: 8px;
              min-width: 240px; max-width: 360px; max-height: 220px; overflow-y: auto;
              font-family: sans-serif; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
      .item { display: flex; align-items: center; padding: 6px 8px; cursor: pointer; border-bottom: 1px solid #333; }
      .item:hover { background: #2A2A2D; color: #D4AF37; }
      .item:last-child { border-bottom: none; }
      .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }
      .time { font-size: 11px; color: #9E9E9E; margin-right: 8px; white-space: nowrap; }
      .delete-btn { cursor: pointer; opacity: 0.6; background: none; border: none; color: #E0E0E0; font-size: 14px; padding: 0; margin-left: 4px; }
      .delete-btn:hover { opacity: 1; color: #D4AF37; }
    </style>
    <div class="list"></div>
  `;
  document.body.appendChild(dropdownHost);
  const listContainer = dropShadow.querySelector('.list');

  let activeField = null;
  let dropdownVisible = false;
  let isHoveringIcon = false;

  iconHost.addEventListener('mouseenter', () => isHoveringIcon = true);
  iconHost.addEventListener('mouseleave', () => isHoveringIcon = false);

  function getFieldIdentifier(field) {
    return field.name || field.id || field.className || 'unnamed';
  }

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
    listContainer.innerHTML = '';
    const entry = entries[0];
    const latestVersion = entry.versions[entry.versions.length - 1];
    const timeText = timeAgo(latestVersion.timestamp);
    const item = document.createElement('div');
    item.className = 'item';
    const textDiv = document.createElement('div');
    textDiv.className = 'text';
    textDiv.textContent = latestVersion.text.slice(0, 60) + (latestVersion.text.length > 60 ? '…' : '');
    const timeDiv = document.createElement('div');
    timeDiv.className = 'time';
    timeDiv.textContent = timeText;
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = '🗑️';
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
    dropdownVisible = true;
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
  });

  document.addEventListener('click', (e) => {
    if (!dropdownHost.contains(e.target) && e.target !== iconHost) {
      hideDropdown();
      hideIcon();
    }
  }, true);
})();

(function commandPalette() {
  const host = document.createElement('div');
  host.id = 'lazarus-cp-host';
  host.style.display = 'none';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483640;
              background: rgba(0,0,0,0.5); display: flex; align-items: flex-start; justify-content: center; padding-top: 15vh; }
      .panel { background: #1A1A1D; border: 1px solid #D4AF37; border-radius: 12px; width: 90%; max-width: 500px;
               overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,0.6); }
      .search-box { width: 100%; padding: 12px 16px; background: transparent; border: none; outline: none;
                    color: #E0E0E0; font-size: 16px; border-bottom: 1px solid #333; }
      .results { max-height: 300px; overflow-y: auto; }
      .cp-item { padding: 10px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;
                 border-bottom: 1px solid #27272a; color: #E0E0E0; font-size: 13px; }
      .cp-item:hover { background: #2A2A2D; color: #D4AF37; }
      .cp-field { font-weight: bold; color: #D4AF37; }
      .cp-snippet { color: #9E9E9E; margin-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    </style>
    <div class="panel">
      <input class="search-box" placeholder="Search drafts...">
      <div class="results"></div>
    </div>
  `;
  document.body.appendChild(host);

  const input = shadow.querySelector('.search-box');
  const results = shadow.querySelector('.results');
  let cpVisible = false;
  let allEntries = [];

  function hide() {
    host.style.display = 'none';
    cpVisible = false;
    input.value = '';
    results.innerHTML = '';
  }

  function show() {
    host.style.display = 'flex';
    cpVisible = true;
    input.focus();
    loadEntries();
  }

  async function loadEntries() {
    const { entries } = await browser.runtime.sendMessage({ action: "getSavedData", currentTabUrl: window.location.href });
    allEntries = entries || [];
    filterResults();
  }

  function filterResults() {
    const query = input.value.toLowerCase().trim();
    results.innerHTML = '';
    const filtered = allEntries.filter(e => {
      if (!query) return true;
      const latest = e.versions[e.versions.length - 1].text.toLowerCase();
      return e.fieldName.toLowerCase().includes(query) || latest.includes(query) || e.pageUrl.toLowerCase().includes(query);
    });
    filtered.forEach(entry => {
      const latest = entry.versions[entry.versions.length - 1];
      const item = document.createElement('div');
      item.className = 'cp-item';
      item.innerHTML = `<span class="cp-field">${escapeHtml(entry.fieldName)}</span><span class="cp-snippet">${escapeHtml(latest.text.slice(0, 50))}</span>`;
      item.addEventListener('click', () => {
        browser.runtime.sendMessage({ action: "restoreField", entryId: entry.id });
        hide();
      });
      results.appendChild(item);
    });
  }

  input.addEventListener('input', filterResults);
  host.addEventListener('click', (e) => {
    if (e.target === host) hide();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cpVisible) hide();
  });

  window.toggleCommandPalette = function() {
    if (cpVisible) hide();
    else show();
  };

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, match => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[match];
    });
  }
})();
