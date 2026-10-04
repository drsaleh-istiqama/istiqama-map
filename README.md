# Istiqama Projects Map — v3

Centralised, offline-first system for surveying and following up the mosques and Qur'an
schools of the Istiqama association across East Africa: an installable PWA (Arabic RTL,
Swahili, English) for field collectors who work for days without a connection, on a Supabase
backend (PostgreSQL + PostGIS, Row Level Security on every table) that serves branch
supervisors, country managers and head office.

|                                        |                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Spec (binding, Arabic)                 | [`docs/BRIEF.md`](docs/BRIEF.md)                                                                  |
| Architecture and decisions             | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), contracts in [`docs/contracts/`](docs/contracts/) |
| User guides (with screenshots)         | [العربية](docs/USER_GUIDE_ar.md) · [Kiswahili](docs/USER_GUIDE_sw.md)                             |
| v2 → v3 feature parity                 | [`docs/V2_PARITY.md`](docs/V2_PARITY.md)                                                          |
| CI/CD and performance budget           | [`docs/CI.md`](docs/CI.md)                                                                        |
| Progress / resume point                | [`PROGRESS.md`](PROGRESS.md)                                                                      |
| Decisions only the owner can make      | [`docs/OWNER_DECISIONS.md`](docs/OWNER_DECISIONS.md)                                              |
| Working rules for engineers and agents | [`CLAUDE.md`](CLAUDE.md)                                                                          |

## What is in the box

- **Web app** (`apps/web`): Preact + TypeScript + Vite, MapLibre GL + PMTiles, Dexie
  (IndexedDB), Workbox. Map with server-side clustering and offline map packs; project form
  with GPS accuracy, geo checks, duplicate detection, autosaved drafts and completeness;
  photos compressed on the device and uploaded resumably; people directory without automatic
  merging; review queue and field-level conflict resolution; dashboards, print/PDF reports,
  asynchronous CSV/XLSX export; bulk import with preview and rollback; v2 migration; admin
  console; PIN lock and MFA.
- **Backend** (`supabase/`): versioned migrations (schema, RLS, sync protocol, search, MVT
  tiles, reports, import/export, retention), Edge Functions (`sync_push`, `sync_pull`, `tiles`,
  `export`, `import`, `admin`, `purge-photos`, `otp-hook`) and pgTAP tests.
- **Scripts** (`scripts/`): local Supabase-compatible stack without Docker, geoBoundaries
  import, PMTiles builder, 100k/500k/1M load-data generator, backup/restore drill, local
  Lighthouse-equivalent audit; **k6** load tests in `load-tests/`.

## Run locally

Needs Node 24 and Google Chrome (the e2e suite uses the installed Chrome). No Docker: the
stack is portable PostgreSQL 17 + PostGIS, the real PostgREST and a gateway that emulates
Supabase Auth, Storage and Edge Functions (`docs/ARCHITECTURE.md` §1).

```bash
npm install
npm run stack:setup      # one time: portable binaries, initdb, .env.local with random secrets
npm run stack:start      # PostgreSQL :54322, PostgREST :54323, gateway :54321
npm run db:reset         # migrations + staging seed (demo data, @example.org accounts)
npm run dev              # http://localhost:5173
```

Staging accounts sign in with an e-mail OTP; with `OTP_PROVIDER=fake` the code is printed by
the gateway and available at `GET http://127.0.0.1:54321/dev/otp?identifier=<email>`.

## Tests

```bash
npm run test:db          # pgTAP (34 files, 2 331 assertions)
npm test                 # Vitest (2 197 tests)
npm run e2e              # Playwright against the running stack (17 tests, acceptance criteria 3, 4, 6)
npm run lint && npm run typecheck && npm run format:check
npm run load:seed && npm run load:test   # 100k projects / 500k persons / 1M photos, k6
```

User-guide screenshots (not part of `npm run e2e`):

```bash
cd apps/web && GUIDE_SCREENS=1 npx playwright test screenshots.spec.ts
python docs/screens/optimize.py          # → docs/screens/{ar,sw}/*.png
```

## Status

Units 0–4 (database + RLS, sync engine, UI + map, reports/import/migration/admin) are built and
tested; Unit 5 (load tests at full scale, CI on real Supabase, Lighthouse, backup drill,
acceptance report) is in progress — see [`PROGRESS.md`](PROGRESS.md). Hosting, domain, final
country/branch lists, SMS provider and official option lists are owner decisions
([`docs/OWNER_DECISIONS.md`](docs/OWNER_DECISIONS.md)); placeholders are used until then.
