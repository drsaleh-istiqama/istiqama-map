/**
 * End-to-end smoke test of the local gateway, using nothing but global fetch.
 *
 *   node --import tsx scripts/local-stack/gateway/smoke.ts
 *       against the running stack (SUPABASE_URL / keys from .env.local)
 *
 *   node --import tsx scripts/local-stack/gateway/smoke.ts --spawn --db imap_gateway
 *       starts a private PostgREST (:54333) and gateway (:54331) against the given database,
 *       runs the flow (including a gateway restart in the middle of a TUS upload) and stops them.
 *
 * Flow: admin create user → otp → /dev/otp → verify → PostgREST call → refresh (rotation and
 * reuse detection) → MFA TOTP enrol/challenge/verify (aal2) → storage upload, list, signed URL,
 * range download → TUS upload in two chunks → Edge Function → logout.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadDotenv } from './config.ts';
import { PrivateStack, SMOKE_DIR, cli, databaseNameFromEnv } from './private-stack.ts';
import { base32Decode, totp } from './totp.ts';

loadDotenv();

const { flag, opt } = cli(process.argv.slice(2));
const SPAWN = flag('spawn');
const PG_PORT = Number(process.env.PG_PORT ?? 54322);
const DB_NAME = opt('db', databaseNameFromEnv());
const GATEWAY_PORT = Number(opt('port', SPAWN ? '54331' : (process.env.GATEWAY_PORT ?? '54321')));
const POSTGREST_PORT = Number(opt('postgrest-port', '54333'));
const BASE = SPAWN
  ? `http://127.0.0.1:${GATEWAY_PORT}`
  : (process.env.SUPABASE_URL ?? `http://127.0.0.1:${GATEWAY_PORT}`);
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
const stack = SPAWN
  ? new PrivateStack({
      dbName: DB_NAME,
      pgPort: PG_PORT,
      gatewayPort: GATEWAY_PORT,
      postgrestPort: POSTGREST_PORT,
      gatewayEnv: { OTP_TEST_CODES: '255799000111=654321' },
    })
  : null;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(
      `  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`,
    );
  }
}

/** Loosely typed JSON: this script pokes at arbitrary response bodies. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Reply {
  status: number;
  headers: Headers;
  json: Json;
  text: string;
  bytes: Buffer;
}

async function call(
  method: string,
  url: string,
  init: { headers?: Record<string, string>; body?: unknown; raw?: Buffer | string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: BodyInit | undefined;
  if (init.raw !== undefined) body = init.raw as BodyInit;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await fetch(url.startsWith('http') ? url : BASE + url, { method, headers, body });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, json, text, bytes };
}

const anon = (token?: string): Record<string, string> => ({
  apikey: ANON,
  authorization: `Bearer ${token ?? ANON}`,
});
const service = (): Record<string, string> => ({
  apikey: SERVICE,
  authorization: `Bearer ${SERVICE}`,
});
const jwtPayload = (token: string): Json =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (!ANON || !SERVICE)
    throw new Error('SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing (.env.local)');
  if (stack) await stack.start();
  console.log(`smoke test against ${BASE} (database ${DB_NAME})`);

  const email = `smoke-${crypto.randomBytes(4).toString('hex')}@example.org`;
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();

  // -- gateway basics --------------------------------------------------------
  console.log('gateway');
  const health = await call('GET', '/dev/health');
  check(
    'GET /dev/health is ok',
    health.status === 200 && health.json?.status === 'ok',
    health.json,
  );
  const noKey = await call('GET', '/rest/v1/countries?select=iso2&limit=1');
  check('/rest/v1 without apikey → 401', noKey.status === 401, noKey.text);
  const preflight = await call('OPTIONS', '/rest/v1/rpc/sync_pull', {
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, apikey, x-device-id, content-type',
    },
  });
  check(
    'CORS preflight allows x-device-id',
    preflight.status === 204 &&
      (preflight.headers.get('access-control-allow-headers') ?? '').includes('x-device-id'),
    preflight.headers.get('access-control-allow-headers'),
  );

  // -- admin API ---------------------------------------------------------------
  console.log('auth: admin API');
  const denied = await call('POST', '/auth/v1/admin/users', { headers: anon(), body: { email } });
  check(
    'admin API with the anon key → 403 not_admin',
    denied.status === 403 && denied.json?.error_code === 'not_admin',
    denied.json,
  );
  const created = await call('POST', '/auth/v1/admin/users', {
    headers: service(),
    body: { email, email_confirm: true, user_metadata: { full_name: 'Smoke Test' } },
  });
  check('admin create user', created.status === 200 && created.json?.email === email, created.json);
  const userId: string = created.json?.id;
  await db.query(
    `insert into public.profiles (id, full_name, preferred_language, active) values ($1, 'Smoke Test', 'ar', true) on conflict (id) do nothing`,
    [userId],
  );
  const listed = await call('GET', '/auth/v1/admin/users?page=1&per_page=5', {
    headers: service(),
  });
  check(
    'admin list users',
    listed.status === 200 &&
      Array.isArray(listed.json?.users) &&
      listed.headers.get('x-total-count') !== null,
    listed.status,
  );

  // -- OTP sign-in ---------------------------------------------------------------
  console.log('auth: OTP');
  const unknown = await call('POST', '/auth/v1/otp', {
    headers: anon(),
    body: { email: `nobody-${Date.now()}@example.org`, create_user: false },
  });
  check(
    'otp for an unknown user with create_user=false → 422 otp_disabled',
    unknown.status === 422 && unknown.json?.error_code === 'otp_disabled',
    unknown.json,
  );
  const otp = await call('POST', '/auth/v1/otp', {
    headers: anon(),
    body: { email, create_user: false },
  });
  check('POST /auth/v1/otp', otp.status === 200, otp.json);
  const dev = await call('GET', `/dev/otp?identifier=${encodeURIComponent(email)}`);
  check(
    'GET /dev/otp returns the code',
    dev.status === 200 && /^\d{6}$/.test(dev.json?.code ?? ''),
    dev.json,
  );
  const wrong = await call('POST', '/auth/v1/verify', {
    headers: { ...anon(), 'x-supabase-api-version': '2024-01-01' },
    body: { type: 'email', email, token: dev.json?.code === '000000' ? '111111' : '000000' },
  });
  check(
    'verify with a wrong code → 403 otp_expired (2024-01-01 error format)',
    wrong.status === 403 && wrong.json?.code === 'otp_expired',
    wrong.json,
  );
  const verified = await call('POST', '/auth/v1/verify', {
    headers: anon(),
    body: { type: 'email', email, token: dev.json?.code },
  });
  check(
    'POST /auth/v1/verify returns a session',
    verified.status === 200 && !!verified.json?.access_token && !!verified.json?.refresh_token,
    verified.json,
  );
  let session = verified.json;
  const claims = jwtPayload(session.access_token);
  check(
    'JWT claims (sub, role, aal1, amr otp, session_id, email)',
    claims.sub === userId &&
      claims.role === 'authenticated' &&
      claims.aud === 'authenticated' &&
      claims.aal === 'aal1' &&
      claims.amr?.[0]?.method === 'otp' &&
      typeof claims.session_id === 'string' &&
      claims.email === email &&
      claims.is_anonymous === false,
    claims,
  );
  check(
    'session payload shape',
    session.token_type === 'bearer' &&
      session.expires_in > 0 &&
      session.expires_at > 0 &&
      session.user?.id === userId,
    Object.keys(session),
  );
  const replay = await call('POST', '/auth/v1/verify', {
    headers: anon(),
    body: { type: 'email', email, token: dev.json?.code },
  });
  check('an OTP cannot be used twice', replay.status === 403, replay.json);

  const me = await call('GET', '/auth/v1/user', { headers: anon(session.access_token) });
  check(
    'GET /auth/v1/user',
    me.status === 200 &&
      me.json?.id === userId &&
      me.json?.user_metadata?.full_name === 'Smoke Test',
    me.json,
  );
  const put = await call('PUT', '/auth/v1/user', {
    headers: anon(session.access_token),
    body: { data: { locale: 'sw' } },
  });
  check(
    'PUT /auth/v1/user merges metadata',
    put.status === 200 &&
      put.json?.user_metadata?.locale === 'sw' &&
      put.json?.user_metadata?.full_name === 'Smoke Test',
    put.json,
  );

  // -- PostgREST through the gateway -------------------------------------------
  console.log('rest');
  const rest = await call('GET', '/rest/v1/countries?select=iso2&limit=3', {
    headers: anon(session.access_token),
  });
  check(
    'PostgREST call with the user token',
    rest.status === 200 && Array.isArray(rest.json),
    rest.text.slice(0, 200),
  );
  const rpc = await call('POST', '/rest/v1/rpc/my_context', {
    headers: { ...anon(session.access_token), 'x-device-id': 'smoke-device' },
    body: {},
  });
  check('RPC my_context through the proxy', rpc.status === 200, rpc.text.slice(0, 200));
  const keyOnly = await call('GET', '/rest/v1/countries?select=iso2&limit=1', {
    headers: { apikey: ANON },
  });
  check(
    'apikey alone is used as the bearer token',
    keyOnly.status === 200 || keyOnly.status === 401 || keyOnly.status === 403,
    keyOnly.status,
  );

  // -- refresh-token rotation ------------------------------------------------------
  console.log('auth: refresh');
  const firstRefresh: string = session.refresh_token;
  const refreshed = await call('POST', '/auth/v1/token?grant_type=refresh_token', {
    headers: anon(),
    body: { refresh_token: firstRefresh },
  });
  check(
    'refresh rotates the token',
    refreshed.status === 200 && refreshed.json?.refresh_token !== firstRefresh,
    refreshed.json,
  );
  check(
    'refresh keeps the session id',
    jwtPayload(refreshed.json.access_token).session_id === claims.session_id,
  );
  const again = await call('POST', '/auth/v1/token?grant_type=refresh_token', {
    headers: anon(),
    body: { refresh_token: firstRefresh },
  });
  check(
    're-sending the previous token returns the active one (lost response)',
    again.status === 200 && again.json?.refresh_token === refreshed.json?.refresh_token,
    again.json,
  );
  session = refreshed.json;
  const bogus = await call('POST', '/auth/v1/token?grant_type=refresh_token', {
    headers: anon(),
    body: { refresh_token: 'doesnotexist' },
  });
  check(
    'unknown refresh token → 400 refresh_token_not_found',
    bogus.status === 400 && bogus.json?.error_code === 'refresh_token_not_found',
    bogus.json,
  );

  if (SPAWN) {
    // Reuse outside the reuse interval (1 s in --spawn mode) kills the whole session family.
    const otp2 = await call('POST', '/auth/v1/otp', { headers: anon(), body: { email } });
    const code2 = (await call('GET', `/dev/otp?identifier=${encodeURIComponent(email)}`)).json
      ?.code;
    const s2 = (
      await call('POST', '/auth/v1/verify', {
        headers: anon(),
        body: { type: 'email', email, token: code2 },
      })
    ).json;
    const r1 = (
      await call('POST', '/auth/v1/token?grant_type=refresh_token', {
        headers: anon(),
        body: { refresh_token: s2.refresh_token },
      })
    ).json;
    const r2 = (
      await call('POST', '/auth/v1/token?grant_type=refresh_token', {
        headers: anon(),
        body: { refresh_token: r1.refresh_token },
      })
    ).json;
    await sleep(1500);
    const reuse = await call('POST', '/auth/v1/token?grant_type=refresh_token', {
      headers: anon(),
      body: { refresh_token: s2.refresh_token },
    });
    check('second sign-in works', otp2.status === 200 && !!r2?.refresh_token);
    check(
      'reuse of an old token → 400 refresh_token_already_used',
      reuse.status === 400 && reuse.json?.error_code === 'refresh_token_already_used',
      reuse.json,
    );
    const dead = await call('POST', '/auth/v1/token?grant_type=refresh_token', {
      headers: anon(),
      body: { refresh_token: r2.refresh_token },
    });
    check('…and the newest token of that session is revoked too', dead.status === 400, dead.json);
    const alive = await call('GET', '/auth/v1/user', { headers: anon(session.access_token) });
    check('other sessions of the user are unaffected', alive.status === 200, alive.status);
  }

  // -- MFA (TOTP) ------------------------------------------------------------------
  console.log('auth: MFA');
  const enroll = await call('POST', '/auth/v1/factors', {
    headers: anon(session.access_token),
    body: { factor_type: 'totp', friendly_name: 'smoke' },
  });
  check(
    'enroll returns id, secret, uri and an SVG QR code',
    enroll.status === 200 &&
      enroll.json?.type === 'totp' &&
      /^otpauth:\/\/totp\//.test(enroll.json?.totp?.uri ?? '') &&
      String(enroll.json?.totp?.qr_code ?? '').startsWith('<svg') &&
      !String(enroll.json?.totp?.qr_code).includes('#'),
    enroll.json?.totp?.uri,
  );
  const factorId: string = enroll.json?.id;
  const challenge = await call('POST', `/auth/v1/factors/${factorId}/challenge`, {
    headers: anon(session.access_token),
    body: {},
  });
  check(
    'challenge',
    challenge.status === 200 &&
      !!challenge.json?.id &&
      challenge.json?.expires_at > Date.now() / 1000,
    challenge.json,
  );
  const badCode = await call('POST', `/auth/v1/factors/${factorId}/verify`, {
    headers: anon(session.access_token),
    body: { challenge_id: challenge.json?.id, code: '000000' },
  });
  check(
    'wrong TOTP code → 422 mfa_verification_failed',
    badCode.status === 422 && badCode.json?.error_code === 'mfa_verification_failed',
    badCode.json,
  );
  const code = totp(base32Decode(enroll.json?.totp?.secret ?? ''), Date.now() / 1000);
  const mfa = await call('POST', `/auth/v1/factors/${factorId}/verify`, {
    headers: anon(session.access_token),
    body: { challenge_id: challenge.json?.id, code },
  });
  check(
    'MFA verify returns a new session',
    mfa.status === 200 &&
      !!mfa.json?.access_token &&
      mfa.json?.refresh_token !== session.refresh_token,
    mfa.json,
  );
  const mfaClaims = jwtPayload(mfa.json.access_token);
  check(
    'new JWT is aal2 with amr totp + otp',
    mfaClaims.aal === 'aal2' &&
      mfaClaims.amr?.some((a: { method: string }) => a.method === 'totp') &&
      mfaClaims.amr?.some((a: { method: string }) => a.method === 'otp') &&
      mfaClaims.session_id === claims.session_id,
    mfaClaims,
  );
  const aalRow = await db.query(`select aal::text from auth.sessions where id = $1`, [
    claims.session_id,
  ]);
  check('auth.sessions.aal is aal2', aalRow.rows[0]?.aal === 'aal2', aalRow.rows);
  session = mfa.json;
  const me2 = await call('GET', '/auth/v1/user', { headers: anon(session.access_token) });
  check(
    'user.factors lists the verified factor',
    me2.json?.factors?.[0]?.id === factorId && me2.json?.factors?.[0]?.status === 'verified',
    me2.json?.factors,
  );

  // -- storage -------------------------------------------------------------------------
  console.log('storage');
  const token = session.access_token as string;
  const csv = Buffer.from('id,name\n1,اختبار\n', 'utf8');
  const objectName = `${userId}/smoke-${Date.now()}.csv`;
  const up = await call('POST', `/storage/v1/object/imports/${objectName}`, {
    headers: { ...anon(token), 'content-type': 'text/csv', 'cache-control': 'max-age=60' },
    raw: csv,
  });
  check(
    'upload (raw body) into own folder',
    up.status === 200 && up.json?.Key === `imports/${objectName}` && !!up.json?.Id,
    up.json,
  );
  const dup = await call('POST', `/storage/v1/object/imports/${objectName}`, {
    headers: { ...anon(token), 'content-type': 'text/csv' },
    raw: csv,
  });
  check(
    'second upload without x-upsert → Duplicate',
    dup.status === 400 && dup.json?.statusCode === '409' && dup.json?.error === 'Duplicate',
    dup.json,
  );
  const form = new FormData();
  form.append('cacheControl', '3600');
  form.append('', new Blob([csv], { type: 'text/csv' }), 'x.csv');
  const mp = await fetch(`${BASE}/storage/v1/object/imports/${userId}/multipart.csv`, {
    method: 'POST',
    headers: { ...anon(token), 'x-upsert': 'true' },
    body: form,
  });
  check(
    'upload (multipart/form-data, as storage-js sends a Blob)',
    mp.status === 200,
    await mp.text(),
  );
  const foreign = await call('POST', `/storage/v1/object/imports/${crypto.randomUUID()}/x.csv`, {
    headers: { ...anon(token), 'content-type': 'text/csv' },
    raw: csv,
  });
  check(
    "upload into another user's folder → RLS denial",
    foreign.status === 400 && foreign.json?.statusCode === '403',
    foreign.json,
  );
  const traversal = await call('POST', `/storage/v1/object/imports/${userId}/..%2F..%2Fevil.csv`, {
    headers: { ...anon(token), 'content-type': 'text/csv' },
    raw: csv,
  });
  check(
    'path traversal is rejected',
    traversal.status === 400 && traversal.json?.error === 'InvalidKey',
    traversal.json,
  );
  const down = await call('GET', `/storage/v1/object/authenticated/imports/${objectName}`, {
    headers: anon(token),
  });
  check(
    'authenticated download',
    down.status === 200 &&
      down.bytes.equals(csv) &&
      down.headers.get('content-type') === 'text/csv' &&
      !!down.headers.get('etag'),
    down.status,
  );
  const down2 = await call('GET', `/storage/v1/object/imports/${objectName}`, {
    headers: anon(token),
  });
  check(
    'download through /object/<bucket>/<name> (storage-js path)',
    down2.status === 200 && down2.bytes.equals(csv),
    down2.status,
  );
  const anonDown = await call('GET', `/storage/v1/object/authenticated/imports/${objectName}`, {
    headers: anon(),
  });
  check(
    'anon cannot download',
    anonDown.status === 400 && anonDown.json?.statusCode === '404',
    anonDown.json,
  );
  const list = await call('POST', '/storage/v1/object/list/imports', {
    headers: anon(token),
    body: { prefix: userId, limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } },
  });
  check(
    'list own folder',
    list.status === 200 &&
      Array.isArray(list.json) &&
      list.json.length === 2 &&
      list.json.every((o: { id: string }) => !!o.id),
    list.json,
  );
  const rootList = await call('POST', '/storage/v1/object/list/imports', {
    headers: anon(token),
    body: { prefix: '' },
  });
  check(
    'list bucket root shows only the own folder',
    rootList.status === 200 &&
      rootList.json?.length === 1 &&
      rootList.json[0].name === userId &&
      rootList.json[0].id === null,
    rootList.json,
  );

  const sign = await call('POST', `/storage/v1/object/sign/imports/${objectName}`, {
    headers: anon(token),
    body: { expiresIn: 60 },
  });
  check(
    'create signed URL',
    sign.status === 200 &&
      String(sign.json?.signedURL ?? '').startsWith(`/object/sign/imports/${objectName}?token=`),
    sign.json,
  );
  const signedUrl = `/storage/v1${sign.json?.signedURL}`;
  const signed = await call('GET', signedUrl);
  check(
    'signed URL download without credentials',
    signed.status === 200 && signed.bytes.equals(csv),
    signed.status,
  );
  const ranged = await call('GET', signedUrl, { headers: { range: 'bytes=3-9' } });
  check(
    'Range request → 206 with Content-Range',
    ranged.status === 206 &&
      ranged.bytes.equals(csv.subarray(3, 10)) &&
      ranged.headers.get('content-range') === `bytes 3-9/${csv.length}`,
    ranged.headers.get('content-range'),
  );
  const notModified = await call('GET', signedUrl, {
    headers: { 'if-none-match': signed.headers.get('etag') ?? '' },
  });
  check('If-None-Match → 304', notModified.status === 304, notModified.status);
  const tampered = await call('GET', signedUrl.replace(objectName, `${userId}/multipart.csv`));
  check('signed token is bound to its object', tampered.status === 400, tampered.json);

  // -- TUS -----------------------------------------------------------------------------
  console.log('storage: TUS');
  const payload = crypto.randomBytes(300 * 1024);
  const tusName = `${userId}/tus-${Date.now()}.bin`;
  const b64 = (s: string): string => Buffer.from(s).toString('base64');
  const tusHeaders = { ...anon(token), 'tus-resumable': '1.0.0' };
  const options = await call('OPTIONS', '/storage/v1/upload/resumable');
  check(
    'TUS OPTIONS advertises 1.0.0 + creation',
    options.status === 204 &&
      options.headers.get('tus-version') === '1.0.0' &&
      (options.headers.get('tus-extension') ?? '').includes('creation'),
  );
  const create = await call('POST', '/storage/v1/upload/resumable', {
    headers: {
      ...tusHeaders,
      'upload-length': String(payload.length),
      'upload-metadata': `bucketName ${b64('imports')},objectName ${b64(tusName)},contentType ${b64('application/octet-stream')},cacheControl ${b64('3600')}`,
    },
  });
  const location = create.headers.get('location') ?? '';
  check(
    'TUS creation → 201 + Location',
    create.status === 201 && location.includes('/storage/v1/upload/resumable/'),
    `${create.status} ${create.text}`,
  );
  const half = 200 * 1024;
  const p1 = await call('PATCH', location, {
    headers: {
      ...tusHeaders,
      'content-type': 'application/offset+octet-stream',
      'upload-offset': '0',
    },
    raw: payload.subarray(0, half),
  });
  check(
    'TUS first chunk → 204, offset advanced',
    p1.status === 204 && p1.headers.get('upload-offset') === String(half),
    `${p1.status} ${p1.text}`,
  );
  const conflict = await call('PATCH', location, {
    headers: {
      ...tusHeaders,
      'content-type': 'application/offset+octet-stream',
      'upload-offset': '0',
    },
    raw: payload.subarray(0, 10),
  });
  check('TUS wrong offset → 409', conflict.status === 409, conflict.status);
  if (stack) {
    await stack.restartGateway();
    check('gateway restarted in the middle of the upload', true);
  }
  const head = await call('HEAD', location, { headers: tusHeaders });
  check(
    'TUS HEAD reports the offset' + (SPAWN ? ' after the restart' : ''),
    head.status === 200 &&
      head.headers.get('upload-offset') === String(half) &&
      head.headers.get('upload-length') === String(payload.length),
    head.status,
  );
  const p2 = await call('PATCH', location, {
    headers: {
      ...tusHeaders,
      'content-type': 'application/offset+octet-stream',
      'upload-offset': String(half),
    },
    raw: payload.subarray(half),
  });
  check(
    'TUS second chunk completes the upload',
    p2.status === 204 && p2.headers.get('upload-offset') === String(payload.length),
    `${p2.status} ${p2.text}`,
  );
  const headDone = await call('HEAD', location, { headers: tusHeaders });
  check(
    'TUS HEAD after completion still answers (offset = length)',
    headDone.status === 200 && headDone.headers.get('upload-offset') === String(payload.length),
    headDone.status,
  );
  const tusDown = await call('GET', `/storage/v1/object/authenticated/imports/${tusName}`, {
    headers: anon(token),
  });
  check(
    'TUS object downloads intact',
    tusDown.status === 200 && tusDown.bytes.equals(payload),
    tusDown.status,
  );
  const objRow = await db.query(
    `select owner::text, metadata->>'size' as size, metadata->>'cacheControl' as cc from storage.objects where bucket_id = 'imports' and name = $1`,
    [tusName],
  );
  check(
    'storage.objects row has owner, size and cacheControl',
    objRow.rows[0]?.owner === userId &&
      objRow.rows[0]?.size === String(payload.length) &&
      objRow.rows[0]?.cc === 'max-age=3600',
    objRow.rows,
  );
  const tusDenied = await call('POST', '/storage/v1/upload/resumable', {
    headers: {
      ...tusHeaders,
      'upload-length': '10',
      'upload-metadata': `bucketName ${b64('imports')},objectName ${b64(`${crypto.randomUUID()}/x.bin`)}`,
    },
  });
  check(
    'TUS creation outside the own folder → 403',
    tusDenied.status === 403,
    `${tusDenied.status} ${tusDenied.text}`,
  );

  // service role: delete (users have no delete policy)
  const userDelete = await call('DELETE', '/storage/v1/object/imports', {
    headers: anon(token),
    body: { prefixes: [objectName] },
  });
  check(
    'user delete without a delete policy removes nothing',
    userDelete.status === 200 && Array.isArray(userDelete.json) && userDelete.json.length === 0,
    userDelete.json,
  );
  const svcDelete = await call('DELETE', '/storage/v1/object/imports', {
    headers: service(),
    body: { prefixes: [objectName, tusName, `${userId}/multipart.csv`] },
  });
  check(
    'service role deletes the objects',
    svcDelete.status === 200 && svcDelete.json?.length === 3,
    svcDelete.json,
  );
  const gone = await call('GET', signedUrl);
  check(
    'deleted object is gone',
    gone.status === 400 && gone.json?.statusCode === '404',
    gone.json,
  );

  // -- functions -------------------------------------------------------------------------
  console.log('functions');
  const missing = await call('POST', '/functions/v1/does-not-exist', {
    headers: anon(token),
    body: {},
  });
  check(
    'unknown function → 404 JSON',
    missing.status === 404 && missing.json?.code === 'NOT_FOUND',
    missing.json,
  );
  if (SPAWN) {
    const noJwt = await call('POST', '/functions/v1/hello', { body: { name: 'x' } });
    check('function without a JWT → 401', noJwt.status === 401, noJwt.json);
    const hello = await call('POST', '/functions/v1/hello/sub/path?x=1', {
      headers: anon(token),
      body: { name: 'pemba' },
    });
    check(
      'function handler runs (Deno shim, _shared import, path)',
      hello.status === 200 &&
        hello.json?.message === 'hello pemba' &&
        hello.json?.path === '/hello/sub/path' &&
        hello.json?.anon === true,
      hello.json,
    );
    await sleep(600);
    fs.writeFileSync(
      path.join(SMOKE_DIR, 'functions', '_shared', 'greet.ts'),
      `export const greet = (name: string): string => 'habari ' + name;\n`,
    );
    await sleep(600);
    const reloaded = await call('POST', '/functions/v1/hello', {
      headers: anon(token),
      body: { name: 'pemba' },
    });
    check(
      'editing a shared file reloads the function',
      reloaded.json?.message === 'habari pemba',
      reloaded.json,
    );
    const denoStyle = await call('PUT', '/functions/v1/deno-style', {
      headers: anon(token),
      raw: 'raw-body',
    });
    check(
      'Deno.serve-only function with an npm: specifier (status, headers and body are bridged)',
      denoStyle.status === 201 &&
        denoStyle.json?.decode === 'function' &&
        denoStyle.json?.method === 'PUT' &&
        denoStyle.json?.body === 'raw-body' &&
        denoStyle.headers.get('x-custom') === 'yes',
      denoStyle.text,
    );
    const boom = await call('GET', '/functions/v1/deno-style?fail=1', { headers: anon(token) });
    check(
      'an exception in a function → 500 WORKER_ERROR',
      boom.status === 500 && boom.json?.code === 'WORKER_ERROR',
      boom.text,
    );
  }

  // -- public bucket (PMTiles are read with range requests, without credentials) ----------
  console.log('storage: public bucket');
  const tile = crypto.randomBytes(4096);
  const tileName = `smoke/range-${Date.now()}.pmtiles`;
  const userTile = await call('POST', `/storage/v1/object/tiles/${tileName}`, {
    headers: { ...anon(token), 'content-type': 'application/octet-stream' },
    raw: tile,
  });
  check(
    'a normal user cannot publish into tiles',
    userTile.status === 400 && userTile.json?.statusCode === '403',
    userTile.json,
  );
  const svcTile = await call('POST', `/storage/v1/object/tiles/${tileName}`, {
    headers: {
      ...service(),
      'content-type': 'application/octet-stream',
      'cache-control': 'max-age=3600',
    },
    raw: tile,
  });
  check('service role uploads into tiles', svcTile.status === 200, svcTile.json);
  const pubRange = await call('GET', `/storage/v1/object/public/tiles/${tileName}`, {
    headers: { range: 'bytes=16-143', origin: 'http://localhost:5173' },
  });
  check(
    'public range request without credentials → 206, CORS exposes Content-Range',
    pubRange.status === 206 &&
      pubRange.bytes.equals(tile.subarray(16, 144)) &&
      pubRange.headers.get('accept-ranges') === 'bytes' &&
      pubRange.headers.get('access-control-allow-origin') === '*' &&
      (pubRange.headers.get('access-control-expose-headers') ?? '').includes('content-range') &&
      pubRange.headers.get('cache-control') === 'max-age=3600',
    `${pubRange.status} ${pubRange.headers.get('content-range')}`,
  );
  const pubSuffix = await call('GET', `/storage/v1/object/public/tiles/${tileName}`, {
    headers: { range: 'bytes=-10' },
  });
  check(
    'suffix range',
    pubSuffix.status === 206 && pubSuffix.bytes.equals(tile.subarray(4086)),
    pubSuffix.status,
  );
  const pubBeyond = await call('GET', `/storage/v1/object/public/tiles/${tileName}`, {
    headers: { range: 'bytes=5000-' },
  });
  check(
    'range beyond the end → 416',
    pubBeyond.status === 416 && pubBeyond.headers.get('content-range') === 'bytes */4096',
    pubBeyond.status,
  );
  const privateAsPublic = await call('GET', `/storage/v1/object/public/imports/${userId}/x.csv`);
  check(
    'a private bucket is not served by the public route',
    privateAsPublic.status === 400 && privateAsPublic.json?.error === 'Bucket not found',
    privateAsPublic.json,
  );
  await call('DELETE', `/storage/v1/object/tiles/${tileName}`, { headers: service() });

  // -- phone OTP and password grant -------------------------------------------------------
  console.log('auth: phone OTP, password');
  const phone = `2557${String(crypto.randomInt(10_000_000, 99_999_999))}`;
  const phoneUser = await call('POST', '/auth/v1/admin/users', {
    headers: service(),
    body: { phone: `+${phone}`, phone_confirm: true, password: 'correct horse battery' },
  });
  check(
    'admin create phone user (stored without "+")',
    phoneUser.status === 200 && phoneUser.json?.phone === phone,
    phoneUser.json,
  );
  const sms = await call('POST', '/auth/v1/otp', {
    headers: anon(),
    body: { phone: `+${phone}`, create_user: false },
  });
  check('phone otp', sms.status === 200 && 'message_id' in (sms.json ?? {}), sms.json);
  const smsCode = (await call('GET', `/dev/otp?identifier=${encodeURIComponent(`+${phone}`)}`)).json
    ?.code;
  const smsVerify = await call('POST', '/auth/v1/verify', {
    headers: anon(),
    body: { type: 'sms', phone: `+${phone}`, token: smsCode },
  });
  check(
    'verify type sms',
    smsVerify.status === 200 && jwtPayload(smsVerify.json.access_token).phone === phone,
    smsVerify.json,
  );
  const pwOk = await call('POST', '/auth/v1/token?grant_type=password', {
    headers: anon(),
    body: { phone: `+${phone}`, password: 'correct horse battery' },
  });
  check(
    'password grant',
    pwOk.status === 200 && jwtPayload(pwOk.json.access_token).amr?.[0]?.method === 'password',
    pwOk.json,
  );
  const pwBad = await call('POST', '/auth/v1/token?grant_type=password', {
    headers: anon(),
    body: { phone: `+${phone}`, password: 'wrong' },
  });
  check(
    'wrong password → 400 invalid_credentials',
    pwBad.status === 400 && pwBad.json?.error_code === 'invalid_credentials',
    pwBad.json,
  );
  if (stack) {
    // fixed code for a test number (as [auth.sms.test_otp] in supabase/config.toml)
    const testPhone = '255799000111';
    await call('POST', '/auth/v1/admin/users', {
      headers: service(),
      body: { phone: testPhone, phone_confirm: true },
    });
    await call('POST', '/auth/v1/otp', {
      headers: anon(),
      body: { phone: testPhone, create_user: false },
    });
    const fixed = await call('POST', '/auth/v1/verify', {
      headers: anon(),
      body: { type: 'sms', phone: testPhone, token: '654321' },
    });
    check('test OTP number accepts its fixed code', fixed.status === 200, fixed.json);
    const testUser = fixed.json?.user?.id;
    if (testUser)
      await call('DELETE', `/auth/v1/admin/users/${testUser}`, { headers: service(), body: {} });
    const pre = await call('OPTIONS', '/functions/v1/hello', {
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    check(
      'function preflight is answered by the function itself',
      pre.status === 200 &&
        pre.text === 'ok' &&
        pre.headers.get('access-control-allow-origin') === '*',
      `${pre.status} ${pre.text}`,
    );
  }
  const forced = await call('POST', `/auth/v1/admin/users/${phoneUser.json?.id}/logout`, {
    headers: service(),
  });
  const forcedRefresh = await call('POST', '/auth/v1/token?grant_type=refresh_token', {
    headers: anon(),
    body: { refresh_token: pwOk.json?.refresh_token },
  });
  check(
    'admin logout by user id (local extension) kills the refresh tokens',
    forced.status === 204 && forcedRefresh.status === 400,
    `${forced.status}/${forcedRefresh.status}`,
  );
  await call('DELETE', `/auth/v1/admin/users/${phoneUser.json?.id}`, {
    headers: service(),
    body: {},
  });

  // -- logout -----------------------------------------------------------------------------
  console.log('auth: logout');
  const unenrollOther = await call('DELETE', `/auth/v1/factors/${factorId}`, {
    headers: anon(session.access_token),
  });
  check(
    'unenroll at aal2',
    unenrollOther.status === 200 && unenrollOther.json?.id === factorId,
    unenrollOther.json,
  );
  const logout = await call('POST', '/auth/v1/logout?scope=global', {
    headers: anon(session.access_token),
  });
  check('logout → 204', logout.status === 204, logout.status);
  const afterRefresh = await call('POST', '/auth/v1/token?grant_type=refresh_token', {
    headers: anon(),
    body: { refresh_token: session.refresh_token },
  });
  check('refresh after logout fails', afterRefresh.status === 400, afterRefresh.json);
  const afterUser = await call('GET', '/auth/v1/user', { headers: anon(session.access_token) });
  check(
    'GET /user after logout → 403 session_not_found',
    afterUser.status === 403 && afterUser.json?.error_code === 'session_not_found',
    afterUser.json,
  );

  // -- cleanup ----------------------------------------------------------------------------
  await db.query('delete from public.profiles where id = $1', [userId]).catch(() => undefined);
  const del = await call('DELETE', `/auth/v1/admin/users/${userId}`, {
    headers: service(),
    body: { should_soft_delete: false },
  });
  check('admin delete user', del.status === 200 || del.status === 500, del.json);
  await db.end();
}

main()
  .catch((e: unknown) => {
    failures.push(`crashed: ${e instanceof Error ? e.message : String(e)}`);
    console.error(e);
  })
  .finally(() => {
    stack?.stop();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
    process.exit(0);
  });
