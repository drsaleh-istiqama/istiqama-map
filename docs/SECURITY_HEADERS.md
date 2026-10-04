# Security headers of the web app (brief §11)

The PWA is a static site (`apps/web/dist`). Whatever serves it must send the headers below.
They are produced in three places, from one source of truth:

| Where                                                         | What                                                                                       | For                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `apps/web/src/ui/pwa/csp.ts`                                  | builds the Content-Security-Policy from the build environment (unit-tested: `csp.test.ts`) | everything below                                            |
| `<meta http-equiv="Content-Security-Policy">` in `index.html` | injected by `cspPlugin` in `apps/web/vite.config.ts`                                       | `vite dev`, `vite preview`, any host without header control |
| `dist/_headers` (from `apps/web/public/_headers`)             | CSP placeholder replaced at build time; plus HSTS, Referrer-Policy, …                      | Netlify, Cloudflare Pages                                   |
| snippets in this file                                         | same headers for nginx and Caddy                                                           | self-hosting                                                |

A `<meta>` policy cannot express `frame-ancestors` and is not a substitute for the real
headers in production — always deploy the headers too.

## The policy

Origins come from the environment **at build time** (`VITE_SUPABASE_URL`, `VITE_TILES_URL`,
`VITE_SENTRY_DSN`); nothing is hard-coded. Example for `VITE_SUPABASE_URL=https://abcd.supabase.co`,
tiles in the same project's storage and a Sentry DSN at `o450.ingest.sentry.io`:

```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' blob: data: https://abcd.supabase.co;
font-src 'self';
connect-src 'self' blob: https://abcd.supabase.co wss://abcd.supabase.co https://o450.ingest.sentry.io;
worker-src 'self';
manifest-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

| Directive                                                                              | Why it is what it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script-src 'self'`                                                                    | No inline scripts, no `eval`, no external scripts. **No `'wasm-unsafe-eval'`:** MapLibre GL 6 shapes Arabic and reorders bidirectional text itself; the WebAssembly RTL-text plugin (`setRTLTextPlugin`) is deprecated and must not be loaded. PMTiles decoding (`pmtiles` 4) is plain JavaScript.                                                                                                                                                                                     |
| `worker-src 'self'`                                                                    | MapLibre GL 6 starts its worker with `new Worker(url, { type: 'module' })` when the worker URL is same-origin and only falls back to a `blob:` worker for cross-origin URLs. The map module must therefore serve the worker from the app origin — e.g. `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'; setWorkerUrl(workerUrl)` so Vite bundles it into `/assets/` — and then **no `blob:`** is needed. The service worker (`/sw.js`) is same-origin too. |
| `style-src 'self'`                                                                     | **No `'unsafe-inline'` in production.** CSS is extracted into hashed files. Preact (`style` props) and MapLibre set element styles through the CSSOM (`element.style…`), which CSP does not restrict; only `<style>` elements and `style="…"` attributes in markup are blocked, and the app has neither (see "Rules for feature code"). The Vite dev server injects `<style>` elements for HMR, so `vite dev` — and only it — adds `'unsafe-inline'`.                                  |
| `img-src … blob: data:`                                                                | `blob:` local photo previews (IndexedDB blobs) and images MapLibre creates; `data:` MapLibre's small built-in images. Remote images only from Supabase Storage (thumbnails, signed full-size URLs) and the tiles origin (sprites).                                                                                                                                                                                                                                                     |
| `connect-src`                                                                          | Supabase REST / Auth / Storage (TUS) / Functions over http(s) and Realtime over ws(s); the tiles origin (PMTiles range requests, glyphs); the Sentry ingest host only when a DSN is configured (the key in the DSN is not part of the policy); `blob:` so the app can `fetch()` its own object URLs.                                                                                                                                                                                   |
| `font-src 'self'`                                                                      | Tajawal is self-hosted (`@fontsource/tajawal`), never Google Fonts.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` | Standard hardening; the app is never framed.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `upgrade-insecure-requests`                                                            | Added automatically when every configured origin is `https` (not for the local stack on `http://127.0.0.1`).                                                                                                                                                                                                                                                                                                                                                                           |

`vite dev` additionally allows `ws://localhost:*` / `ws://127.0.0.1:*` (HMR socket).

### Rules for feature code

- No `<style>` elements, no `style="…"` strings in HTML passed to `dangerouslySetInnerHTML`,
  MapLibre `Popup.setHTML()` or print templates. Use classes, or Preact `style={{ … }}`
  objects (CSSOM).
- No inline `<script>`, no `eval` / `new Function`, no third-party script or font URLs.
- Every remote origin must come from `src/env.ts`. A new origin means a new entry in
  `csp.ts` (and a test), not an exception in one place.
- If a library turns out to need style attributes, relax **only** that:
  add `style-src-attr 'unsafe-inline'` in `csp.ts` — never `'unsafe-inline'` on `style-src`
  or `script-src`.

## Other headers

| Header                       | Value                                                                                                         | Note                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Strict-Transport-Security`  | `max-age=63072000; includeSubDomains`                                                                         | Two years. HTTPS only (brief §11). Adding `preload` is an owner decision: it is hard to undo and binds every sub-domain. |
| `Referrer-Policy`            | `strict-origin-when-cross-origin`                                                                             | Paths (project ids) never leave the origin.                                                                              |
| `X-Content-Type-Options`     | `nosniff`                                                                                                     |                                                                                                                          |
| `X-Frame-Options`            | `DENY`                                                                                                        | For browsers that ignore `frame-ancestors`.                                                                              |
| `Permissions-Policy`         | `geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), bluetooth=()`                          | GPS capture and the photo camera only.                                                                                   |
| `Cross-Origin-Opener-Policy` | `same-origin`                                                                                                 | No pop-up sign-in flows are used (OTP only).                                                                             |
| `Cache-Control`              | `/assets/*`: `public, max-age=31536000, immutable`; `index.html`, `sw.js`, `manifest.webmanifest`: `no-cache` | Hashed files are immutable; entry points must be revalidated or updates are never seen.                                  |

The service worker script must be served with a JavaScript MIME type and **without**
`Service-Worker-Allowed` tricks: its scope is `/`.

## nginx

```nginx
server {
  listen 443 ssl http2;
  server_name map.example.org;
  root /var/www/istiqama-map;          # contents of apps/web/dist
  index index.html;

  # Paste the policy printed in dist/_headers (one line).
  set $csp "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data: https://abcd.supabase.co; font-src 'self'; connect-src 'self' blob: https://abcd.supabase.co wss://abcd.supabase.co; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

  # `always`: also on error pages. Repeat the block in every location that adds headers
  # (nginx does not inherit add_header into a location that has its own).
  add_header Content-Security-Policy $csp always;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Permissions-Policy "geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), bluetooth=()" always;
  add_header Cross-Origin-Opener-Policy "same-origin" always;

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    add_header Content-Security-Policy $csp always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    try_files $uri =404;
  }

  location ~ ^/(index\.html|sw\.js|manifest\.webmanifest)$ {
    add_header Cache-Control "no-cache" always;
    add_header Content-Security-Policy $csp always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Permissions-Policy "geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), bluetooth=()" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
  }

  # Single-page application: unknown paths are application routes.
  location / {
    try_files $uri /index.html;
  }

  types { application/manifest+json webmanifest; }
}

server {                                # HTTP → HTTPS
  listen 80;
  server_name map.example.org;
  return 301 https://$host$request_uri;
}
```

## Caddy

```caddyfile
map.example.org {
	root * /var/www/istiqama-map
	encode zstd gzip

	header {
		# Paste the policy printed in dist/_headers (one line).
		Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data: https://abcd.supabase.co; font-src 'self'; connect-src 'self' blob: https://abcd.supabase.co wss://abcd.supabase.co; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
		Referrer-Policy "strict-origin-when-cross-origin"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Permissions-Policy "geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), bluetooth=()"
		Cross-Origin-Opener-Policy "same-origin"
		-Server
	}

	@immutable path /assets/*
	header @immutable Cache-Control "public, max-age=31536000, immutable"

	@entry path /index.html /sw.js /manifest.webmanifest
	header @entry Cache-Control "no-cache"

	try_files {path} /index.html
	file_server
}
```

(Caddy redirects HTTP to HTTPS and renews certificates by itself.)

## Checking a deployment

```bash
curl -sI https://map.example.org/ | grep -iE 'content-security|strict-transport|referrer|x-content|x-frame|permissions'
curl -sI https://map.example.org/sw.js | grep -i cache-control        # no-cache
curl -sI https://map.example.org/assets/<hashed>.js | grep -i cache-control   # immutable
```

In the browser: DevTools → Console must show no CSP violations after opening the map,
taking a photo, and switching language. Lighthouse "Best practices" flags a missing or weak
CSP and missing HSTS.

## Related protections (not headers)

- The service-role key never reaches the web app: only `VITE_*` variables are exposed, and
  `src/env.ts` reads the anon key only.
- The service worker never caches Supabase REST / RPC / Auth responses, stores successful
  responses only, and the caches that hold per-user content (thumbnails, project tiles) are
  emptied on sign-out (`purgeUserCaches()`).
- Sentry (only when `VITE_SENTRY_DSN` is set) receives scrubbed events: no user, no request
  headers or bodies, no query strings, no e-mail addresses, phone numbers or tokens
  (`src/ui/monitoring.ts`).
