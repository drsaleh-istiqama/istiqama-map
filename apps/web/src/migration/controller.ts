/**
 * The migration flow shared by the first-run prompt, the settings section and the import
 * page: one dialog for the whole app (rendered into its own host, like the confirm dialog),
 * driven by the `flow` signal:
 *
 *   closed → preparing → summary (counts + warnings, nothing written yet)
 *          → running (progress; may be hidden, it keeps running) → report
 *          → (report refreshed whenever the sync status changes until the upload is confirmed)
 *
 * Loaded on demand (it pulls in the runner, the photo pipeline and geofill), never by the shell.
 */
import { createElement, render } from 'preact';
import { flow, flowHidden, type MigrationInput } from './flowState';
import { notifyV2Changed } from './local';
import {
  MigrationError,
  executeMigration,
  finalizeMigration,
  prepareMigration,
  type RunnerDeps,
} from './runner';
import { runtimeDeps } from './runtime';
import { loadRunState } from './state';
import { readV2Local } from './v2read';
import type { V2Data } from './v2types';

export { flow, flowHidden, type FlowState, type MigrationInput } from './flowState';

let deps: RunnerDeps = runtimeDeps;

/** Tests replace the network / session / photo dependencies. */
export function setMigrationDeps(replacement: RunnerDeps | null): void {
  deps = replacement ?? runtimeDeps;
}

export function migrationDeps(): RunnerDeps {
  return deps;
}

let host: HTMLElement | null = null;
let mounting: Promise<void> | null = null;

/** The dialog view, rendered once into its own container. */
function ensureHost(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  if (host?.isConnected) return Promise.resolve();
  mounting ??= import('./MigrationDialog')
    .then(({ MigrationDialog }) => {
      if (host?.isConnected) return;
      // A container removed from the page (tests, a crashed shell) still holds a live tree.
      if (host) render(null, host);
      host = document.createElement('div');
      host.dataset.uiHost = 'migration';
      document.body.appendChild(host);
      render(createElement(MigrationDialog, {}), host);
    })
    .finally(() => {
      mounting = null;
    });
  return mounting;
}

/** A flow failure that is not a runner error (nothing to migrate). */
class MigrationErrorLike extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function codeOf(e: unknown): string {
  if (e instanceof MigrationError) return e.code;
  return 'unknown';
}

/** Opens the dialog and builds the plan of `input` (nothing is written). */
export async function openMigration(input: MigrationInput): Promise<void> {
  await ensureHost();
  flowHidden.value = false;
  const cur = flow.value;
  if (cur.step === 'running' || cur.step === 'preparing') return;
  flow.value = { step: 'preparing', input };
  try {
    let data: V2Data;
    if (input.kind === 'local') {
      const local = readV2Local(deps.readLegacy);
      if (!local.data) throw new MigrationErrorLike('nothing_to_migrate');
      data = local.data;
    } else data = input.data;
    if (!deps.userId()) throw new MigrationError('not_signed_in');
    const prepared = await prepareMigration(data, deps);
    if (flow.value.step === 'preparing') flow.value = { step: 'summary', input, prepared };
  } catch (e) {
    flow.value = {
      step: 'error',
      input,
      code: e instanceof MigrationErrorLike ? e.code : codeOf(e),
    };
  }
}

/** Writes the plan shown in the summary. */
export async function startMigration(): Promise<void> {
  const cur = flow.value;
  if (cur.step !== 'summary') return;
  const { prepared, input } = cur;
  flow.value = {
    step: 'running',
    input,
    prepared,
    progress: { phase: 'saving', done: 0, total: 0 },
  };
  try {
    const report = await executeMigration(prepared, deps, (progress) => {
      const now = flow.value;
      if (now.step === 'running') flow.value = { ...now, progress };
    });
    flow.value = { step: 'report', report };
    flowHidden.value = false;
  } catch (e) {
    flow.value = { step: 'error', input, code: codeOf(e) };
    flowHidden.value = false;
  }
  notifyV2Changed();
}

let refreshing = false;

/**
 * Re-checks the upload of the run in the report (after a sync): when every operation is
 * acknowledged the v2 keys are removed and the report says so.
 */
export async function refreshReport(opts: { sync?: boolean } = {}): Promise<void> {
  const cur = flow.value;
  if (cur.step !== 'report' || refreshing) return;
  if (cur.report.push.done && (cur.report.keysRemoved || cur.report.source !== 'v2_local')) return;
  refreshing = true;
  try {
    const state = await loadRunState(cur.report.source, cur.report.fingerprint);
    if (!state) return;
    const fin = await finalizeMigration(state, deps, opts);
    const now = flow.value;
    if (now.step === 'report' && now.report.fingerprint === cur.report.fingerprint)
      flow.value = {
        step: 'report',
        report: { ...now.report, push: fin.push, keysRemoved: fin.keysRemoved },
      };
    if (fin.push.done) notifyV2Changed();
  } catch {
    /* checked again after the next sync */
  } finally {
    refreshing = false;
  }
}

export function hideMigration(): void {
  flowHidden.value = true;
}

export function showMigration(): void {
  flowHidden.value = false;
}

export function closeMigration(): void {
  if (flow.value.step === 'running') {
    flowHidden.value = true;
    return;
  }
  flow.value = { step: 'closed' };
  flowHidden.value = false;
  notifyV2Changed();
}

/** Back to the summary after an error (same input). */
export function retryMigration(): void {
  const cur = flow.value;
  if (cur.step === 'error') void openMigration(cur.input);
}
