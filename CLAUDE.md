# CLAUDE.md — Istiqama Projects Map v3

> **بالعربية:** هذا مستودع «خارطة مشاريع الاستقامة» الإصدار 3. المرجع الأعلى هو `docs/BRIEF.md`
> (أمر التنفيذ)، ثم `docs/ARCHITECTURE.md` (العقود التقنية). حالة العمل في `PROGRESS.md` — اقرأه
> أولاً واستأنف من أول بند غير منجز. القرارات المعلّقة على المالك في `docs/OWNER_DECISIONS.md`.

## Read first

1. `docs/BRIEF.md` — the binding spec (Arabic). On any conflict, the brief wins.
2. `docs/ARCHITECTURE.md` — table names, RPC signatures, sync protocol, module layout.
3. `PROGRESS.md` — what is done / in progress / not started. Update it after every item.
4. `docs/V2_PARITY.md` — every v2 feature and its v3 replacement. Nothing may be dropped.
5. `docs/OWNER_DECISIONS.md` — the five decisions only the owner can make. **Never assume
   them**; use the documented placeholders (`example.org`, fake OTP provider, …).

## Binding technical decisions (brief §1)

| Area          | Decision                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend      | PWA, TypeScript, Vite, Preact + signals. Initial JS < 200 kB gzip.                                                                         |
| Map           | MapLibre GL JS + PMTiles (Protomaps) on our own storage. Never `tile.openstreetmap.org`.                                                   |
| Backend       | Supabase: Postgres 15+ with PostGIS, `pg_trgm`, `unaccent`; Auth; Storage; RLS on every table. Must run unchanged on self-hosted Supabase. |
| Local storage | IndexedDB via Dexie. `localStorage` only for UI preferences.                                                                               |
| Offline       | Workbox: hashed precache + per-request-type runtime rules.                                                                                 |
| IDs           | UUIDv7 generated on the device.                                                                                                            |
| Fonts         | Tajawal self-hosted. No Google Fonts.                                                                                                      |
| Tests         | Vitest (units), pgTAP (RLS + functions), Playwright (e2e incl. offline), k6 (load).                                                        |
| CI/CD         | GitHub Actions; `staging` and `production`; versioned migrations in `supabase/migrations`.                                                 |
| Monitoring    | Sentry (web + functions), sync-status dashboard.                                                                                           |
| Version       | Single source: root `package.json` → injected at build time (`__APP_VERSION__`).                                                           |

## Local environment (no Docker on the dev machine)

Portable PostgreSQL 17 + PostGIS in `.local/`, real PostgREST, and a Supabase-compatible
gateway (`scripts/local-stack/gateway`) that emulates Auth (fake OTP), Storage (TUS) and
Edge Functions. Details: `docs/ARCHITECTURE.md` §1.

```bash
npm install            # workspaces: root + apps/web
npm run stack:setup    # one-time: download portable binaries, initdb, write .env.local
npm run stack:start    # PostgreSQL :54322, PostgREST :54323, gateway :54321
npm run db:reset       # apply shim + migrations + staging seed
npm run dev            # web app on http://localhost:5173
```

## Test commands

```bash
npm run test:db        # pgTAP (supabase/tests/*.sql)
npm test               # Vitest
npm run e2e            # Playwright (needs the stack running)
npm run lint && npm run typecheck && npm run format:check
npm run load:seed      # 100k projects / 500k persons / 1M photo rows
npm run load:test      # k6, 300 VUs
```

## Working rules

- Build order: database + RLS + pgTAP → sync engine + local storage → UI + map →
  reports/import/migration → load tests. Do not move to the next unit while tests fail.
- One clear commit per completed unit. Never commit `.local/`, `.env.local`, `node_modules/`.
- Code and comments in English. UI text only through `apps/web/locales/*.json`
  (Arabic is the default language and is RTL; Swahili and English are LTR).
- Migrations must stay valid for real Supabase; local-only shims live in
  `scripts/local-stack/supabase-shim.sql`.
- Field data is written only through `sync_push`; restricted tables
  (`staff_compensation`, `community_sensitive`) are reachable only through logged functions.
- Never seed demo data outside `supabase/seed.staging.sql`.
- `reference/v2/` is the old app, kept read-only for parity checks. Do not import from it.
