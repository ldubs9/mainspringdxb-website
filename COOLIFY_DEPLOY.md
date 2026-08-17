# Hosting the storefront on Coolify

The backend already runs on Coolify as the `mainspring-payments` app (see
`coolify/README.md` and `EMAIL_SETUP.md`). This file covers the remaining piece:
serving the static storefront (`index.html`, `css/`, `js/`, `components/`,
`images/`, `data/`) from the same server.

## What was added

- `Dockerfile` — nginx 1.27 alpine serving the repo root, with a `/healthz` endpoint.
- `nginx.conf` — gzip, cache headers, security headers, and `try_files ... /index.html`
  so the `?page=` routing works from any path.
- `.dockerignore` — keeps backend code, SQL, docs, and the Instagram raw dump out of the image.

## Steps in Coolify

1. **New Resource → Application → Public/Private Repository**, point it at this repo
   and pick the branch you deploy from (`main`).
2. **Build Pack: Dockerfile.** Base Directory `/`, Dockerfile Location `Dockerfile`.
3. **Port:** `80` (Ports Exposed). No environment variables are needed — the
   frontend is fully static.
4. **Domain:** set `https://mainspringdxb.com` (and/or `www`) in the app's Domains
   field, then point the DNS A record at the Coolify server. Coolify issues the
   Let's Encrypt certificate automatically once DNS resolves.
5. **Health check:** path `/healthz`, port `80`.
6. Deploy. Enable **Auto Deploy** (webhook) if you want pushes to `main` to redeploy.

## Frontend to backend wiring

`js/app.js` calls the payments service at:

```js
const PAYMENTS_BASE = window.PAYMENTS_BASE || 'https://pay.mainspring.swiftloop.tech';
```

If the payments app keeps that domain, nothing to change. If you move it, either
edit that default or set `window.PAYMENTS_BASE = 'https://<new-domain>'` in a
`<script>` in `index.html` before `js/loader.js` loads.

Two things to check on the payments app after the storefront moves:

- `SITE_URL` must equal the storefront's public URL, or Ziina redirects land on the old host.
- CORS on the payments service must allow the storefront origin.

## Instagram feed

`.github/workflows/igfetch-daily.yml` commits `data/instagram.json` and images to
the repo every three days. With Auto Deploy on, each of those commits triggers a
redeploy, which is what keeps the feed fresh. Leave it enabled.

## Local check

```sh
docker build -t mainspring-site .
docker run --rm -p 8080:80 mainspring-site
# http://localhost:8080
```

## Caching notes

HTML and JSON are served `no-cache`; CSS and JS get one hour; images and fonts
get 30 days. `components/*.html` are fetched by `js/loader.js` with a
`COMPONENTS_VERSION` query string — keep bumping it (and the `?v=` on css/js in
`index.html`) when you change those files.
