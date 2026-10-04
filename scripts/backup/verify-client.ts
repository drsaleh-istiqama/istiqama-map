/**
 * Restore drill, last step: prove that a client can use the RESTORED database.
 *
 * Starts a throw-away PostgREST + gateway pair on private ports over the restored database
 * (scripts/local-stack/gateway/private-stack.ts), then with the real supabase-js client:
 *
 *   1. a global viewer signs in, registers its device and pulls from scratch: every live
 *      project of the restored database arrives (count compared with SQL);
 *   2. a Kenyan field collector signs in and pulls: only rows of its own scope arrive (no
 *      project of another country — acceptance criterion 5 still holds after a restore);
 *   3. the collector pushes a new row (sync_push) and an incremental pull with the cursor it
 *      already holds returns that row — the change feed works after private.sync_rebase();
 *   4. an operator runs private.sync_rebase() again (as after a second restore): the
 *      collector's old cursor is answered with reset = true and a new scope_epoch, and the
 *      fresh pull returns the full scope again — devices that synced before a restore
 *      discard their local copy instead of missing rows.
 *
 *   node --import tsx scripts/backup/verify-client.ts --db imap_restore
 *
 * Uses the staging accounts of supabase/seed.staging.sql (test-only password). Needs the
 * restored database to contain them, i.e. the source database had the staging seed.
 * Options: --gateway-port (54341) --postgrest-port (54343) --keep (leave the stack running).
 */
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { PrivateStack } from '../local-stack/gateway/private-stack.ts';
import { loadEnv, localUrl, parseArgs, str } from './lib.ts';

loadEnv();
const args = parseArgs(process.argv.slice(2), ['keep']);
const DB = str(args, 'db', 'imap_restore');
if (DB === 'istiqama' || DB === 'postgres')
  throw new Error('verify-client runs against a restored copy only');
const PG_PORT = Number(process.env.PG_PORT ?? 54322);
const GATEWAY_PORT = Number(str(args, 'gateway-port', '54341'));
const POSTGREST_PORT = Number(str(args, 'postgrest-port', '54343'));
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
// Test-only password of the staging seed accounts (supabase/seed.staging.sql).
const SEED_PASSWORD = 'Passw0rd!dev';
const VIEWER = 'viewer@example.org';
const COLLECTOR_KE = 'collector.mombasa@example.org';

interface PullPage {
  changes: Array<{ table: string; rows: Array<Record<string, unknown>>; gone?: string[] }>;
  cursor: unknown;
  done: boolean;
  reset: boolean;
  scope_epoch: string;
}

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failures.push(name);
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`,
  );
}

const BASE = `http://127.0.0.1:${GATEWAY_PORT}`;

async function signIn(email: string, deviceId: string): Promise<SupabaseClient> {
  const client = createClient(BASE, ANON, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-device-id': deviceId } },
  });
  const r = await client.auth.signInWithPassword({ email, password: SEED_PASSWORD });
  check(
    `${email}: sign-in on the restored database`,
    !r.error && !!r.data.session,
    r.error?.message,
  );
  const reg = await client.rpc('register_device', {
    p_device_id: deviceId,
    p_label: 'restore drill',
    p_app_version: 'drill',
  });
  check(
    `${email}: register_device`,
    !reg.error && (reg.data as { revoked?: boolean })?.revoked === false,
    reg.error ?? reg.data,
  );
  return client;
}

/** Page sync_pull until done. Returns rows per table, the last cursor and the flags of page 1. */
async function pullAll(client: SupabaseClient, cursor: unknown = null) {
  const rows: Record<string, Array<Record<string, unknown>>> = {};
  let first: { reset: boolean; scope_epoch: string } | null = null;
  let pages = 0;
  const t0 = Date.now();
  for (;;) {
    const r = await client.rpc('sync_pull', { p_cursor: cursor, p_limit: 500 });
    if (r.error) throw new Error(`sync_pull: ${r.error.message}`);
    const page = r.data as PullPage;
    first ??= { reset: page.reset, scope_epoch: page.scope_epoch };
    pages++;
    for (const c of page.changes) (rows[c.table] ??= []).push(...c.rows);
    cursor = page.cursor;
    if (page.done) break;
    if (pages > 10_000) throw new Error('sync_pull did not finish');
  }
  return { rows, cursor, pages, ms: Date.now() - t0, ...first! };
}

/**
 * Live projects the user may read according to RLS, counted in a read-only transaction under
 * the user's JWT claims. `url` may be the SOURCE database: nothing is written there.
 */
async function rlsProjectCount(url: string, client: SupabaseClient): Promise<number> {
  // The claims of the client's real access token (sub, role, aal, iat, session_id …), so that
  // session_ok() and the role rules see exactly what PostgREST would see.
  const token = (await client.auth.getSession()).data.session?.access_token ?? '';
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as object;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('begin read only');
    await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const r = await c.query<{ n: string }>(
      'select count(*)::bigint as n from public.projects where deleted_at is null',
    );
    return Number(r.rows[0]!.n);
  } finally {
    await c.query('rollback').catch(() => undefined);
    await c.end();
  }
}

/**
 * sync_pull only returns rows below the oldest transaction still open in the CLUSTER
 * (docs/contracts/sync.md §5.1) — on this shared development server other databases run long
 * batch transactions, so a fresh row may need a few seconds to enter the window. Poll.
 */
async function pullUntil(
  client: SupabaseClient,
  cursor: unknown,
  ok: (p: Awaited<ReturnType<typeof pullAll>>) => boolean,
  timeoutMs = Number(process.env.DRILL_PULL_TIMEOUT_MS ?? 300_000),
): Promise<{ page: Awaited<ReturnType<typeof pullAll>>; waitedMs: number; attempts: number }> {
  const t0 = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    const page = await pullAll(client, cursor);
    if (ok(page) || Date.now() - t0 > timeoutMs)
      return { page, waitedMs: Date.now() - t0, attempts };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const summary = (rows: Record<string, unknown[]>): string =>
  Object.entries(rows)
    .map(([t, r]) => `${t} ${r.length}`)
    .join(', ');

async function main(): Promise<void> {
  if (!ANON) throw new Error('SUPABASE_ANON_KEY missing (.env.local)');
  const db = new pg.Client({ connectionString: localUrl(DB) });
  await db.connect();
  const stack = new PrivateStack({
    dbName: DB,
    pgPort: PG_PORT,
    gatewayPort: GATEWAY_PORT,
    postgrestPort: POSTGREST_PORT,
  });
  const t0 = Date.now();
  await stack.start();
  console.log(`private stack on ${BASE} over database "${DB}" (started in ${Date.now() - t0} ms)`);
  const run = crypto.randomBytes(3).toString('hex');

  try {
    console.log('1. global viewer');
    const viewer = await signIn(VIEWER, `drill-viewer-${run}`);
    const rlsRestored = await rlsProjectCount(localUrl(DB), viewer);
    const rlsSource = await rlsProjectCount(localUrl(str(args, 'source-db', 'istiqama')), viewer);
    // Right after sync_rebase the restamped rows enter the pull window only once every older
    // transaction of the cluster has ended (§5.1): retry the first round until they do.
    const {
      page: v,
      waitedMs: w1,
      attempts: a1,
    } = await pullUntil(viewer, null, (p) => (p.rows.projects?.length ?? 0) >= rlsRestored);
    console.log(
      `     ${v.pages} pages in ${v.ms} ms (first round ready after ${w1} ms, ${a1} attempt(s)): ${summary(v.rows)}`,
    );
    console.log(
      `     projects readable by the viewer (RLS): source ${rlsSource}, restored ${rlsRestored}`,
    );
    check(
      'viewer: readable projects identical in source and restored database',
      rlsSource === rlsRestored,
      { rlsSource, rlsRestored },
    );
    check(
      'viewer pull returns every project the viewer may read',
      (v.rows.projects?.length ?? 0) === rlsRestored,
      { pulled: v.rows.projects?.length, rls: rlsRestored },
    );
    check(
      'viewer pull contains no people tables (viewer has no people scope)',
      !v.rows.persons && !v.rows.project_staff,
    );
    check(
      'viewer pull contains no restricted table',
      !v.rows.staff_compensation && !v.rows.community_sensitive,
    );

    console.log('2. field collector, Kenya (branch MOMBASA)');
    const collector = await signIn(COLLECTOR_KE, `drill-collector-${run}`);
    const ctx = await collector.rpc('my_context');
    const rlsCollector = await rlsProjectCount(localUrl(DB), collector);
    const {
      page: c,
      waitedMs: w2,
      attempts: a2,
    } = await pullUntil(collector, null, (p) => (p.rows.projects?.length ?? 0) >= rlsCollector);
    console.log(
      `     ${c.pages} pages in ${c.ms} ms (first round ready after ${w2} ms, ${a2} attempt(s)): ${summary(c.rows)}`,
    );
    const others = await db.query<{ id: string }>(
      `select id::text as id from public.countries where iso2 <> 'KE'`,
    );
    const otherCountries = new Set(others.rows.map((r) => r.id));
    const pulledProjects = c.rows.projects ?? [];
    check(
      'collector pull returns every project the collector may read (RLS)',
      pulledProjects.length === rlsCollector && rlsCollector > 0,
      { pulled: pulledProjects.length, rls: rlsCollector },
    );
    check(
      'collector receives no project of another country',
      pulledProjects.every((p) => !otherCountries.has(String(p.country_id))),
      pulledProjects.filter((p) => otherCountries.has(String(p.country_id))).length,
    );
    check('collector receives no salary row', !c.rows.staff_compensation);
    check(
      'collector scope_epoch matches my_context()',
      !ctx.error && (ctx.data as { scope_epoch?: string })?.scope_epoch === c.scope_epoch,
      ctx.error,
    );

    console.log('3. push + incremental pull after sync_rebase');
    const donorId = crypto.randomUUID();
    const push = await collector.rpc('sync_push', {
      p_device_id: `drill-collector-${run}`,
      p_ops: [
        {
          op_id: crypto.randomUUID(),
          table: 'donors',
          id: donorId,
          kind: 'upsert',
          base_version: 0,
          fields: {
            name_ar: `متبرع اختبار الاسترجاع ${run}`,
            created_at: new Date().toISOString(),
          },
          client_ts: new Date().toISOString(),
        },
      ],
    });
    const status = (push.data as { results?: Array<{ status: string }> })?.results?.[0]?.status;
    check(
      'sync_push on the restored database: applied',
      !push.error && status === 'applied',
      push.error ?? push.data,
    );
    const hasDonor = (p: Awaited<ReturnType<typeof pullAll>>): boolean =>
      (p.rows.donors ?? []).some((d) => d.id === donorId);
    const {
      page: inc,
      waitedMs: w3,
      attempts: a3,
    } = await pullUntil(collector, c.cursor, hasDonor);
    console.log(`     incremental pull: ${summary(inc.rows)} (after ${w3} ms, ${a3} attempt(s))`);
    check('incremental pull returns the new row', !inc.reset && hasDonor(inc), summary(inc.rows));

    console.log('4. second sync_rebase: old cursors are reset');
    const rebase = await db.query<{ r: unknown }>('select private.sync_rebase() as r');
    console.log(`     sync_rebase → ${JSON.stringify(rebase.rows[0]!.r)}`);
    const {
      page: again,
      waitedMs: w4,
      attempts: a4,
    } = await pullUntil(
      collector,
      inc.cursor,
      (p) => p.reset && (p.rows.projects?.length ?? 0) === pulledProjects.length && hasDonor(p),
    );
    console.log(
      `     pull with the old cursor: reset=${again.reset}, ${summary(again.rows)} (after ${w4} ms, ${a4} attempt(s))`,
    );
    check('pull with a pre-rebase cursor answers reset = true', again.reset === true, {
      reset: again.reset,
    });
    check('scope_epoch changed', again.scope_epoch !== c.scope_epoch);
    check(
      'the fresh pull returns the full scope again',
      (again.rows.projects?.length ?? 0) === pulledProjects.length &&
        (again.rows.donors ?? []).some((d) => d.id === donorId),
      summary(again.rows),
    );
  } finally {
    await db.end();
    if (!args.keep) stack.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
