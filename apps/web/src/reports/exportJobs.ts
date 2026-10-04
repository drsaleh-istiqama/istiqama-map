/**
 * Export jobs of the signed-in user (brief §9.3, contract §4) — module state so that a job
 * keeps being followed while the user moves to another page.
 *
 *   requestExport()  export_request → POST the `export` Edge Function { job_id } → follow
 *   follow(job)      polls the job row until it is done / failed / cancelled / expired, then
 *                    tells the user and pulls the `export.ready` notification (syncNow)
 *   downloadExport() short-lived signed URL issued by the export function → browser download
 *
 * The server decides scope and columns (no salary column without restricted access); this
 * file only drives the job.
 */
import { signal } from '@preact/signals';
import { t } from '../i18n';
import { syncNow } from '../sync';
import { toast } from '../ui';
import { isOnline, reportsApi, type ExportRequestInput } from './api';
import { EXPORT_TERMINAL, type ExportJob } from './types';

/** Recent jobs, newest first (what the "past exports" list shows). */
export const exportJobs = signal<ExportJob[]>([]);
/** Ids of the jobs being polled right now. */
export const followedJobs = signal<ReadonlySet<string>>(new Set());

export const JOBS_LIMIT = 20;
/** Poll delays in ms; the last one repeats. */
let pollDelays: readonly number[] = [1500, 2000, 3000, 4000, 5000];
/** Give up polling after this many attempts (~15 minutes); the notification still arrives. */
let maxPolls = 180;

/** Test hook: faster polling. */
export function setPolling(delays: readonly number[], max = 180): void {
  pollDelays = delays.length > 0 ? delays : [0];
  maxPolls = max;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function upsert(job: ExportJob): void {
  const rest = exportJobs.peek().filter((j) => j.id !== job.id);
  exportJobs.value = [job, ...rest]
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .slice(0, JOBS_LIMIT);
}

function setFollowed(id: string, on: boolean): void {
  const next = new Set(followedJobs.peek());
  if (on) next.add(id);
  else next.delete(id);
  followedJobs.value = next;
}

/** Reloads the list from the server (online only). */
export async function refreshJobs(): Promise<void> {
  if (!isOnline()) return;
  const rows = await reportsApi().exportJobs(JOBS_LIMIT);
  // Keep fresher local copies of jobs that are being followed.
  const followed = followedJobs.peek();
  const local = new Map(exportJobs.peek().map((j) => [j.id, j]));
  exportJobs.value = rows.map((row) => (followed.has(row.id) ? (local.get(row.id) ?? row) : row));
  for (const row of rows) if (!EXPORT_TERMINAL.has(row.state)) follow(row);
}

function announce(job: ExportJob): void {
  if (job.state === 'done') {
    toast(t('reports.exportReadyToast'), 'success');
    // The `export.ready` notification was written with the job: fetch it for the bell.
    syncNow().catch(() => undefined);
  } else if (job.state === 'failed') {
    toast(t('reports.exportFailedToast'), 'error');
    syncNow().catch(() => undefined);
  }
}

/** Polls `job` until it reaches a final state. Safe to call twice for the same job. */
export function follow(job: ExportJob): void {
  if (EXPORT_TERMINAL.has(job.state) || timers.has(job.id)) return;
  setFollowed(job.id, true);
  let attempt = 0;
  const tick = async (): Promise<void> => {
    timers.delete(job.id);
    if (!isOnline()) {
      // Offline: try again once the network is back.
      window.addEventListener('online', () => schedule(), { once: true });
      return;
    }
    let fresh: ExportJob | null;
    try {
      fresh = await reportsApi().exportJob(job.id);
    } catch {
      fresh = null; // a flaky link: keep polling
    }
    if (fresh) {
      upsert(fresh);
      if (EXPORT_TERMINAL.has(fresh.state)) {
        setFollowed(job.id, false);
        announce(fresh);
        return;
      }
    }
    schedule();
  };
  const schedule = (): void => {
    if (attempt >= maxPolls) {
      setFollowed(job.id, false);
      return;
    }
    const delay = pollDelays[Math.min(attempt, pollDelays.length - 1)] ?? 5000;
    attempt++;
    timers.set(
      job.id,
      setTimeout(() => void tick(), delay),
    );
  };
  schedule();
}

/** Stops every poll (tests, sign-out). */
export function stopFollowing(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  followedJobs.value = new Set();
}

/**
 * Creates the job and starts the file. When the function call itself fails (connection
 * dropped) the job is still queued and listed: "resume" starts it again.
 */
export async function requestExport(input: ExportRequestInput): Promise<ExportJob> {
  const api = reportsApi();
  const job = await api.exportRequest(input);
  // Marked as followed before it is listed: no "resume" button flashes while starting.
  setFollowed(job.id, true);
  upsert(job);
  try {
    await api.exportStart(job.id);
  } catch {
    // The job exists; polling shows whether a worker picked it up, "resume" retries.
  }
  follow(job);
  return job;
}

/** Starts a queued job again (the function restarts abandoned ones itself). */
export async function resumeExport(job: ExportJob): Promise<void> {
  await reportsApi().exportStart(job.id);
  follow(job);
}

export async function cancelExport(job: ExportJob): Promise<void> {
  await reportsApi().exportCancel(job.id);
  const fresh = await reportsApi()
    .exportJob(job.id)
    .catch(() => null);
  upsert(fresh ?? { ...job, state: 'cancelled' });
}

/** True when the file of a finished job can still be downloaded. */
export function downloadable(
  file: { storage_path: string | null; expires_at: string | null },
  now = Date.now(),
): boolean {
  if (!file.storage_path) return false;
  if (file.expires_at && Date.parse(file.expires_at) <= now) return false;
  return true;
}

/** Triggers the browser download of a finished export (fresh signed URL each time). */
export async function downloadExport(file: {
  /** The export job (the function signs only the caller's own, live, finished job). */
  job_id: string | null;
  storage_path: string | null;
  file_name: string | null;
}): Promise<string> {
  if (!file.job_id || !file.storage_path) throw new Error('no file');
  const url = await reportsApi().exportDownloadUrl(file.job_id);
  saveFile(url, file.file_name);
  return url;
}

function anchorDownload(url: string, fileName: string | null): void {
  // The signed URL carries `download=<name>`: the storage answers with an attachment, so the
  // page stays where it is.
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  if (fileName) anchor.download = fileName;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

let saveFile: (url: string, fileName: string | null) => void = anchorDownload;

/** Test hook: replace the browser download (null restores it). */
export function setFileSaver(saver: ((url: string, fileName: string | null) => void) | null): void {
  saveFile = saver ?? anchorDownload;
}
