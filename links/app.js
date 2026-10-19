let config = null;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function berlinDate() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const num = (type) => Number(parts.find((p) => p.type === type).value);
  return new Date(Date.UTC(num('year'), num('month') - 1, num('day')));
}

function isoWeekYear(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

function formatMax(n) {
  const v = Number(n) || 0;
  if (!v) return '—';
  if (v % 1000000 === 0) return v / 1000000 + 'M';
  return String(v);
}

function currentIso() {
  return isoWeekYear(berlinDate());
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
  } else {
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

  renderVsWeeks(cfg);
}

function renderVsWeeks(cfg) {
  const iso = currentIso();
  const nowEl = document.getElementById('weekNow');
  const listEl = document.getElementById('weekList');
  const yearEl = document.getElementById('vsYear');
  const weekEl = document.getElementById('vsWeek');
  if (yearEl && !yearEl.value) yearEl.value = String(iso.year);
  if (weekEl && !weekEl.value) weekEl.value = String(iso.week);
  nowEl.textContent = `Current week: ${iso.year}-W${String(iso.week).padStart(2, '0')}`;

  const weeks = [...(cfg.vsWeeks || [])].sort((a, b) => b.year - a.year || b.week - a.week);
  if (!weeks.length) {
    listEl.innerHTML = '<p class="hint">No weeks stored yet.</p>';
    return;
  }
  listEl.innerHTML = `<table class="week-table">
    <thead><tr><th>Week</th><th>Mode</th><th>Max</th><th></th></tr></thead>
    <tbody>${weeks.map((item) => {
      const current = Number(item.year) === iso.year && Number(item.week) === iso.week;
      return `<tr class="${current ? 'current' : ''}">
        <td>${esc(item.year)}-W${String(item.week).padStart(2, '0')}</td>
        <td>${esc(item.mode)}</td>
        <td>${esc(formatMax(item.max))}</td>
        <td><button type="button" class="ghost" data-vs-delete data-year="${esc(item.year)}" data-week="${esc(item.week)}">Delete</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
  listEl.querySelectorAll('[data-vs-delete]').forEach((btn) => {
    btn.onclick = () => onDeleteVsWeek(btn.getAttribute('data-year'), btn.getAttribute('data-week'));
  });
}

function setStatus(msg, isError) {
  const el = document.getElementById('addStatus');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.style.color = isError ? '#ff8e8e' : '';
}

function setWeekStatus(msg, isError) {
  const el = document.getElementById('weekStatus');
  el.hidden = !msg;
  el.textContent = msg || '';
  el.style.color = isError ? '#ff8e8e' : '';
}

async function postConfig(body) {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Save failed');
  return json;
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
    const json = await postConfig({ name, url });
    render(json.data.config);
    document.getElementById('addForm').reset();
    setStatus('Link saved. Site redeploys in about a minute.');
  } catch (err) {
    setStatus(String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('weekForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const year = document.getElementById('vsYear').value;
  const week = document.getElementById('vsWeek').value;
  const mode = document.getElementById('vsMode').value;
  const max = document.getElementById('vsMax').value;
  const btn = document.getElementById('btnSaveWeek');
  btn.disabled = true;
  setWeekStatus(`Saving ${year}-W${String(week).padStart(2, '0')}…`);
  try {
    const json = await postConfig({ kind: 'vs-week', year, week, mode, max });
    render(json.data.config);
    setWeekStatus(`Saved ${year}-W${String(week).padStart(2, '0')} as ${mode}. Site redeploys in about a minute.`);
  } catch (err) {
    setWeekStatus(String(err.message || err), true);
  } finally {
    btn.disabled = false;
  }
});

async function onDeleteVsWeek(year, week) {
  setWeekStatus(`Removing ${year}-W${String(week).padStart(2, '0')}…`);
  try {
    const json = await postConfig({ kind: 'vs-week-delete', year, week });
    render(json.data.config);
    setWeekStatus(`Removed ${year}-W${String(week).padStart(2, '0')}.`);
  } catch (err) {
    setWeekStatus(String(err.message || err), true);
  }
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
