/**
 * POST /api/config
 * Body:
 *   { kind?: 'link', name, desc?, url }  — append a link (default)
 *   { kind: 'vs-week', year, week, mode, max }
 *   { kind: 'vs-week-delete', year, week }
 */
const REPO = 'mdimmers-webweit/lastwar-dawn-important-links';
const PATH = 'config.json';
const BRANCH = 'main';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json({ ok: false, error: 'POST only' }, 405);
  }

  const token = context.env.GITHUB_TOKEN;
  if (!token) {
    return json({ ok: false, error: 'GITHUB_TOKEN is not set in Variables and Secrets' }, 500);
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const kind = String(body.kind || 'link').trim();
  if (!['link', 'vs-week', 'vs-week-delete'].includes(kind)) {
    return json({ ok: false, error: 'kind must be link, vs-week or vs-week-delete' }, 400);
  }

  try {
    const file = await getFile(token);
    const config = JSON.parse(new TextDecoder().decode(b64ToBytes(file.content)));

    if (kind === 'vs-week' || kind === 'vs-week-delete') {
      const result = applyVsWeek(config, body);
      if (result.error) return json({ ok: false, error: result.error }, result.status || 400);
      await putFile(token, file.sha, config, result.message);
      return json({ ok: true, data: { config } });
    }

    const name = String(body.name || '').trim();
    const desc = String(body.desc || '').trim();
    let url = String(body.url || '').trim();
    if (!name) return json({ ok: false, error: 'Name / description required' }, 400);
    if (!url) return json({ ok: false, error: 'Link required' }, 400);
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    if (!Array.isArray(config.links)) config.links = [];
    if (config.links.some((l) => l.url === url || l.name === name)) {
      return json({ ok: false, error: 'Link or name already exists' }, 409);
    }

    const entry = { name, url };
    if (desc) entry.desc = desc;
    config.links.push(entry);

    await putFile(token, file.sha, config, `Add link: ${name}`);
    return json({ ok: true, data: { config } });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 502);
  }
}

async function getFile(token) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${BRANCH}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'dawn-important-links',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function putFile(token, sha, config, message) {
  const content = bytesToB64(new TextEncoder().encode(JSON.stringify(config, null, 2) + '\n'));
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'dawn-important-links',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, content, sha, branch: BRANCH }),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
  return res.json();
}

function applyVsWeek(config, body) {
  const year = parseInt(body.year, 10);
  const week = parseInt(body.week, 10);
  if (!Number.isFinite(year) || year < 2020 || year > 2100) {
    return { error: 'Year required', status: 400 };
  }
  if (!Number.isFinite(week) || week < 1 || week > 53) {
    return { error: 'ISO week must be 1–53', status: 400 };
  }
  if (!Array.isArray(config.vsWeeks)) config.vsWeeks = [];

  if (body.kind === 'vs-week-delete') {
    const before = config.vsWeeks.length;
    config.vsWeeks = config.vsWeeks.filter(
      (item) => !(Number(item.year) === year && Number(item.week) === week)
    );
    if (config.vsWeeks.length === before) {
      return { error: 'Week not found', status: 404 };
    }
    return { message: `Remove VS week ${year}-W${String(week).padStart(2, '0')}` };
  }

  const mode = String(body.mode || '').trim().toLowerCase();
  if (mode !== 'save' && mode !== 'push') {
    return { error: 'mode must be save or push', status: 400 };
  }
  let maxPoints;
  try {
    maxPoints = parseMaxPoints(body.max);
  } catch (err) {
    return { error: String(err.message || err), status: 400 };
  }
  const entry = { year, week, mode, max: maxPoints };
  const idx = config.vsWeeks.findIndex(
    (item) => Number(item.year) === year && Number(item.week) === week
  );
  if (idx >= 0) config.vsWeeks[idx] = entry;
  else config.vsWeeks.push(entry);
  config.vsWeeks.sort((a, b) => b.year - a.year || b.week - a.week);
  return { message: `Set VS week ${year}-W${String(week).padStart(2, '0')} to ${mode}` };
}

function parseMaxPoints(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s/g, '')
    .replace(/,/g, '');
  if (!s) return 12000000;
  if (s.endsWith('m')) {
    const n = parseFloat(s.slice(0, -1));
    if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid max');
    return Math.round(n * 1e6);
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid max');
  if (n < 1000) return Math.round(n * 1e6);
  return Math.round(n);
}

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
