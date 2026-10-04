/**
 * Live smoke test of the Edge Functions against a running stack (local gateway or a Supabase
 * project with the staging seed).
 *
 *   node --import tsx supabase/functions/smoke.ts            (reads .env.local of the repository)
 *
 * What it touches (all of it idempotent and limited to smoke accounts / unfinished batches):
 *   - signs in as the seeded staging users (password grant);
 *   - creates export jobs and files for them, and import batches that are never committed;
 *   - with the service key: one dedicated account `smoke.hq@example.org` that holds `hq_admin`
 *     only while the script runs (TOTP enrolled for the run, grant removed at the end), and one
 *     throw-away account `smoke.target@example.org` used to exercise the admin function.
 *     The seeded `hq.admin@example.org` is deliberately left alone: enrolling a factor on it
 *     would end the aal1 sessions other people are using.
 */
import fs from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { parseCsv } from './_shared/csv.ts';
import { readZipDirectory, readZipEntry } from './_shared/zip.ts';

// ------------------------------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------------------------------

function loadEnvFile(): void {
  const file = new URL('../../.env.local', import.meta.url);
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnvFile();

const BASE = (process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const FN = `${BASE}/functions/v1`;
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'Passw0rd!dev';
const DEVICE = 'smoke-functions';
const ORIGIN = 'http://localhost:5173';
const RUN = Date.now().toString(36);
const MVT = 'application/vnd.mapbox-vector-tile';

if (!ANON || !SERVICE) {
  console.error('SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are not set (see .env.local).');
  process.exit(2);
}

// ------------------------------------------------------------------------------------------
// Tiny test harness
// ------------------------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push(name);
  const text =
    detail === undefined
      ? ''
      : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`  FAIL ${name}${text.slice(0, 600)}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Row ids are UUIDv7 generated on the device (sync.md §7). */
function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `Sm0ke!${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ------------------------------------------------------------------------------------------
// Clients
// ------------------------------------------------------------------------------------------

const AUTH_OPTS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

function newClient(key = ANON): SupabaseClient {
  return createClient(BASE, key, {
    auth: AUTH_OPTS,
    global: { headers: { 'x-device-id': DEVICE } },
  });
}

const svc = newClient(SERVICE);

interface Session {
  client: SupabaseClient;
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
}

async function signIn(email: string, password = PASSWORD): Promise<Session> {
  const client = newClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in of ${email} failed: ${error?.message}`);
  return {
    client,
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    userId: data.session.user.id,
    email,
  };
}

/**
 * Explains the most likely cause when a fresh token is refused after an earlier revocation:
 * `private.session_ok()` compares the `iat` claim with `profiles.sessions_revoked_at` and fails
 * closed without it (GoTrue always sets `iat`).
 */
function iatHint(token: string): string {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { iat?: unknown };
    return typeof payload.iat === 'number'
      ? `the access token has iat=${payload.iat}`
      : 'the access token has NO iat claim, so session_ok() is false once sessions_revoked_at ' +
          'is set (an earlier run revoked this account): fix the issuer, not the database';
  } catch {
    return 'the access token could not be decoded';
  }
}

interface CallOptions {
  method?: string;
  token?: string | null;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

/** Call a function the way the browser does (apikey + bearer + device id). */
async function call(path: string, opts: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { apikey: ANON, 'x-device-id': DEVICE, ...opts.headers };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? ANON}`;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const init = { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body };
  try {
    return await fetch(`${FN}/${path}`, init);
  } catch {
    // A pooled connection that the server closed (e.g. after refusing a huge upload): once more.
    await sleep(200);
    return fetch(`${FN}/${path}`, init);
  }
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

// ------------------------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 digits, 30 s) on WebCrypto
// ------------------------------------------------------------------------------------------

function base32Decode(text: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function totp(secret: string, timeSeconds = Date.now() / 1000): Promise<string> {
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(timeSeconds / 30)));
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter.buffer));
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

// ------------------------------------------------------------------------------------------
// Smoke accounts (service key)
// ------------------------------------------------------------------------------------------

async function findUserId(email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** Create (or reset) an account with a fresh random password; returns its id. */
async function ensureAccount(email: string, fullName: string, password: string): Promise<string> {
  let id = await findUserId(email);
  if (!id) {
    const created = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user)
      throw new Error(`createUser ${email}: ${created.error?.message}`);
    id = created.data.user.id;
  } else {
    const updated = await svc.auth.admin.updateUserById(id, { password, ban_duration: 'none' });
    if (updated.error) throw new Error(`updateUser ${email}: ${updated.error.message}`);
  }
  const profile = await svc
    .from('profiles')
    .upsert(
      { id, full_name: fullName, preferred_language: 'en', active: true },
      { onConflict: 'id' },
    );
  if (profile.error) throw new Error(`profile of ${email}: ${profile.error.message}`);
  return id;
}

async function removeFactors(userId: string): Promise<void> {
  const { data } = await svc.auth.admin.mfa.listFactors({ userId });
  for (const factor of data?.factors ?? [])
    await svc.auth.admin.mfa.deleteFactor({ userId, id: factor.id });
}

/** The dedicated head-office account at aal2. `cleanup` takes the grant away again. */
async function smokeHq(): Promise<{ session: Session; cleanup: () => Promise<void> }> {
  const email = 'smoke.hq@example.org';
  const password = randomPassword();
  const id = await ensureAccount(email, 'Smoke HQ (functions)', password);
  await removeFactors(id);
  const live = await svc
    .from('user_roles')
    .select('id')
    .eq('user_id', id)
    .eq('role', 'hq_admin')
    .is('deleted_at', null);
  if (live.error) throw new Error(`user_roles: ${live.error.message}`);
  let grantId = live.data[0]?.id as string | undefined;
  if (!grantId) {
    const any = await svc
      .from('user_roles')
      .select('id')
      .eq('user_id', id)
      .eq('role', 'hq_admin')
      .limit(1);
    if (any.data?.[0]) {
      grantId = any.data[0].id as string;
      const revived = await svc.from('user_roles').update({ deleted_at: null }).eq('id', grantId);
      if (revived.error) throw new Error(`revive grant: ${revived.error.message}`);
    } else {
      const inserted = await svc
        .from('user_roles')
        .insert({ user_id: id, role: 'hq_admin', scope_type: 'global', scope_id: null })
        .select('id')
        .single();
      if (inserted.error) throw new Error(`grant hq_admin: ${inserted.error.message}`);
      grantId = inserted.data.id as string;
    }
  }

  const first = await signIn(email, password);
  const enroll = await first.client.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `smoke-${RUN}`,
  });
  if (enroll.error) throw new Error(`mfa.enroll: ${enroll.error.message}`);
  const challenge = await first.client.auth.mfa.challenge({ factorId: enroll.data.id });
  if (challenge.error) throw new Error(`mfa.challenge: ${challenge.error.message}`);
  const verify = await first.client.auth.mfa.verify({
    factorId: enroll.data.id,
    challengeId: challenge.data.id,
    code: await totp(enroll.data.totp.secret),
  });
  if (verify.error) throw new Error(`mfa.verify: ${verify.error.message}`);
  const session: Session = {
    client: first.client,
    token: verify.data.access_token,
    refreshToken: verify.data.refresh_token,
    userId: id,
    email,
  };
  const cleanup = async (): Promise<void> => {
    await svc.from('user_roles').update({ deleted_at: new Date().toISOString() }).eq('id', grantId);
    await removeFactors(id);
    await svc.auth.admin.updateUserById(id, { password: randomPassword() });
  };
  return { session, cleanup };
}

// ------------------------------------------------------------------------------------------
// Export helpers
// ------------------------------------------------------------------------------------------

interface ExportColumn {
  key: string;
  header: string;
  kind: string;
  enum?: string;
}
interface ExportColumns {
  dir: string;
  capabilities: { people: boolean; restricted: boolean };
  columns: ExportColumn[];
  enums: Record<string, Record<string, string>>;
}

async function exportColumns(s: Session, lang: string): Promise<ExportColumns> {
  const { data, error } = await s.client.rpc('export_columns', { p_lang: lang });
  if (error) throw new Error(`export_columns: ${error.message}`);
  return data as ExportColumns;
}

interface ExportOutcome {
  status: number;
  jobId: string | null;
  job: Record<string, unknown> | null;
  download: {
    url: string;
    expires_in: number;
    file_name: string;
    bytes: number;
    row_count: number;
  } | null;
  bytes: Uint8Array | null;
  contentType: string | null;
  disposition: string | null;
  seconds: number;
  fallback: unknown;
}

async function runExport(
  s: Session,
  format: string,
  lang: string,
  filters: unknown = {},
): Promise<ExportOutcome> {
  const started = Date.now();
  const res = await call('export', { token: s.token, json: { format, lang, filters } });
  const first = await bodyOf(res);
  const job = (first.job ?? null) as Record<string, unknown> | null;
  const out: ExportOutcome = {
    status: res.status,
    jobId: typeof job?.id === 'string' ? job.id : null,
    job,
    download: null,
    bytes: null,
    contentType: null,
    disposition: null,
    seconds: 0,
    fallback: null,
  };
  if (!out.jobId) {
    out.job = first;
    return out;
  }
  for (let i = 0; i < 240; i++) {
    const status = await bodyOf(await call(`export?job=${out.jobId}`, { token: s.token }));
    out.job = (status.job ?? null) as Record<string, unknown> | null;
    out.fallback = status.fallback ?? null;
    const state = out.job?.state;
    if (state === 'done') {
      out.download = (status.download ?? null) as ExportOutcome['download'];
      break;
    }
    if (state === 'failed' || state === 'cancelled') break;
    await sleep(250);
  }
  if (out.download?.url) {
    const file = await fetch(out.download.url);
    out.contentType = file.headers.get('content-type');
    out.disposition = file.headers.get('content-disposition');
    out.bytes = new Uint8Array(await file.arrayBuffer());
  }
  out.seconds = (Date.now() - started) / 1000;
  return out;
}

function csvTable(bytes: Uint8Array): {
  hasBom: boolean;
  crlf: boolean;
  header: string[];
  rows: string[][];
} {
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  const parsed = parseCsv(text, { delimiter: ',' });
  return {
    hasBom,
    crlf: text.includes('\r\n') && !/[^\r]\n/.test(text.replace(/"[^"]*"/g, '')),
    header: parsed.rows[0] ?? [],
    rows: parsed.rows.slice(1),
  };
}

function column(table: { header: string[]; rows: string[][] }, header: string): string[] {
  const i = table.header.indexOf(header);
  return i < 0 ? [] : table.rows.map((r) => r[i] ?? '');
}

function headerOf(columns: ExportColumns, key: string): string {
  const c = columns.columns.find((x) => x.key === key);
  if (!c) throw new Error(`export column ${key} is missing`);
  return c.header;
}

// ------------------------------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------------------------------

function tileOf(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

function metres(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

interface ProjectPoint {
  code: string;
  name_ar: string;
  type: string;
  lon: number;
  lat: number;
}

// ------------------------------------------------------------------------------------------
// The checks
// ------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Edge Functions smoke test against ${BASE}`);
  const health = await fetch(`${BASE}/auth/v1/health`, { headers: { apikey: ANON } }).catch(
    () => null,
  );
  if (!health?.ok) throw new Error(`the API at ${BASE} does not answer`);

  const pemba = await signIn('collector.pemba@example.org');
  const mombasa = await signIn('collector.mombasa@example.org');
  const viewer = await signIn('viewer@example.org');

  // Reference facts taken with the service key (what the database really holds).
  const branch = await svc.from('branches').select('id, name_ar').eq('code', 'PEMBA').single();
  if (branch.error) throw new Error(`branch PEMBA: ${branch.error.message}`);
  const all = await svc
    .from('projects')
    .select('code, branch_id')
    .is('deleted_at', null)
    .limit(10_000);
  if (all.error) throw new Error(`projects: ${all.error.message}`);
  const pembaCodes = new Set(
    all.data.filter((p) => p.branch_id === branch.data.id).map((p) => p.code as string),
  );
  const otherCodes = new Set(
    all.data.filter((p) => p.branch_id !== branch.data.id).map((p) => p.code as string),
  );

  // ---------------------------------------------------------------- CORS and the JWT gate
  section('CORS and authentication');
  {
    const pre = await fetch(`${FN}/export`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, apikey, content-type, x-device-id',
      },
    });
    await pre.body?.cancel();
    check(
      'preflight from the app origin → 204 with CORS headers',
      pre.status === 204 &&
        pre.headers.get('access-control-allow-origin') === ORIGIN &&
        (pre.headers.get('access-control-allow-headers') ?? '').includes('x-device-id') &&
        (pre.headers.get('access-control-allow-methods') ?? '').includes('POST'),
      { status: pre.status, origin: pre.headers.get('access-control-allow-origin') },
    );
    const foreign = await fetch(`${FN}/export`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    await foreign.body?.cancel();
    check(
      'preflight from a foreign origin gets no allow-origin',
      foreign.headers.get('access-control-allow-origin') === null,
    );
    const noAuth = await call('export', { token: null, json: { format: 'csv' } });
    await noAuth.body?.cancel();
    check('no bearer → 401', noAuth.status === 401, noAuth.status);
    const anon = await call('export', { json: { format: 'csv' } });
    const anonBody = await bodyOf(anon);
    check(
      'anon key as bearer → 401 not_authenticated',
      anon.status === 401 && anonBody.message === 'not_authenticated',
      { status: anon.status, anonBody },
    );
    const wrongMethod = await call('sync_pull', { token: pemba.token, method: 'GET' });
    await wrongMethod.body?.cancel();
    check('wrong method → 405', wrongMethod.status === 405, wrongMethod.status);
  }

  // ---------------------------------------------------------------- export: collector, Arabic CSV
  section('export — collector.pemba, Arabic, CSV');
  const colsAr = await exportColumns(pemba, 'ar');
  let pembaJobId: string | null;
  {
    const out = await runExport(pemba, 'csv', 'ar');
    pembaJobId = out.jobId;
    check('POST → 202 with a queued job', out.status === 202 && out.jobId !== null, {
      status: out.status,
      job: out.job,
    });
    check(
      'job reaches "done" and offers a signed URL',
      out.job?.state === 'done' && typeof out.download?.url === 'string',
      out.job,
    );
    check(
      'signed URL is short-lived (≤ 600 s) and carries a token',
      (out.download?.expires_in ?? 9999) <= 600 && /[?&]token=/.test(out.download?.url ?? ''),
      out.download,
    );
    check(
      'storage path is {user_id}/{job_id}.csv',
      out.job?.storage_path === `${pemba.userId}/${out.jobId}.csv`,
      out.job?.storage_path,
    );
    check(
      'downloaded as an attachment with a .csv file name',
      /attachment/i.test(out.disposition ?? '') && /\.csv/.test(out.disposition ?? ''),
      out.disposition,
    );
    if (out.bytes) {
      const t = csvTable(out.bytes);
      check('UTF-8 BOM and CRLF line ends', t.hasBom && t.crlf, { bom: t.hasBom, crlf: t.crlf });
      check(
        'header row = Arabic titles of export_columns, in order',
        JSON.stringify(t.header) === JSON.stringify(colsAr.columns.map((c) => c.header)) &&
          t.header.includes('رمز المشروع') &&
          t.header.includes('النوع'),
        t.header.slice(0, 8),
      );
      check(
        `ALL columns the caller may see are present (${t.header.length})`,
        t.header.length === colsAr.columns.length && t.header.length >= 60,
        t.header.length,
      );
      const types = column(t, headerOf(colsAr, 'type'));
      const statuses = column(t, headerOf(colsAr, 'status'));
      const typeLabels = new Set(Object.values(colsAr.enums.project_type ?? {}));
      const statusLabels = new Set(Object.values(colsAr.enums.project_status ?? {}));
      check(
        'type values are translated (مسجد …), no raw codes',
        types.length > 0 && types.includes('مسجد') && types.every((v) => typeLabels.has(v)),
        [...new Set(types)],
      );
      check(
        'status values are translated (يعمل …), no raw codes',
        statuses.includes('يعمل') && statuses.every((v) => statusLabels.has(v)),
        [...new Set(statuses)],
      );
      const booleans = column(t, headerOf(colsAr, 'land_expandable')).filter((v) => v !== '');
      check(
        'booleans are translated (نعم / لا)',
        booleans.every((v) => v === 'نعم' || v === 'لا'),
        [...new Set(booleans)],
      );
      check(
        'no salary / restricted column',
        colsAr.capabilities.restricted === false &&
          !colsAr.columns.some((c) =>
            ['monthly_payroll', 'monthly_payroll_usd', 'ibadi_families'].includes(c.key),
          ) &&
          !t.header.some((h) => /راتب|رواتب|payroll/i.test(h)),
        t.header.filter((h) => /راتب|رواتب|payroll/i.test(h)),
      );
      const codes = column(t, headerOf(colsAr, 'code'));
      const branches = column(t, headerOf(colsAr, 'branch'));
      check(
        `only Pemba projects (${codes.length} rows, database has ${pembaCodes.size})`,
        codes.length > 0 &&
          codes.every((c) => pembaCodes.has(c) || !otherCodes.has(c)) &&
          !codes.some((c) => otherCodes.has(c)) &&
          branches.every((b) => b === branch.data.name_ar),
        { foreign: codes.filter((c) => otherCodes.has(c)), branches: [...new Set(branches)] },
      );
      check('row_count of the job = data rows of the file', out.job?.row_count === t.rows.length, {
        job: out.job?.row_count,
        file: t.rows.length,
      });
      check('bytes of the job = size of the file', out.job?.bytes === out.bytes.byteLength, {
        job: out.job?.bytes,
        file: out.bytes.byteLength,
      });
    } else check('file downloaded', false, out);
    const note = await pemba.client
      .from('notifications')
      .select('kind, payload')
      .eq('kind', 'export.ready')
      .order('created_at', { ascending: false })
      .limit(5);
    check(
      'notification export.ready for the job',
      (note.data ?? []).some((n) => (n.payload as { job_id?: string }).job_id === out.jobId),
      note.error ?? note.data?.length,
    );
    console.log(`       (${out.seconds.toFixed(1)} s from request to downloaded file)`);
  }

  // ---------------------------------------------------------------- export: collector, Arabic XLSX
  section('export — collector.pemba, Arabic, XLSX');
  {
    const out = await runExport(pemba, 'xlsx', 'ar');
    check(
      'job done, stored as {user_id}/{job_id}.xlsx',
      out.job?.state === 'done' && out.job?.storage_path === `${pemba.userId}/${out.jobId}.xlsx`,
      out.job,
    );
    if (out.bytes) {
      const wb = XLSX.read(out.bytes, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]!]!;
      const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
      const header = (table[0] ?? []).map(String);
      const rows = table.slice(1).map((r) => r.map(String));
      check(
        'readable by SheetJS; header row = Arabic titles',
        JSON.stringify(header) === JSON.stringify(colsAr.columns.map((c) => c.header)),
        header.slice(0, 6),
      );
      const t = { header, rows };
      const types = column(t, headerOf(colsAr, 'type'));
      const statuses = column(t, headerOf(colsAr, 'status'));
      check(
        'values are translated (مسجد / يعمل)',
        types.includes('مسجد') && statuses.includes('يعمل'),
        { types: [...new Set(types)], statuses: [...new Set(statuses)] },
      );
      check('no salary column', !header.some((h) => /راتب|رواتب|payroll/i.test(h)));
      const codes = column(t, headerOf(colsAr, 'code'));
      check(
        'only Pemba projects',
        codes.length > 0 && !codes.some((c) => otherCodes.has(c)),
        codes.length,
      );
      const entries = readZipDirectory(out.bytes);
      const sheetEntry = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml');
      const xml = sheetEntry
        ? new TextDecoder().decode(await readZipEntry(out.bytes, sheetEntry, 64 * 1024 * 1024))
        : '';
      check(
        'sheet is right-to-left and the header row is frozen',
        /<sheetView[^>]*rightToLeft="1"/.test(xml) &&
          /<pane[^>]*ySplit="1"[^>]*state="frozen"/.test(xml),
        xml.slice(0, 400),
      );
      check(
        'numbers are numeric cells (capacity)',
        typeof sheet[XLSX.utils.encode_cell({ r: 1, c: header.indexOf(headerOf(colsAr, 'lat')) })]
          ?.v === 'number',
      );
      check('no formula cell in the workbook', !/<f[\s>]/.test(xml));
    } else check('file downloaded', false, out);
    console.log(`       (${out.seconds.toFixed(1)} s)`);
  }

  // ---------------------------------------------------------------- export: other languages, filters, ownership
  section('export — languages, filters, ownership');
  {
    const sw = await runExport(pemba, 'csv', 'sw', { type: 'mosque' });
    if (sw.bytes) {
      const colsSw = await exportColumns(pemba, 'sw');
      const t = csvTable(sw.bytes);
      const types = column(t, headerOf(colsSw, 'type'));
      check(
        'Swahili export with filter type=mosque: every row is "Msikiti"',
        types.length > 0 &&
          types.every((v) => v === 'Msikiti') &&
          JSON.stringify(t.header) === JSON.stringify(colsSw.columns.map((c) => c.header)),
        [...new Set(types)],
      );
    } else check('Swahili export produced a file', false, sw.job);

    const viewerOut = await runExport(viewer, 'csv', 'en');
    if (viewerOut.bytes) {
      const colsViewer = await exportColumns(viewer, 'en');
      const t = csvTable(viewerOut.bytes);
      check(
        'viewer export has no people columns (manager, staff list, entered by)',
        colsViewer.capabilities.people === false &&
          !colsViewer.columns.some((c) =>
            ['manager_name', 'manager_phone', 'staff_list', 'entered_by'].includes(c.key),
          ) &&
          t.header.length === colsViewer.columns.length,
        t.header.length,
      );
    } else check('viewer export produced a file', false, viewerOut.job);

    const foreign = await call(`export?job=${pembaJobId}`, { token: mombasa.token });
    const foreignBody = await bodyOf(foreign);
    check(
      "another user's job → 404 (no signed URL)",
      foreign.status === 404 && foreignBody.download === undefined,
      { status: foreign.status, foreignBody },
    );
    const direct = await mombasa.client.storage
      .from('exports')
      .createSignedUrl(`${pemba.userId}/${pembaJobId}.csv`, 60);
    check(
      "another user cannot sign the owner's file directly either",
      direct.error !== null,
      direct.data,
    );
    const bad = await call('export', { token: pemba.token, json: { format: 'pdf' } });
    const badBody = await bodyOf(bad);
    check(
      'unknown format → 422 invalid_format',
      bad.status === 422 && badBody.message === 'invalid_format',
      badBody,
    );
    const unknown = await call('export?job=00000000-0000-7000-8000-000000000000', {
      token: pemba.token,
    });
    await unknown.body?.cancel();
    check('unknown job id → 404', unknown.status === 404, unknown.status);
  }

  // ---------------------------------------------------------------- export: head office at aal2
  section('export — hq_admin at aal2 (dedicated smoke account)');
  const hq = await smokeHq();
  try {
    const ctx = await hq.session.client.rpc('my_context');
    // The client still holds the aal1 token in its Authorization header until setSession:
    await hq.session.client.auth.setSession({
      access_token: hq.session.token,
      refresh_token: hq.session.refreshToken,
    });
    const ctx2 = await hq.session.client.rpc('my_context');
    check(
      'smoke HQ account is hq_admin at aal2',
      (ctx2.data as { capabilities?: { is_hq?: boolean } } | null)?.capabilities?.is_hq === true,
      ctx2.error ?? { before: (ctx.data as { aal?: string } | null)?.aal, after: ctx2.data },
    );

    const colsHq = await exportColumns(hq.session, 'en');
    const out = await runExport(hq.session, 'csv', 'en');
    if (out.bytes) {
      const t = csvTable(out.bytes);
      const payrollHeader = headerOf(colsHq, 'monthly_payroll');
      check(
        'salary columns appear (monthly_payroll, monthly_payroll_usd)',
        colsHq.capabilities.restricted === true &&
          t.header.includes(payrollHeader) &&
          t.header.includes(headerOf(colsHq, 'monthly_payroll_usd')),
        t.header.filter((h) => /payroll/i.test(h)),
      );
      const payroll = column(t, payrollHeader).filter((v) => v !== '');
      check(
        `payroll cells carry amounts per currency (${payroll.length} projects)`,
        payroll.length > 0 &&
          payroll.every((v) => /^[A-Z]{3} [\d.]+( \| [A-Z]{3} [\d.]+)*$/.test(v)),
        payroll.slice(0, 3),
      );
      check(
        'sensitive community columns appear (ibadi_families)',
        t.header.includes(headerOf(colsHq, 'ibadi_families')),
      );
      const codes = column(t, headerOf(colsHq, 'code'));
      check(
        `all countries are exported (${codes.length} rows, database has ${all.data.length})`,
        codes.some((c) => otherCodes.has(c)) && codes.some((c) => pembaCodes.has(c)),
        codes.length,
      );
      const types = column(t, headerOf(colsHq, 'type'));
      check(
        'English labels (Mosque / Active)',
        types.includes('Mosque') && column(t, headerOf(colsHq, 'status')).includes('Active'),
        [...new Set(types)],
      );
      check('more columns than the collector sees', t.header.length > colsAr.columns.length, {
        hq: t.header.length,
        collector: colsAr.columns.length,
      });
    } else check('HQ export produced a file', false, out.job);

    // ---------------------------------------------------------------- admin
    section('admin — session revocation through the function');
    const targetEmail = 'smoke.target@example.org';
    const targetPassword = randomPassword();
    let targetId = await findUserId(targetEmail);
    if (!targetId) {
      const created = await call('admin', {
        token: hq.session.token,
        json: {
          action: 'create_user',
          email: targetEmail,
          full_name: 'Smoke target',
          preferred_language: 'en',
          role: 'viewer',
          scope_type: 'global',
        },
      });
      const createdBody = await bodyOf(created);
      check(
        'create_user (hq) → 201 with profile and role',
        created.status === 201 &&
          typeof createdBody.user_id === 'string' &&
          createdBody.role !== null &&
          createdBody.role_error === null,
        createdBody,
      );
      targetId = typeof createdBody.user_id === 'string' ? createdBody.user_id : null;
    } else {
      const again = await call('admin', {
        token: hq.session.token,
        json: { action: 'create_user', email: targetEmail, full_name: 'Smoke target' },
      });
      const againBody = await bodyOf(again);
      check(
        'create_user for an existing e-mail → 409 user_exists',
        again.status === 409 && againBody.message === 'user_exists',
        againBody,
      );
    }
    if (targetId) {
      const reactivate = await call('admin', {
        token: hq.session.token,
        json: { action: 'set_user_active', user_id: targetId, active: true },
      });
      const reactivateBody = await bodyOf(reactivate);
      check(
        'set_user_active(true) → 200, Auth ban lifted',
        reactivate.status === 200 &&
          (reactivateBody.auth_ban as { done?: boolean; banned?: boolean } | undefined)?.done ===
            true &&
          (reactivateBody.auth_ban as { banned?: boolean }).banned === false,
        reactivateBody,
      );
      await svc.auth.admin.updateUserById(targetId, { password: targetPassword });
      // sessions_revoked_at only kills tokens issued before it: sign in a moment later.
      await sleep(1100);
      const target = await signIn(targetEmail, targetPassword);
      const before = await target.client.rpc('my_context');
      const beforeOk = (before.data as { session_ok?: boolean } | null)?.session_ok === true;
      check(
        'target can use the API before the revocation',
        beforeOk,
        beforeOk ? undefined : { hint: iatHint(target.token), answer: before.error ?? before.data },
      );

      const denied = await call('admin', {
        token: pemba.token,
        json: { action: 'revoke_sessions', user_id: targetId },
      });
      const deniedBody = await bodyOf(denied);
      check(
        'revoke_sessions by a collector → 403 forbidden (decided by the database)',
        denied.status === 403 && deniedBody.code === 'PT403',
        { status: denied.status, deniedBody },
      );

      const revoke = await call('admin', {
        token: hq.session.token,
        json: { action: 'revoke_sessions', user_id: targetId },
      });
      const revokeBody = await bodyOf(revoke);
      const logout = revokeBody.auth_logout as
        { done?: boolean; method?: string; detail?: string } | undefined;
      check(
        'revoke_sessions (hq) → 200, auth_logout_required and Auth sessions ended',
        revoke.status === 200 && revokeBody.auth_logout_required === true && logout?.done === true,
        revokeBody,
      );
      console.log(
        `       (Auth sessions ended through: ${logout?.method ?? 'nothing'}${logout?.detail ? ` — ${logout.detail}` : ''})`,
      );
      const after = await target.client.rpc('my_context');
      check(
        'the old access token is dead at once (session_ok = false)',
        (after.data as { session_ok?: boolean } | null)?.session_ok === false,
        after.error ?? after.data,
      );
      const refreshed = await target.client.auth.refreshSession({
        refresh_token: target.refreshToken,
      });
      check(
        'the refresh token no longer works',
        refreshed.error !== null && !refreshed.data.session,
        refreshed.error?.message,
      );

      const off = await call('admin', {
        token: hq.session.token,
        json: { action: 'set_user_active', user_id: targetId, active: false },
      });
      const offBody = await bodyOf(off);
      check(
        'set_user_active(false) → 200, account banned in Auth',
        off.status === 200 &&
          offBody.active === false &&
          (offBody.auth_ban as { done?: boolean } | undefined)?.done === true,
        offBody,
      );
      const blocked = await newClient().auth.signInWithPassword({
        email: targetEmail,
        password: targetPassword,
      });
      check(
        'a deactivated account cannot sign in',
        blocked.error !== null,
        blocked.data.session ? 'signed in' : blocked.error?.message,
      );

      const unknownAction = await call('admin', {
        token: hq.session.token,
        json: { action: 'drop_database' },
      });
      const unknownBody = await bodyOf(unknownAction);
      check(
        'unknown action → 422 invalid_action',
        unknownAction.status === 422 && unknownBody.message === 'invalid_action',
        unknownBody,
      );
    } else check('target account available', false);
  } finally {
    await hq.cleanup();
  }

  // ---------------------------------------------------------------- import
  section('import — CSV and XLSX parsed on the server, staged with the caller’s token');
  {
    const template = await pemba.client.rpc('import_template', { p_lang: 'ar' });
    if (template.error) throw new Error(`import_template: ${template.error.message}`);
    const tcols = (template.data as { columns: Array<{ key: string; header: string }> }).columns;
    const h = (key: string): string => {
      const c = tcols.find((x) => x.key === key);
      if (!c) throw new Error(`template column ${key} missing`);
      return c.header;
    };
    const page = await pemba.client.rpc('projects_page', {
      p_filters: {},
      p_after: null,
      p_limit: 200,
    });
    if (page.error) throw new Error(`projects_page: ${page.error.message}`);
    const points = ((page.data as { rows: ProjectPoint[] }).rows ?? []).filter(
      (p) => typeof p.lon === 'number' && typeof p.lat === 'number',
    );
    const existing = points[0];
    if (!existing) throw new Error('no located Pemba project to build the duplicate row from');
    // A free spot: at least 400 m away from every project the collector can see.
    let free = { lon: existing.lon, lat: existing.lat };
    for (let k = 1; k < 200; k++) {
      const candidate = { lon: existing.lon + 0.004 * k, lat: existing.lat + 0.0005 * (k % 7) };
      if (points.every((p) => metres(p.lon, p.lat, candidate.lon, candidate.lat) > 400)) {
        free = candidate;
        break;
      }
    }
    const typeLabel = colsAr.enums.project_type?.[existing.type] ?? existing.type;
    const header = ['external_id', 'name_ar', 'type', 'lat', 'lon', 'country', 'capacity'].map(h);
    const q = (v: string): string => `"${v.replaceAll('"', '""')}"`;
    const lines = [
      header.map(q).join(','),
      // valid: quoted field with a comma, quotes and a line break; Arabic label; Arabic-Indic digits
      [
        `smoke-${RUN}-1`,
        q(`مسجد الاختبار الآلي، "الدخان" ${RUN}\nالسطر الثاني`),
        'مسجد',
        String(free.lat),
        String(free.lon),
        'TZ',
        '١٢٠',
      ].join(','),
      // invalid: no name, unknown type, bad latitude
      [`smoke-${RUN}-2`, '', 'قلعة', 'abc', String(free.lon), 'TZ', ''].join(','),
      // duplicate: same type on the spot of an existing project
      [
        `smoke-${RUN}-3`,
        q(`نسخة مكررة ${RUN}`),
        typeLabel,
        String(existing.lat),
        String(existing.lon),
        'TZ',
        '',
      ].join(','),
      '',
    ];
    const csvBytes = new TextEncoder().encode(
      `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}`,
    );
    const form = new FormData();
    form.append('file', new Blob([csvBytes], { type: 'text/csv' }), 'smoke-import.csv');
    form.append('lang', 'ar');
    form.append('options', JSON.stringify({ file_name: `smoke-${RUN}.csv` }));
    const staged = await call('import', { token: pemba.token, body: form });
    const summary = await bodyOf(staged);
    const counts = (summary.counts ?? {}) as Record<string, number>;
    check(
      'multipart CSV → 200 with the import_stage summary',
      staged.status === 200 &&
        typeof summary.batch_id === 'string' &&
        summary.state === 'validated',
      summary,
    );
    check(
      'preview summary: 3 rows = 1 valid, 1 invalid, 1 duplicate',
      counts.total === 3 && counts.valid === 1 && counts.invalid === 1 && counts.duplicate === 1,
      counts,
    );
    const file = (summary.file ?? {}) as {
      kind?: string;
      headers?: string[];
      rows?: number;
      encoding?: string;
      delimiter?: string;
    };
    check(
      'file info: csv, utf-8, Arabic headers used as keys',
      file.kind === 'csv' &&
        file.encoding === 'utf-8' &&
        file.rows === 3 &&
        JSON.stringify(file.headers) === JSON.stringify(header),
      file,
    );
    check(
      'no header was ignored',
      Array.isArray(summary.ignored_columns) && summary.ignored_columns.length === 0,
      summary.ignored_columns,
    );
    const firstErrors = (summary.first_errors ?? []) as Array<{
      row_no: number;
      errors: Array<{ field: string; code: string }>;
    }>;
    check(
      'the invalid row is row 2 (required name, invalid type, invalid latitude)',
      firstErrors.length === 1 &&
        firstErrors[0]!.row_no === 2 &&
        firstErrors[0]!.errors.some((e) => e.field === 'type' && e.code === 'invalid_value'),
      firstErrors,
    );
    if (typeof summary.batch_id === 'string') {
      const preview = await pemba.client.rpc('import_preview', {
        p_batch_id: summary.batch_id,
        p_after: 0,
        p_limit: 10,
      });
      const rows = ((preview.data as { rows?: Array<Record<string, unknown>> } | null)?.rows ??
        []) as Array<{
        row_no: number;
        state: string;
        action: string | null;
        parsed?: { project?: { name_ar?: string; capacity?: number; type?: string } };
        warnings?: Array<{ code: string }>;
      }>;
      check(
        'import_preview shows valid / invalid / duplicate in file order',
        rows.map((r) => r.state).join(',') === 'valid,invalid,duplicate',
        preview.error ?? rows.map((r) => `${r.row_no}:${r.state}`),
      );
      const valid = rows[0]?.parsed?.project;
      check(
        'quoted Arabic text, Arabic label and Arabic-Indic digits arrive intact',
        valid?.type === 'mosque' &&
          valid.capacity === 120 &&
          (valid.name_ar ?? '').includes('"الدخان"') &&
          (valid.name_ar ?? '').includes('،'),
        valid,
      );
      check(
        'the duplicate row points at an existing project',
        rows[2]?.action === 'skip' &&
          (rows[2]?.warnings ?? []).some((w) => w.code === 'possible_duplicate'),
        rows[2],
      );
    }

    // XLSX with a formula cell and English keys as headers, sent as the raw body.
    const sheet = XLSX.utils.aoa_to_sheet([
      ['name_ar', 'type', 'lat', 'lon', 'country', 'capacity', 'build_date'],
      [
        `مدرسة الاختبار ${RUN}`,
        'school',
        free.lat,
        free.lon,
        'TZ',
        0,
        new Date(Date.UTC(2020, 4, 17)),
      ],
    ]);
    sheet.F2 = { t: 'n', v: 150, f: '100+50' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Projects');
    const xlsxBytes = new Uint8Array(
      XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true }) as ArrayBuffer,
    );
    const stagedXlsx = await call(`import?file_name=smoke-${RUN}.xlsx`, {
      token: pemba.token,
      body: new Blob([xlsxBytes]),
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    });
    const xs = await bodyOf(stagedXlsx);
    const xfile = (xs.file ?? {}) as { kind?: string; warnings?: string[]; sheet?: string };
    check(
      'raw XLSX body → 200, one valid row, formula reported and not evaluated',
      stagedXlsx.status === 200 &&
        (xs.counts as Record<string, number> | undefined)?.valid === 1 &&
        xfile.kind === 'xlsx' &&
        (xfile.warnings ?? []).includes('formulas_ignored'),
      xs,
    );
    if (typeof xs.batch_id === 'string') {
      const preview = await pemba.client.rpc('import_preview', {
        p_batch_id: xs.batch_id,
        p_after: 0,
        p_limit: 5,
      });
      const project = (
        preview.data as { rows?: Array<{ parsed?: { project?: Record<string, unknown> } }> } | null
      )?.rows?.[0]?.parsed?.project;
      check(
        'XLSX cells: cached formula value 150, date cell → 2020-05-17',
        project?.capacity === 150 && project?.build_date === '2020-05-17',
        project,
      );
    }

    const tooMany = ['name_ar,type,lat,lon,country'];
    for (let i = 0; i < 5001; i++) tooMany.push(`row ${i},mosque,-5.1,39.7,TZ`);
    const big = await call('import', {
      token: pemba.token,
      body: tooMany.join('\n'),
      headers: { 'content-type': 'text/csv' },
    });
    const bigBody = await bodyOf(big);
    check(
      '5,001 rows → 422 too_many_rows (nothing staged)',
      big.status === 422 && bigBody.message === 'too_many_rows',
      bigBody,
    );
    const huge = await call('import', {
      token: pemba.token,
      body: new Uint8Array(26 * 1024 * 1024),
      headers: { 'content-type': 'text/csv' },
    });
    await huge.body?.cancel();
    check('a 26 MB body → 413', huge.status === 413, huge.status);
    const exe = await call('import', {
      token: pemba.token,
      body: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
      headers: { 'content-type': 'application/vnd.ms-excel' },
    });
    const exeBody = await bodyOf(exe);
    check(
      'legacy .xls (may carry macros) → 415 unsupported_file_type',
      exe.status === 415 && exeBody.message === 'unsupported_file_type',
      exeBody,
    );
    const viewerImport = await call('import', {
      token: viewer.token,
      json: { rows: [{ name_ar: 'x', type: 'mosque', lat: -5.1, lon: 39.7, country: 'TZ' }] },
    });
    const viewerBody = await bodyOf(viewerImport);
    check(
      'a viewer cannot stage an import → 403',
      viewerImport.status === 403 && viewerBody.code === 'PT403',
      viewerBody,
    );

    // ---------------------------------------------------------------- tiles
    section('tiles');
    const t8 = tileOf(existing.lon, existing.lat, 8);
    const tile = await call(`tiles/8/${t8.x}/${t8.y}`, {
      token: pemba.token,
      method: 'GET',
      headers: { 'accept-encoding': 'identity' },
    });
    const tileBytes = new Uint8Array(await tile.arrayBuffer());
    check(
      `Pemba tile 8/${t8.x}/${t8.y} → 200 MVT or 204 (got ${tile.status}, ${tileBytes.byteLength} bytes)`,
      (tile.status === 200 &&
        tile.headers.get('content-type') === MVT &&
        tileBytes.byteLength > 0) ||
        (tile.status === 204 && tileBytes.byteLength === 0),
      { status: tile.status, type: tile.headers.get('content-type') },
    );
    check(
      'z < 14: private, max-age=300, stale-while-revalidate=600; Vary: Authorization; ETag',
      tile.headers.get('cache-control') === 'private, max-age=300, stale-while-revalidate=600' &&
        /authorization/i.test(tile.headers.get('vary') ?? '') &&
        /^(W\/)?"[^"]+"$/.test(tile.headers.get('etag') ?? ''),
      {
        cc: tile.headers.get('cache-control'),
        vary: tile.headers.get('vary'),
        etag: tile.headers.get('etag'),
      },
    );
    check(
      'Server-Timing reports the database time',
      /db;dur=/.test(tile.headers.get('server-timing') ?? ''),
      tile.headers.get('server-timing'),
    );
    const etag = tile.headers.get('etag') ?? '';
    const cached = await call(`tiles/8/${t8.x}/${t8.y}`, {
      token: pemba.token,
      method: 'GET',
      headers: { 'if-none-match': etag },
    });
    await cached.body?.cancel();
    check('If-None-Match → 304', cached.status === 304, cached.status);
    const t14 = tileOf(existing.lon, existing.lat, 14);
    const points14 = await call(
      `tiles/14/${t14.x}/${t14.y}?f=${encodeURIComponent(JSON.stringify({ layers: ['points'] }))}&e=epoch`,
      { token: pemba.token, method: 'GET' },
    );
    const bytes14 = new Uint8Array(await points14.arrayBuffer());
    check(
      `z 14 tile of an existing project → 200 MVT with private, max-age=30 (${bytes14.byteLength} bytes)`,
      points14.status === 200 &&
        points14.headers.get('content-type') === MVT &&
        points14.headers.get('cache-control') === 'private, max-age=30' &&
        bytes14.byteLength > 0,
      { status: points14.status, cc: points14.headers.get('cache-control') },
    );
    check(
      'the z 14 tile contains the project code',
      new TextDecoder().decode(bytes14).includes(existing.code),
      existing.code,
    );
    const foreignTile = await call(`tiles/14/${t14.x}/${t14.y}`, {
      token: mombasa.token,
      method: 'GET',
    });
    const foreignBytes = new Uint8Array(await foreignTile.arrayBuffer());
    check(
      'the same tile for the Mombasa collector is empty → 204',
      foreignTile.status === 204 && foreignBytes.byteLength === 0,
      { status: foreignTile.status, bytes: foreignBytes.byteLength },
    );
    const ocean = await call('tiles/8/0/0', { token: pemba.token, method: 'GET' });
    await ocean.body?.cancel();
    check(
      'empty tile → 204 with the same cache headers',
      ocean.status === 204 &&
        ocean.headers.get('cache-control') === 'private, max-age=300, stale-while-revalidate=600',
      ocean.status,
    );
    const outside = await call('tiles/8/999/0', { token: pemba.token, method: 'GET' });
    const outsideBody = await bodyOf(outside);
    check(
      'x outside the zoom level → 422, not cached',
      outside.status === 422 &&
        outsideBody.message === 'invalid_tile' &&
        outside.headers.get('cache-control') === 'no-store',
      outsideBody,
    );
    const notTile = await call('tiles/8/1', { token: pemba.token, method: 'GET' });
    await notTile.body?.cancel();
    check('malformed tile path → 404', notTile.status === 404, notTile.status);
    const badFilter = await call(
      `tiles/8/${t8.x}/${t8.y}?f=${encodeURIComponent('{"type":"x\' or 1=1"}')}`,
      { token: pemba.token, method: 'GET' },
    );
    await badFilter.body?.cancel();
    check('invalid filter value → 422', badFilter.status === 422, badFilter.status);
  }

  // ---------------------------------------------------------------- sync wrappers
  section('sync_pull / sync_push — pass-through wrappers');
  {
    const viaFn = await call('sync_pull', { token: pemba.token, json: { cursor: null, limit: 5 } });
    const fnBody = await bodyOf(viaFn);
    const direct = await pemba.client.rpc('sync_pull', { p_cursor: null, p_limit: 5 });
    check(
      'sync_pull through the function → 200 with changes, cursor, scope_epoch',
      viaFn.status === 200 &&
        Array.isArray(fnBody.changes) &&
        fnBody.cursor !== undefined &&
        typeof fnBody.scope_epoch === 'string',
      fnBody,
    );
    check(
      'same first page as the direct RPC',
      direct.error === null &&
        JSON.stringify((fnBody.changes as Array<{ table: string }>).map((c) => c.table)) ===
          JSON.stringify(
            ((direct.data as { changes: Array<{ table: string }> }).changes ?? []).map(
              (c) => c.table,
            ),
          ) &&
        fnBody.scope_epoch === (direct.data as { scope_epoch: string }).scope_epoch,
      direct.error,
    );
    check(
      'Server-Timing and rate-limit headers',
      /rpc;dur=/.test(viaFn.headers.get('server-timing') ?? '') &&
        viaFn.headers.get('x-ratelimit-limit') === '600',
      { timing: viaFn.headers.get('server-timing'), limit: viaFn.headers.get('x-ratelimit-limit') },
    );
    const badCursor = await call('sync_pull', {
      token: pemba.token,
      json: { p_cursor: { nonsense: true } },
    });
    const badCursorBody = await bodyOf(badCursor);
    const directBad = await pemba.client.rpc('sync_pull', { p_cursor: { nonsense: true } });
    check(
      'an RPC error passes through with its status and body (invalid cursor)',
      badCursor.status === (directBad.status ?? 0) &&
        badCursorBody.code === directBad.error?.code &&
        badCursorBody.message === directBad.error?.message,
      {
        fn: { status: badCursor.status, ...badCursorBody },
        direct: { status: directBad.status, error: directBad.error },
      },
    );

    const push = await call('sync_push', { token: pemba.token, json: { ops: [] } });
    const pushBody = await bodyOf(push);
    const directPush = await pemba.client.rpc('sync_push', { p_ops: [], p_device_id: DEVICE });
    check(
      'sync_push (empty batch, aliases, device id from the header) = direct RPC',
      push.status === (directPush.status ?? 0) &&
        (push.status === 200
          ? Array.isArray(pushBody.results) && pushBody.results.length === 0
          : pushBody.message === directPush.error?.message),
      {
        fn: { status: push.status, ...pushBody },
        direct: { status: directPush.status, error: directPush.error },
      },
    );
    const mismatch = await call('sync_push', {
      token: pemba.token,
      json: { p_ops: [], p_device_id: 'another-device' },
    });
    const mismatchBody = await bodyOf(mismatch);
    check(
      'device mismatch → 422 device_mismatch from the RPC',
      mismatch.status === 422 && mismatchBody.message === 'device_mismatch',
      mismatchBody,
    );
    const notJson = await call('sync_push', {
      token: pemba.token,
      body: '{not json',
      headers: { 'content-type': 'application/json' },
    });
    await notJson.body?.cancel();
    check('malformed JSON → 400', notJson.status === 400, notJson.status);

    // sync.md §4.2 rule 4: an insert carries the offline entry time; the wrapper must not drop it.
    const donorId = uuidv7();
    const enteredAt = '2026-01-15T08:30:00.000Z';
    const insert = await call('sync_push', {
      token: pemba.token,
      json: {
        p_device_id: DEVICE,
        p_ops: [
          {
            op_id: crypto.randomUUID(),
            table: 'donors',
            id: donorId,
            kind: 'upsert',
            base_version: 0,
            fields: { name_ar: `متبرع فحص الدوال ${RUN}`, created_at: enteredAt },
            client_ts: new Date().toISOString(),
          },
        ],
      },
    });
    const insertBody = await bodyOf(insert);
    const inserted = (
      insertBody.results as Array<{ status?: string; version?: number }> | undefined
    )?.[0];
    const stored = await svc
      .from('donors')
      .select('created_at, created_by')
      .eq('id', donorId)
      .maybeSingle();
    check(
      'insert through sync_push keeps the device created_at (offline entry time)',
      insert.status === 200 &&
        inserted?.status === 'applied' &&
        stored.data !== null &&
        Date.parse(stored.data.created_at as string) === Date.parse(enteredAt) &&
        stored.data.created_by === pemba.userId,
      { insertBody, stored: stored.data, error: stored.error },
    );
    if (inserted?.status === 'applied') {
      const removal = await call('sync_push', {
        token: pemba.token,
        json: {
          p_device_id: DEVICE,
          p_ops: [
            {
              op_id: crypto.randomUUID(),
              table: 'donors',
              id: donorId,
              kind: 'delete',
              base_version: inserted.version ?? 1,
            },
          ],
        },
      });
      const removalBody = await bodyOf(removal);
      check(
        'the smoke donor is soft-deleted again through the wrapper',
        removal.status === 200 &&
          (removalBody.results as Array<{ status?: string }> | undefined)?.[0]?.status ===
            'applied',
        removalBody,
      );
    }
  }

  // ---------------------------------------------------------------- purge-photos
  section('purge-photos — service role only');
  {
    const asUser = await call('purge-photos', { token: pemba.token, json: {} });
    const userBody = await bodyOf(asUser);
    check('a normal user → 403 forbidden', asUser.status === 403 && userBody.code === 'PT403', {
      status: asUser.status,
      userBody,
    });
    const asAnon = await call('purge-photos', { json: {} });
    await asAnon.body?.cancel();
    check('the anon key → 403', asAnon.status === 403, asAnon.status);
    const asService = await call('purge-photos', {
      token: SERVICE,
      json: { limit: 100, max_batches: 2 },
    });
    const serviceBody = await bodyOf(asService);
    const photos = serviceBody.photos as
      { marked?: number; objects_removed?: number; more?: boolean } | undefined;
    const exportsOut = serviceBody.exports as
      { files_removed?: number; jobs_cleared?: number } | undefined;
    check(
      'the service key → 200 with counts',
      asService.status === 200 &&
        typeof photos?.marked === 'number' &&
        typeof photos.objects_removed === 'number' &&
        typeof exportsOut?.files_removed === 'number',
      serviceBody,
    );
    const again = await call('purge-photos', { token: SERVICE, json: {} });
    const againBody = await bodyOf(again);
    check(
      'idempotent: a second run has nothing left to do',
      again.status === 200 && (againBody.photos as { marked?: number } | undefined)?.marked === 0,
      againBody,
    );
  }

  // ---------------------------------------------------------------- otp-hook
  section('otp-hook — fake provider');
  {
    const payload = { user: { id: pemba.userId, phone: '255700000001' }, sms: { otp: '123456' } };
    const ok = await call('otp-hook', { token: SERVICE, json: payload });
    const okBody = await bodyOf(ok);
    check(
      'service key + SMS payload → 200 {}',
      ok.status === 200 && Object.keys(okBody).length === 0,
      okBody,
    );
    const unsigned = await call('otp-hook', { token: pemba.token, json: payload });
    const unsignedBody = await bodyOf(unsigned);
    check(
      'a user token without a hook signature → 401 in the hook error format',
      unsigned.status === 401 &&
        (unsignedBody.error as { http_code?: number } | undefined)?.http_code === 401,
      unsignedBody,
    );
    const empty = await call('otp-hook', { token: SERVICE, json: { user: { id: pemba.userId } } });
    const emptyBody = await bodyOf(empty);
    check(
      'payload without a code → 400',
      empty.status === 400 &&
        (emptyBody.error as { http_code?: number } | undefined)?.http_code === 400,
      emptyBody,
    );
  }
}

main()
  .catch((e: unknown) => {
    failures.push('smoke run aborted');
    console.error(`\nABORTED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    }
  });
