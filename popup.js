const browser = globalThis.browser || globalThis.chrome;

let showAll = false;
let currentTabUrl = '';

function timeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, match => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[match];
  });
}

async function refreshEntries() {
  const container = document.getElementById('entries');
  container.innerHTML = '';

  const { entries } = await browser.runtime.sendMessage({
    action: "getSavedData",
    currentTabUrl: showAll ? null : currentTabUrl
  });

  if (!entries || entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📜</div>
        <div class="empty-title">No drafts saved ${showAll ? 'yet' : 'for this site'}</div>
        <div class="empty-desc">Type in any form field and Lazarus will automatically capture your text here.</div>
      </div>
    `;
    return;
  }

  entries.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'entry-card';

    let hostname = 'Unknown Site';
    try {
      hostname = new URL(entry.pageUrl).hostname.replace('www.', '') || entry.pageUrl;
    } catch (e) {
      hostname = entry.pageUrl;
    }

    card.innerHTML = `
      <div class="entry-meta">
        <span class="field-tag">${escapeHtml(entry.fieldName)}</span>
        <span class="time-tag">${timeAgo(entry.timestamp)} · ${escapeHtml(hostname)}</span>
      </div>
      <div class="snippet">${escapeHtml(entry.text)}</div>
      <div class="card-actions">
        <button class="btn-icon delete-btn" title="Delete draft">🗑️</button>
        <button class="btn-primary restore-btn">Resurrect</button>
      </div>
    `;

    card.querySelector('.restore-btn').addEventListener('click', () => {
      browser.runtime.sendMessage({ action: "restoreField", entryId: entry.id });
    });

    card.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await browser.runtime.sendMessage({ action: "deleteEntry", entryId: entry.id });
      refreshEntries();
    });

    container.appendChild(card);
  });
}

async function init() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    currentTabUrl = tab ? tab.url : '';
  } catch (e) {
    currentTabUrl = '';
  }

  const tabSite = document.getElementById('tab-site');
  const tabAll = document.getElementById('tab-all');

  tabSite.addEventListener('click', () => {
    showAll = false;
    tabSite.classList.add('active');
    tabAll.classList.remove('active');
    refreshEntries();
  });

  tabAll.addEventListener('click', () => {
    showAll = true;
    tabAll.classList.add('active');
    tabSite.classList.remove('active');
    refreshEntries();
  });

  document.getElementById('toggle-donate').addEventListener('click', (e) => {
    e.preventDefault();
    const modal = document.getElementById('donate-modal');
    const isHidden = modal.style.display === 'none' || !modal.style.display;
    modal.style.display = isHidden ? 'flex' : 'none';
  });

  await refreshEntries();
}

init();
