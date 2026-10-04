# Temporary build stubs

Stand-ins for modules owned by other teams (`docs/contracts/web.md` §3) that did not exist yet
when the shell was written. They mirror the `src/` tree:

| Stub                                   | Stands in for      |
| -------------------------------------- | ------------------ |
| `lib/prefs.ts`                         | `src/lib/prefs.ts` |
| `auth/index.tsx`, `auth/LoginView.tsx` | `src/auth`         |
| `sync/index.ts`                        | `src/sync`         |
| `db/index.ts`                          | `src/db`           |

They are **never** used when the real file exists:

- Vite / Vitest: `stubFallbackPlugin` in `apps/web/vite.config.ts` resolves a relative import
  to the stub only when no real file is found, and only with `ISTIQAMA_STUBS=1` (or under
  Vitest). The build prints which stubs were used.
- TypeScript: `npx tsc -p apps/web/src/ui/__stubs__` type-checks the app with the same
  fallback (`rootDirs`). The normal `npm run typecheck` does not use the stubs.

Delete this folder and the plugin once every module of the contract is in place.
