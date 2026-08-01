browser.runtime.sendMessage({ action: "getSavedData" }).then(response => {
  const entriesDiv = document.getElementById('entries');
  const items = response.items;
  if (!items || Object.keys(items).length === 0) {
    entriesDiv.innerHTML = '<p>No saved forms yet.</p>';
    return;
  }
  for (const [key, entry] of Object.entries(items)) {
    const div = document.createElement('div');
    div.className = 'entry';
    const hostname = (() => { try { return new URL(entry.pageUrl).hostname; } catch(e) { return entry.pageUrl; } })();
    div.innerHTML = `
      <strong>${entry.fieldName}</strong> on ${hostname}<br>
      <small>${entry.text.slice(0, 50)}...</small>
      <button data-key="${key}">Restore</button>
    `;
    div.querySelector('button').addEventListener('click', () => {
      const [url, field] = key.split('::');
      browser.runtime.sendMessage({
        action: "restoreField",
        pageUrl: url,
        fieldName: field
      });
    });
    entriesDiv.appendChild(div);
  }
});
