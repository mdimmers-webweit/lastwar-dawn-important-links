/**
 * POST /api/config
 * Body: { name: string, desc?: string, url: string }
 * Appends a link to config.json via GitHub Contents API.
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

  const name = String(body.name || '').trim();
  const desc = String(body.desc || '').trim();
  let url = String(body.url || '').trim();
  if (!name) return json({ ok: false, error: 'Name / description required' }, 400);
  if (!url) return json({ ok: false, error: 'Link required' }, 400);
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  try {
    const file = await getFile(token);
    const config = JSON.parse(new TextDecoder().decode(b64ToBytes(file.content)));
    if (!Array.isArray(config.links)) config.links = [];

    if (config.links.some((l) => l.url === url || l.name === name)) {
      return json({ ok: false, error: 'Link or name already exists' }, 409);
    }

    const entry = { name, url };
    if (desc) entry.desc = desc;
    // If only one text field was intended as name, keep desc optional
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
