# Pending regression tests (failing on purpose)

Proof tests written by the Unit 2 data-loss reviewer (2026-10-04). Each one FAILS today and
demonstrates a real defect; they are excluded from `npm test` (which only runs `src/**`) until
the fix lands. Fixing them is the first task of the next session (see PROGRESS.md).

| File | Defect it proves |
|---|---|
| `zz-u2rev-failed.test.ts` | A rejected older op can resurrect a stale value over the user's newer edit (retry, discard, fix-and-resend paths) |
| `zz-u2rev-photos.test.ts` | A photo waiting for Wi-Fi is lost on sign-out/sign-in or a scope_epoch change; a retry scheduled under a wrong future clock is never retried; end-to-end rejected-older-edit case |
| `zz-u2rev-scale.test.ts` | A backward clock step between two push batches stalls the sync cycle |

Run: `npx vitest run --config apps/web/vite.config.ts --dir apps/web/tests/pending` (or move a file
back under `src/` while fixing). When fixed, move each test next to the code it covers and delete
this folder.
