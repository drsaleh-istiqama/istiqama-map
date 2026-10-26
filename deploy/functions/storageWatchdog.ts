/**
 * Storage watchdog (incident 2026-10-24 → 26: photos, basemap and exports failed for two days).
 *
 * Supabase Storage keeps its S3 keys in the environment of the running deployment. When the
 * Railway Bucket's credentials change, the service variables follow (they are references) but
 * the running container keeps the old keys until it is redeployed: every read and upload then
 * fails with `SignatureDoesNotMatch` (HTTP 500 from Storage) while the API itself stays up.
 *
 * Every STORAGE_WATCHDOG_MINUTES (default 5) this reads the first bytes of a file that always
 * exists (the basemap, `tiles/basemap/east-africa.pmtiles`) through Storage with the service
 * key. After two failed probes in a row it asks Railway to redeploy the Storage service —
 * at most once every 30 minutes — and logs every step (`storage_watchdog_*`).
 *
 * Environment (functions service):
 *   STORAGE_WATCHDOG_MINUTES        probe interval; "off" disables the watchdog
 *   STORAGE_WATCHDOG_PROBE          bucket/path probed (default tiles/basemap/east-africa.pmtiles)
 *   RAILWAY_PROJECT_TOKEN           Railway *project* token (Project → Settings → Tokens),
 *                                   entered by the owner; without it the watchdog only logs
 *   RAILWAY_STORAGE_SERVICE_ID      ${{Supabase Storage.RAILWAY_SERVICE_ID}}
 *   RAILWAY_ENVIRONMENT_ID          provided by Railway
 */

export type ProbeResult = { ok: true } | { ok: false; status: number; detail: string };

export interface WatchdogDeps {
  probe(): Promise<ProbeResult>;
  /** Asks Railway for a fresh deployment of the Storage service; resolves to true on success. */
  redeploy(): Promise<boolean>;
  log(level: string, msg: string, fields?: Record<string, unknown>): void;
  now(): number;
}

export const FAILURES_BEFORE_REDEPLOY = 2;
export const REDEPLOY_COOLDOWN_MS = 30 * 60_000;

/** One watchdog step; the caller runs it on an interval. Pure apart from `deps`. */
export function createWatchdog(deps: WatchdogDeps): { tick(): Promise<void> } {
  let failures = 0;
  let lastRedeployAt = Number.NEGATIVE_INFINITY;
  return {
    async tick() {
      let result: ProbeResult;
      try {
        result = await deps.probe();
      } catch (e) {
        result = { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
      }
      if (result.ok) {
        if (failures > 0) deps.log('info', 'storage_watchdog_recovered', { after: failures });
        failures = 0;
        return;
      }
      failures++;
      deps.log('error', 'storage_watchdog_probe_failed', {
        status: result.status,
        detail: result.detail.slice(0, 300),
        consecutive: failures,
      });
      // A 404 means the probe file is missing, not broken keys: a redeploy would not help.
      if (result.status === 404 || failures < FAILURES_BEFORE_REDEPLOY) return;
      if (deps.now() - lastRedeployAt < REDEPLOY_COOLDOWN_MS) return;
      lastRedeployAt = deps.now();
      const done = await deps.redeploy().catch(() => false);
      deps.log(
        done ? 'warn' : 'error',
        done ? 'storage_watchdog_redeployed' : 'storage_watchdog_redeploy_failed',
      );
      if (done) failures = 0;
    },
  };
}

/** Reads the first 16 bytes of the probe object through Storage with the service key. */
export async function probeStorage(
  supabaseUrl: string,
  serviceKey: string,
  objectPath: string,
): Promise<ProbeResult> {
  const res = await fetch(`${supabaseUrl}/storage/v1/object/${objectPath}`, {
    headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, range: 'bytes=0-15' },
    signal: AbortSignal.timeout(20_000),
  });
  const body = res.ok ? '' : await res.text().catch(() => '');
  await res.body?.cancel().catch(() => undefined);
  return res.ok ? { ok: true } : { ok: false, status: res.status, detail: body };
}

/** Railway public API: redeploy the service instance with its current variables. */
export async function railwayRedeploy(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<boolean> {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Project-Access-Token': token },
    body: JSON.stringify({
      query:
        'mutation($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }',
      variables: { serviceId, environmentId },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { serviceInstanceRedeploy?: boolean };
    errors?: unknown[];
  };
  return res.ok && !json.errors && json.data?.serviceInstanceRedeploy === true;
}
