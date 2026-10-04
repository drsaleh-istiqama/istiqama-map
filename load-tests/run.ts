/**
 * npm run load:test — runs load-tests/mix.js (k6) against a PRIVATE PostgREST + gateway pair
 * for the load database, so the shared development stack (54321/54323, db "istiqama") is
 * never touched.
 *
 *   npm run load:test -- [--db imap_load] [--vus 300] [--ramp 3m] [--steady 10m] [--ramp-down 1m]
 *                        [--think 1] [--pool 20] [--gateway-port 54341] [--postgrest-port 54343]
 *                        [--no-refresh-timer] [--keep-stack] [--label <name>]
 *
 * Writes load-tests/results/:
 *   summary.json      digest: run configuration, machine, dataset, per-endpoint p50/p95/p99,
 *                     error rates, thresholds (acceptance criterion 2), server samples
 *   report.md         the same as a readable report
 *   k6-summary.json   raw k6 end-of-test summary;  k6.log  k6 console output
 * Private stack logs: .local/loadtest/{postgrest,gateway}.log
 *
 * Prerequisite: npm run load:seed (database + load-tests/tokens.json). Expired tokens are
 * re-signed automatically from the loadgen schema of the database.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { buildTokens, defaultMix, type TokensFile } from '../scripts/generate-load-data/tokens.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
dotenv.config({ path: path.join(ROOT, '.env.local'), quiet: true });

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : d;
};
if (flag('help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const DB = opt('db', 'imap_load');
const VUS = Number(opt('vus', '300'));
const RAMP = opt('ramp', '3m');
const STEADY = opt('steady', '10m');
const RAMP_DOWN = opt('ramp-down', '1m');
const THINK = opt('think', '1');
const POOL = Number(opt('pool', '20'));
const GW_PORT = Number(opt('gateway-port', '54341'));
const PGRST_PORT = Number(opt('postgrest-port', '54343'));
const PG_PORT = Number(process.env.PG_PORT ?? 54322);
const LABEL = opt('label', '');
const TOKENS_FILE = path.join(HERE, 'tokens.json');
const RESULTS = path.join(HERE, 'results');
const STATE = path.join(ROOT, '.local', 'loadtest');
const K6 = path.join(ROOT, '.local', 'k6', process.platform === 'win32' ? 'k6.exe' : 'k6');
const POSTGREST = path.join(
  ROOT,
  '.local',
  'postgrest',
  process.platform === 'win32' ? 'postgrest.exe' : 'postgrest',
);
const DB_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/${DB}`;
const BASE = `http://127.0.0.1:${GW_PORT}`;

if (!/^imap_[a-z0-9_]+$/.test(DB)) {
  console.error(`refusing to load-test "${DB}": use the private load database (imap_<label>)`);
  process.exit(2);
}
if ([54321, 54322, 54323].includes(GW_PORT) || [54321, 54322, 54323].includes(PGRST_PORT)) {
  console.error('the shared stack ports 54321–54323 are reserved; choose other ports');
  process.exit(2);
}

const say = (m: string): void =>
  console.log(`[load:test ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

async function portFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return false;
  } catch {
    return true;
  }
}

// ------------------------------------------------------------------------------ private stack

const children: ChildProcess[] = [];

function startStack(): void {
  fs.mkdirSync(STATE, { recursive: true });
  const pgrstLog = fs.openSync(path.join(STATE, 'postgrest.log'), 'w');
  children.push(
    spawn(POSTGREST, [], {
      cwd: ROOT,
      stdio: ['ignore', pgrstLog, pgrstLog],
      env: {
        ...process.env,
        PATH: `${path.join(ROOT, '.local', 'pg', 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
        PGRST_DB_URI: `postgres://authenticator:postgres@127.0.0.1:${PG_PORT}/${DB}`,
        PGRST_DB_SCHEMAS: 'public',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
        PGRST_DB_POOL: String(POOL),
        PGRST_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ?? '',
        PGRST_LOG_LEVEL: 'error',
        PGRST_SERVER_HOST: '127.0.0.1',
        PGRST_SERVER_PORT: String(PGRST_PORT),
      },
    }),
  );
  const gwLog = fs.openSync(path.join(STATE, 'gateway.log'), 'w');
  children.push(
    spawn(
      process.execPath,
      ['--import', 'tsx', path.join(ROOT, 'scripts', 'local-stack', 'gateway', 'server.ts')],
      {
        cwd: ROOT,
        stdio: ['ignore', gwLog, gwLog],
        env: {
          ...process.env,
          GATEWAY_PORT: String(GW_PORT),
          POSTGREST_URL: `http://127.0.0.1:${PGRST_PORT}`,
          DATABASE_URL: DB_URL,
          SUPABASE_URL: BASE,
          STORAGE_DIR: path.join(STATE, 'storage'),
          GATEWAY_LOG_LEVEL: 'warn',
          OTP_PROVIDER: 'fake',
          // pg_cron stand-in: refresh_reports() every 15 min as in production (first run after 1 min)
          ...(flag('no-refresh-timer') ? { REPORTS_REFRESH_MINUTES: '100000' } : {}),
          PURGE_PHOTOS_EVERY_HOURS: '100000',
        },
      },
    ),
  );
}

function stopStack(): void {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* gone */
    }
  }
}

// ------------------------------------------------------------------------------ tokens

async function ensureTokens(c: pg.Client): Promise<TokensFile> {
  let t: TokensFile | null = null;
  if (fs.existsSync(TOKENS_FILE))
    t = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) as TokensFile;
  const fresh =
    t &&
    t.database === DB &&
    t.vus.length >= VUS &&
    new Date(t.expires_at).getTime() > Date.now() + 3 * 3600_000;
  if (fresh) return t!;
  say('tokens.json missing, expired or for another database: re-signing from loadgen');
  return buildTokens(c, {
    database: DB,
    secret: process.env.SUPABASE_JWT_SECRET ?? '',
    mix: defaultMix(Math.max(VUS, 300)),
    ttlHours: 72,
    outFile: TOKENS_FILE,
  });
}

// ------------------------------------------------------------------------------ sampling

interface Sample {
  t: number;
  cpu_pct: number;
  db_active: number;
  db_idle: number;
  db_total: number;
  db_waiting: number;
  xact_per_s: number;
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

function startSampler(c: pg.Client): { stop: () => Promise<Sample[]> } {
  const samples: Sample[] = [];
  let prevCpu = cpuTimes();
  let prevX: number | null = null;
  let prevT = Date.now();
  let running = true;
  const loop = (async () => {
    while (running) {
      await sleep(10_000);
      try {
        const r = await c.query<{
          active: string;
          idle: string;
          total: string;
          waiting: string;
          xact: string;
        }>(
          `select count(*) filter (where state = 'active') active,
                  count(*) filter (where state like 'idle%') idle,
                  count(*) total,
                  count(*) filter (where wait_event_type = 'Lock') waiting,
                  (select xact_commit + xact_rollback from pg_stat_database where datname = $1) xact
             from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
          [DB],
        );
        const now = Date.now();
        const cpu = cpuTimes();
        const dt = cpu.total - prevCpu.total;
        const row = r.rows[0]!;
        const x = Number(row.xact);
        samples.push({
          t: now,
          cpu_pct: dt > 0 ? Math.round((1 - (cpu.idle - prevCpu.idle) / dt) * 1000) / 10 : 0,
          db_active: Number(row.active),
          db_idle: Number(row.idle),
          db_total: Number(row.total),
          db_waiting: Number(row.waiting),
          xact_per_s:
            prevX === null ? 0 : Math.round(((x - prevX) / ((now - prevT) / 1000)) * 10) / 10,
        });
        prevCpu = cpu;
        prevX = x;
        prevT = now;
      } catch {
        /* keep sampling */
      }
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop.catch(() => undefined);
      return samples;
    },
  };
}

// ------------------------------------------------------------------------------ report

interface K6Metric {
  type: string;
  values: Record<string, number>;
  thresholds?: Record<string, { ok: boolean }>;
}
interface K6Summary {
  metrics: Record<string, K6Metric>;
  state?: { testRunDurationMs?: number };
}

const ENDPOINTS = ['sync_pull', 'tile', 'search', 'sync_push', 'my_context', 'register_device'];
const BUDGETS: Record<string, number> = { sync_pull: 800, tile: 300, search: 500 };

interface Stats {
  count: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  error_rate?: number;
}

function endpointStats(k6: K6Summary, sel: string): Stats | null {
  const d = k6.metrics[`http_req_duration{${sel}}`];
  if (!d) return null;
  const f = k6.metrics[`http_req_failed{${sel}}`];
  const v = d.values;
  return {
    count: v.count ?? 0,
    avg: round(v.avg),
    p50: round(v.med),
    p90: round(v['p(90)']),
    p95: round(v['p(95)']),
    p99: round(v['p(99)']),
    max: round(v.max),
    ...(f ? { error_rate: Math.round((f.values.rate ?? 0) * 100000) / 100000 } : {}),
  };
}
const pct = (r: number | undefined): string =>
  r === undefined ? '-' : `${(r * 100).toFixed(1)} %`;
const round = (n: number | undefined): number => (n === undefined ? NaN : Math.round(n * 10) / 10);

async function main(): Promise<void> {
  if (!fs.existsSync(K6)) throw new Error(`k6 not found at ${K6}`);
  if (!fs.existsSync(POSTGREST)) throw new Error(`PostgREST not found at ${POSTGREST}`);
  for (const p of [GW_PORT, PGRST_PORT])
    if (!(await portFree(p))) throw new Error(`port ${p} is in use (a previous run still alive?)`);

  const c = new pg.Client({ connectionString: DB_URL, application_name: 'load-test-monitor' });
  await c.connect();
  const projects = Number((await c.query('select count(*) n from public.projects')).rows[0].n);
  if (projects < 1000)
    throw new Error(`${DB} has ${projects} projects: run npm run load:seed first`);
  const tokens = await ensureTokens(c);
  const dataset = (
    await c.query(
      `select (select count(*) from public.projects) projects,
              (select count(*) from public.persons) persons,
              (select count(*) from public.project_photos) photos,
              (select count(*) from public.project_staff) staff,
              (select count(*) from public.donors) donors,
              (select count(*) from auth.users) users,
              pg_size_pretty(pg_database_size(current_database())) db_size`,
    )
  ).rows[0];
  const pgSettings = Object.fromEntries(
    (
      await c.query<{ name: string; setting: string; unit: string | null }>(
        `select name, setting, unit from pg_settings where name in
          ('server_version','shared_buffers','work_mem','effective_cache_size','max_connections','jit',
           'max_parallel_workers_per_gather','random_page_cost','synchronous_commit')`,
      )
    ).rows.map((r) => [r.name, r.unit ? `${r.setting} ${r.unit}` : r.setting]),
  );
  const rateLimit =
    (await c.query(`select current_setting('app.rate_limit', true) v`)).rows[0].v ?? '';
  say(`database ${DB}: ${JSON.stringify(dataset)}; app.rate_limit=${rateLimit || '(on)'}`);

  fs.mkdirSync(RESULTS, { recursive: true });
  for (const f of ['k6-summary.json', 'summary.json', 'report.md', 'k6.log'])
    fs.rmSync(path.join(RESULTS, f), { force: true });

  say(`starting private stack: PostgREST :${PGRST_PORT} (pool ${POOL}), gateway :${GW_PORT}`);
  startStack();
  const cleanup = (): void => {
    if (!flag('keep-stack')) stopStack();
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  try {
    if (!(await waitFor(`http://127.0.0.1:${PGRST_PORT}/`, 30_000)))
      throw new Error('PostgREST did not start (.local/loadtest/postgrest.log)');
    if (!(await waitFor(`${BASE}/dev/health`, 30_000)))
      throw new Error('gateway did not start (.local/loadtest/gateway.log)');

    // smoke: the first VU can read its context through the private gateway
    const vu = tokens.vus[0]!;
    const smoke = await fetch(`${BASE}/rest/v1/rpc/my_context`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${vu.token}`,
        apikey: process.env.SUPABASE_ANON_KEY ?? '',
        'x-device-id': vu.device,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const ctx = (await smoke.json()) as { roles?: unknown[] };
    if (!smoke.ok || !Array.isArray(ctx.roles) || ctx.roles.length === 0)
      throw new Error(
        `smoke my_context failed: HTTP ${smoke.status} ${JSON.stringify(ctx).slice(0, 300)}`,
      );
    say(`smoke ok (${vu.key}: ${JSON.stringify(ctx.roles)})`);

    const sampler = startSampler(c);
    const started = new Date();
    say(`k6: ${VUS} VUs, ramp ${RAMP}, steady ${STEADY}, ramp-down ${RAMP_DOWN}, think x${THINK}`);
    const k6Log = fs.createWriteStream(path.join(RESULTS, 'k6.log'));
    const exitCode = await new Promise<number>((resolve, reject) => {
      const k6 = spawn(
        K6,
        [
          'run',
          '--quiet',
          '--no-color',
          '--env',
          `BASE_URL=${BASE}`,
          '--env',
          `ANON_KEY=${process.env.SUPABASE_ANON_KEY ?? ''}`,
          '--env',
          `TOKENS=${TOKENS_FILE}`,
          '--env',
          `OUT_DIR=${RESULTS}`,
          '--env',
          `VUS=${VUS}`,
          '--env',
          `RAMP=${RAMP}`,
          '--env',
          `STEADY=${STEADY}`,
          '--env',
          `RAMP_DOWN=${RAMP_DOWN}`,
          '--env',
          `THINK=${THINK}`,
          path.join(HERE, 'mix.js'),
        ],
        { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const tee = (chunk: Buffer, err: boolean): void => {
        k6Log.write(chunk);
        (err ? process.stderr : process.stdout).write(chunk);
      };
      k6.stdout.on('data', (b: Buffer) => tee(b, false));
      k6.stderr.on('data', (b: Buffer) => tee(b, true));
      k6.on('error', reject);
      k6.on('exit', (code) => resolve(code ?? 1));
    });
    k6Log.end();
    const samples = await sampler.stop();
    const finished = new Date();

    const k6File = path.join(RESULTS, 'k6-summary.json');
    if (!fs.existsSync(k6File))
      throw new Error(`k6 wrote no summary (exit ${exitCode}); see results/k6.log`);
    const k6 = JSON.parse(fs.readFileSync(k6File, 'utf8')) as K6Summary;
    const gatewayErrors = fs
      .readFileSync(path.join(STATE, 'gateway.log'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => /"level":"error"/.test(l)).length;
    await writeReport({
      k6,
      tokens,
      dataset,
      pgSettings,
      rateLimit,
      samples,
      started,
      finished,
      exitCode,
      gatewayErrors,
    });
    process.exitCode = exitCode === 0 ? 0 : exitCode;
  } finally {
    await c.end().catch(() => undefined);
    cleanup();
  }
}

async function writeReport(r: {
  k6: K6Summary;
  tokens: TokensFile;
  dataset: Record<string, unknown>;
  pgSettings: Record<string, string>;
  rateLimit: string;
  samples: Sample[];
  started: Date;
  finished: Date;
  exitCode: number;
  gatewayErrors: number;
}): Promise<void> {
  const { k6 } = r;
  const steady: Record<string, Stats | null> = {};
  const all: Record<string, Stats | null> = {};
  for (const e of ENDPOINTS) {
    steady[e] = endpointStats(k6, `endpoint:${e},phase:steady`);
    all[e] = endpointStats(k6, `endpoint:${e}`);
  }
  const breakdown: Record<string, Stats | null> = {
    'sync_pull first-sync pages': endpointStats(k6, 'endpoint:sync_pull,kind:first,phase:steady'),
    'sync_pull incremental': endpointStats(k6, 'endpoint:sync_pull,kind:incr,phase:steady'),
  };
  for (const m of ['field', 'office', 'first_sync']) {
    for (const e of ['tile', 'search', 'sync_pull']) {
      const s = endpointStats(k6, `endpoint:${e},mode:${m},phase:steady`);
      if (s && s.count) breakdown[`${e} (${m} users)`] = s;
    }
  }
  const criteria = Object.entries(BUDGETS).map(([e, budget]) => {
    const s = steady[e];
    return {
      endpoint: e,
      budget_ms_p95: budget,
      p95_ms: s?.p95 ?? null,
      error_rate: s?.error_rate ?? null,
      pass: !!s && s.count > 0 && s.p95 < budget && (s.error_rate ?? 0) < 0.01,
    };
  });
  const failedThresholds = Object.entries(k6.metrics)
    .filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok))
    .map(([k]) => k);
  const counter = (n: string): number => k6.metrics[n]?.values.count ?? 0;
  const iterations = counter('iterations');
  const reqs = counter('http_reqs');
  const durS = (r.finished.getTime() - r.started.getTime()) / 1000;
  const steadySamples = r.samples.slice(
    Math.floor(r.samples.length * 0.25),
    Math.floor(r.samples.length * 0.9),
  );
  const avg = (xs: number[]): number =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0;
  const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);
  const machine = {
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model.trim(),
    cores: os.cpus().length,
    memory_gb: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    note:
      'k6, gateway (Node), PostgREST and PostgreSQL all run on this one shared 8-core machine; the client ' +
      'competes with the server for CPU, so the latencies are pessimistic compared with a separate server.',
  };
  const digest = {
    label: LABEL || undefined,
    started_at: r.started.toISOString(),
    finished_at: r.finished.toISOString(),
    duration_s: Math.round(durS),
    k6_exit_code: r.exitCode,
    config: {
      database: DB,
      vus: VUS,
      ramp: RAMP,
      steady: STEADY,
      ramp_down: RAMP_DOWN,
      think_scale: Number(THINK),
      postgrest_pool: POOL,
      rate_limit: r.rateLimit || 'on (every VU is its own user)',
      refresh_timer: flag('no-refresh-timer')
        ? 'off'
        : 'refresh_reports() every 15 min, first run 1 min after start',
      vu_mix: r.tokens.vus.slice(0, VUS).reduce<Record<string, number>>((m, v) => {
        const k = `${v.role}/${v.mode}`;
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {}),
    },
    machine,
    dataset: r.dataset,
    postgres: r.pgSettings,
    acceptance_criterion_2: { pass: criteria.every((x) => x.pass), criteria },
    steady,
    all_phases: all,
    breakdown,
    totals: {
      http_reqs: reqs,
      req_per_s: Math.round((reqs / durS) * 10) / 10,
      iterations,
      push_ops: counter('push_ops_total'),
      push_ops_rejected: counter('push_ops_rejected'),
      rate_limited: counter('rate_limited'),
      checks_rate: k6.metrics.checks?.values.rate,
      tile_nonempty_rate: k6.metrics.tile_nonempty?.values.rate,
      search_nonempty_rate: k6.metrics.search_nonempty?.values.rate,
      first_sync_rows_per_page_avg: round(k6.metrics['pull_rows_per_page{kind:first}']?.values.avg),
      incremental_rows_per_page_avg: round(k6.metrics['pull_rows_per_page{kind:incr}']?.values.avg),
      first_syncs_completed: k6.metrics.first_sync_seconds?.values.count ?? 0,
      first_sync_seconds_med: round(k6.metrics.first_sync_seconds?.values.med),
      first_sync_rows_med: round(k6.metrics.first_sync_rows?.values.med),
      gateway_error_log_lines: r.gatewayErrors,
    },
    server_samples: {
      cpu_pct_avg_steady: avg(steadySamples.map((s) => s.cpu_pct)),
      cpu_pct_max: max(r.samples.map((s) => s.cpu_pct)),
      db_active_avg_steady: avg(steadySamples.map((s) => s.db_active)),
      db_active_max: max(r.samples.map((s) => s.db_active)),
      db_connections_max: max(r.samples.map((s) => s.db_total)),
      db_lock_waits_max: max(r.samples.map((s) => s.db_waiting)),
      xact_per_s_avg_steady: avg(steadySamples.map((s) => s.xact_per_s)),
      samples: r.samples,
    },
    failed_thresholds: failedThresholds,
  };
  fs.writeFileSync(path.join(RESULTS, 'summary.json'), JSON.stringify(digest, null, 1));

  const row = (name: string, s: Stats | null | undefined, budget?: number): string =>
    s && s.count > 0
      ? `| ${name} | ${s.count} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} | ${((s.error_rate ?? 0) * 100).toFixed(2)} % | ${
          budget
            ? `< ${budget} ms: ${s.p95 < budget && (s.error_rate ?? 0) < 0.01 ? '✅' : '❌'}`
            : ''
        } |`
      : `| ${name} | – | | | | | | |`;
  const head =
    '| Endpoint | Requests | p50 ms | p95 ms | p99 ms | max ms | Errors | Budget (p95) |\n|---|---:|---:|---:|---:|---:|---:|---|';
  const md: string[] = [];
  md.push(`# تقرير اختبار الحمل — المعيار 2 (k6)`);
  md.push('');
  md.push(
    `**النتيجة: ${digest.acceptance_criterion_2.pass ? '✅ ناجح' : '❌ غير ناجح'}** — ` +
      `${VUS} مستخدمًا متزامنًا (كل مستخدم افتراضي حساب مستقل)، صعود ${RAMP}، ثبات ${STEADY}، نزول ${RAMP_DOWN}. ` +
      `من ${r.started.toISOString()} إلى ${r.finished.toISOString()} (${Math.round(durS / 60)} دقيقة).`,
  );
  md.push('');
  md.push('## مرحلة الثبات (كل المستخدمين يعملون) — أساس الحكم');
  md.push('');
  md.push(head);
  for (const e of ENDPOINTS) md.push(row(e, steady[e], BUDGETS[e]));
  md.push('');
  md.push('## تفصيل');
  md.push('');
  md.push(head);
  for (const [k, s] of Object.entries(breakdown)) md.push(row(k, s));
  md.push('');
  md.push('## كل المراحل (بما فيها الصعود والنزول)');
  md.push('');
  md.push(head);
  for (const e of ENDPOINTS) md.push(row(e, all[e]));
  md.push('');
  md.push('## المجاميع');
  md.push('');
  md.push(`- الطلبات: ${reqs} (${digest.totals.req_per_s}/ث في المتوسط)، الدورات: ${iterations}`);
  md.push(
    `- عمليات sync_push: ${digest.totals.push_ops}، المرفوض منها: ${digest.totals.push_ops_rejected}؛ ردود 429: ${digest.totals.rate_limited}`,
  );
  md.push(
    `- نسبة الفحوص الناجحة: ${((digest.totals.checks_rate ?? 0) * 100).toFixed(2)} %؛ أسطر أخطاء البوابة: ${r.gatewayErrors}`,
  );
  md.push(
    `- الخادم (عينات كل 10 ث): المعالج ${digest.server_samples.cpu_pct_avg_steady} % في الثبات (أقصى ${digest.server_samples.cpu_pct_max} %)، ` +
      `اتصالات نشطة ${digest.server_samples.db_active_avg_steady} (أقصى ${digest.server_samples.db_active_max})، ` +
      `انتظار أقفال أقصى ${digest.server_samples.db_lock_waits_max}، معاملات ${digest.server_samples.xact_per_s_avg_steady}/ث`,
  );
  md.push(
    `- معقولية الأجوبة: بلاطات غير فارغة ${pct(digest.totals.tile_nonempty_rate)}، بحث بنتائج ${pct(digest.totals.search_nonempty_rate)}، ` +
      `صفوف لكل صفحة سحب أولى ${digest.totals.first_sync_rows_per_page_avg} وتزايدية ${digest.totals.incremental_rows_per_page_avg}؛ ` +
      `مزامنات أولى مكتملة ${digest.totals.first_syncs_completed} (الوسيط ${digest.totals.first_sync_seconds_med} ث و${digest.totals.first_sync_rows_med} صفًا)`,
  );
  md.push(`- العتبات الفاشلة: ${failedThresholds.length ? failedThresholds.join('، ') : 'لا شيء'}`);
  md.push('');
  md.push('## الإعداد');
  md.push('');
  md.push(`- قاعدة البيانات \`${DB}\`: ${JSON.stringify(r.dataset)}`);
  md.push(`- توزيع المستخدمين: ${JSON.stringify(digest.config.vu_mix)}`);
  md.push(
    `- PostgREST pool = ${POOL}؛ حد المعدل: ${digest.config.rate_limit}؛ ${digest.config.refresh_timer}`,
  );
  md.push(`- PostgreSQL: ${JSON.stringify(r.pgSettings)}`);
  md.push(
    `- الجهاز: ${machine.os}، ${machine.cpu}، ${machine.cores} أنوية، ${machine.memory_gb} GB، Node ${machine.node}`,
  );
  md.push('');
  md.push(
    '> **ملاحظة منهجية:** k6 والبوابة وPostgREST وPostgreSQL كلها على جهاز واحد مشترك بثماني أنوية، فالعميل ' +
      'ينافس الخادم على المعالج؛ الأرقام لذلك متشائمة مقارنة بخادم مستقل. البلاطات تمر بالمسار نفسه الذي يستخدمه التطبيق ' +
      '(دالة Edge `tiles` ← البوابة ← PostgREST ← `tile_projects`) دون ذاكرة تخزين في المتصفح (k6 لا يخزّن)، والدفعات ' +
      'والسحب عبر `/rest/v1/rpc/*` كما يفعل supabase-js.',
  );
  md.push('');
  fs.writeFileSync(path.join(RESULTS, 'report.md'), md.join('\n'));
  say(
    `wrote ${path.relative(ROOT, path.join(RESULTS, 'summary.json'))} and report.md — criterion 2: ${digest.acceptance_criterion_2.pass ? 'PASS' : 'FAIL'}`,
  );
  for (const x of criteria)
    say(`  ${x.endpoint}: p95 ${x.p95_ms} ms (budget ${x.budget_ms_p95}), errors ${x.error_rate}`);
}

main().catch((e: unknown) => {
  console.error(`[load:test] FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  stopStack();
  process.exit(1);
});
