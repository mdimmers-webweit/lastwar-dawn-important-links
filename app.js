function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(cfg) {
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
