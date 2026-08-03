let config = null;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(cfg) {
  config = cfg;
  if (cfg.title) {
    document.getElementById('brand').textContent = cfg.title;
    document.title = `${cfg.title} — Important Links`;
  }
  if (cfg.tagline) {
    document.getElementById('tagline').textContent = cfg.tagline;
  }

  const list = document.getElementById('list');
  const links = Array.isArray(cfg.links) ? cfg.links : [];
  if (!links.length) {
    list.innerHTML = '<li class="loading">No links in config.json</li>';
    return;
  }

  list.innerHTML = links
    .map((item) => {
      const name = esc(item.name || 'Link');
      const desc = esc(item.desc || '');
      const url = esc(item.url || '#');
      return `<li>
        <a href="${url}" target="_blank" rel="noopener noreferrer">
          <span class="name">${name}</span>
          <span class="go">Open →</span>
          ${desc ? `<p class="desc">${desc}</p>` : ''}
        </a>
      </li>`;
    })
    .join('');
}

function setStatus(msg, isError) {
  const el = document.getElementById('addStatus');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.style.color = isError ? '#ff8e8e' : '';
}

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('fieldName').value.trim();
  const url = document.getElementById('fieldUrl').value.trim();
  const btn = document.getElementById('btnAdd');
  if (!name || !url) return;

  btn.disabled = true;
  setStatus('Saving…');
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Save failed');
    render(json.data.config);
    document.getElementById('addForm').reset();
    setStatus('Link saved. Site redeploys in about a minute.');
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
});

fetch('/config.json')
  .then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  })
  .then(render)
  .catch((err) => {
    document.getElementById('list').innerHTML = '';
    const el = document.getElementById('err');
    el.hidden = false;
    el.textContent = 'Failed to load config.json: ' + (err.message || err);
  });
