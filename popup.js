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
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

async function refreshEntries() {
  const { entries } = await browser.runtime.sendMessage({
    action: "getSavedData",
    currentTabUrl: showAll ? null : currentTabUrl
  });
  const container = document.getElementById('entries');
  container.innerHTML = '';
  if (!entries || entries.length === 0) {
    container.textContent = showAll ? 'No souls captured anywhere.' : 'No souls captured on this site.';
    return;
  }
  entries.forEach(entry => {
    const div = document.createElement('div');
    div.className = 'entry';
    
    const strong = document.createElement('strong');
    strong.textContent = entry.fieldName;

    let hostname = 'unknown site';
    try {
      hostname = new URL(entry.pageUrl).hostname || entry.pageUrl;
    } catch (e) {
      hostname = entry.pageUrl;
    }
    
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${timeAgo(entry.timestamp)} · ${hostname}`;
    
    const snippet = document.createElement('div');
    snippet.textContent = entry.text.slice(0, 50) + (entry.text.length > 50 ? '...' : '');
    
    const btn = document.createElement('button');
    btn.textContent = '☥ Resurrect';
    btn.addEventListener('click', () => {
      browser.runtime.sendMessage({ action: "restoreField", entryId: entry.id });
    });
    
    div.append(strong, meta, snippet, btn);
    container.appendChild(div);
  });
}

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab.url;
  
  document.getElementById('toggle-filter').addEventListener('click', (e) => {
    e.preventDefault();
    showAll = !showAll;
    document.getElementById('filter-label').textContent = showAll ? 'all sites' : 'current site';
    document.getElementById('toggle-filter').textContent = showAll ? '(current site only)' : '(all graves)';
    refreshEntries();
  });
  
  document.getElementById('show-donate').addEventListener('click', (e) => {
    e.preventDefault();
    const donateDiv = document.getElementById('donate-content');
    const toggle = document.getElementById('show-donate');
    if (donateDiv.style.display === 'none' || !donateDiv.style.display) {
      donateDiv.style.display = 'block';
      toggle.textContent = '☕ Close';
    } else {
      donateDiv.style.display = 'none';
      toggle.textContent = '☕ Support Lazarus';
    }
  });
  
  await refreshEntries();
}

init();
