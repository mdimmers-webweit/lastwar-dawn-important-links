# DawN — Important Links

Link hub for the DawN alliance.

- **Host:** Cloudflare Pages (Framework **None**)
- **Config:** [`config.json`](config.json)
- **Add link** in the UI writes to `config.json` via GitHub

## Secret

Pages → Settings → **Variables and Secrets**:

| Name | Type |
|------|------|
| `GITHUB_TOKEN` | Secret (Contents read/write on this repo) |

Redeploy after adding the secret.
