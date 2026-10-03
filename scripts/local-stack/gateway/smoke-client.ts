/**
 * Wire-fidelity check with the REAL clients: @supabase/supabase-js (auth-js, postgrest-js,
 * storage-js, functions-js) and tus-js-client, unmodified, against the local gateway.
 * If this passes, the web app needs no gateway-specific code.
 *
 *   node --import tsx scripts/local-stack/gateway/smoke-client.ts                      (running stack)
 *   node --import tsx scripts/local-stack/gateway/smoke-client.ts --spawn --db imap_x  (private stack)
 */
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import * as tus from 'tus-js-client';
import { loadDotenv } from './config.ts';
import { PrivateStack, cli, databaseNameFromEnv } from './private-stack.ts';
import { base32Decode, totp } from './totp.ts';

loadDotenv();

const { flag, opt } = cli(process.argv.slice(2));
const SPAWN = flag('spawn');
const PG_PORT = Number(process.env.PG_PORT ?? 54322);
const DB_NAME = opt('db', databaseNameFromEnv());
const GATEWAY_PORT = Number(opt('port', SPAWN ? '54331' : (process.env.GATEWAY_PORT ?? '54321')));
const BASE = SPAWN
  ? `http://127.0.0.1:${GATEWAY_PORT}`
  : (process.env.SUPABASE_URL ?? `http://127.0.0.1:${GATEWAY_PORT}`);
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const stack = SPAWN
  ? new PrivateStack({
      dbName: DB_NAME,
      pgPort: PG_PORT,
      gatewayPort: GATEWAY_PORT,
      postgrestPort: Number(opt('postgrest-port', '54333')),
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

function tusUpload(
  data: Buffer,
  token: string,
  bucketName: string,
  objectName: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(data, {
      endpoint: `${BASE}/storage/v1/upload/resumable`,
      retryDelays: [0, 500, 1000],
      headers: { authorization: `Bearer ${token}`, apikey: ANON, 'x-upsert': 'true' },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName,
        objectName,
        contentType: 'application/octet-stream',
        cacheControl: '3600',
      },
      chunkSize: 100 * 1024,
      onError: (e) => reject(e),
      onSuccess: () => resolve(),
    });
    upload.start();
  });
}

async function main(): Promise<void> {
  if (!ANON || !SERVICE)
    throw new Error('SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing (.env.local)');
  if (stack) await stack.start();
  console.log(`supabase-js smoke test against ${BASE} (database ${DB_NAME})`);

  const noStore = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  };
  const admin = createClient(BASE, SERVICE, noStore);
  const client = createClient(BASE, ANON, {
    ...noStore,
    global: { headers: { 'x-device-id': 'smoke-client' } },
  });
  const db = new pg.Client({
    connectionString: `postgresql://postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`,
  });
  await db.connect();
  const email = `client-${crypto.randomBytes(4).toString('hex')}@example.org`;

  console.log('auth.admin');
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: 'Client Smoke' },
  });
  check('admin.createUser', !created.error && created.data.user?.email === email, created.error);
  const userId = created.data.user!.id;
  await db.query(
    `insert into public.profiles (id, full_name, preferred_language, active) values ($1, 'Client Smoke', 'ar', true) on conflict (id) do nothing`,
    [userId],
  );
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 2 });
  check(
    'admin.listUsers (pagination headers parsed)',
    !list.error &&
      list.data.users.length > 0 &&
      typeof (list.data as { total?: number }).total === 'number',
    list.error ?? list.data,
  );
  const byId = await admin.auth.admin.getUserById(userId);
  check('admin.getUserById', byId.data.user?.id === userId, byId.error);
  const updated = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { note: 'smoke' },
  });
  check(
    'admin.updateUserById merges app_metadata',
    updated.data.user?.app_metadata?.note === 'smoke' &&
      updated.data.user?.app_metadata?.provider === 'email',
    updated.error,
  );
  const notAdmin = await client.auth.admin.listUsers();
  check('admin API refuses the anon key', notAdmin.error?.status === 403, notAdmin.error);

  console.log('auth');
  const unknown = await client.auth.signInWithOtp({ email: `nobody-${Date.now()}@example.org` });
  check(
    'signInWithOtp for an unknown user is refused (sign-ups are disabled)',
    unknown.error?.status === 422 && unknown.error?.code === 'signup_disabled',
    unknown.error,
  );
  const otp = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  check('signInWithOtp', !otp.error, otp.error);
  const dev = (await (
    await fetch(`${BASE}/dev/otp?identifier=${encodeURIComponent(email)}`)
  ).json()) as { code: string };
  const bad = await client.auth.verifyOtp({
    email,
    token: dev.code === '000000' ? '111111' : '000000',
    type: 'email',
  });
  check(
    'verifyOtp with a wrong code → AuthApiError otp_expired',
    bad.error?.status === 403 && bad.error?.code === 'otp_expired',
    bad.error,
  );
  const ok = await client.auth.verifyOtp({ email, token: dev.code, type: 'email' });
  check(
    'verifyOtp → session',
    !ok.error && !!ok.data.session?.access_token && ok.data.user?.id === userId,
    ok.error,
  );
  const user = await client.auth.getUser();
  check('getUser', user.data.user?.email === email, user.error);
  const aal1 = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  check(
    'assurance level before MFA: aal1 → aal1',
    aal1.data?.currentLevel === 'aal1' && aal1.data?.nextLevel === 'aal1',
    aal1.data,
  );
  const before = (await client.auth.getSession()).data.session!;
  const refreshed = await client.auth.refreshSession();
  check(
    'refreshSession rotates the refresh token',
    !refreshed.error &&
      !!refreshed.data.session &&
      refreshed.data.session.refresh_token !== before.refresh_token,
    refreshed.error,
  );
  const meta = await client.auth.updateUser({ data: { locale: 'sw' } });
  check('updateUser({ data })', meta.data.user?.user_metadata?.locale === 'sw', meta.error);

  console.log('rest');
  const countries = await client.from('countries').select('iso2').limit(3);
  check(
    'from("countries").select()',
    !countries.error && Array.isArray(countries.data),
    countries.error,
  );
  const context = await client.rpc('my_context');
  check('rpc("my_context")', !context.error, context.error);
  const hidden = await client.from('staff_compensation').select('*').limit(1);
  check(
    'restricted table is not readable through the API',
    !!hidden.error || (hidden.data ?? []).length === 0,
    hidden.data,
  );

  console.log('auth.mfa');
  const enroll = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'smoke-client' });
  check(
    'mfa.enroll (qr_code becomes a data: URI)',
    !enroll.error && enroll.data?.totp.qr_code.startsWith('data:image/svg+xml;utf-8,<svg') === true,
    enroll.error,
  );
  const factorId = enroll.data!.id;
  const challenge = await client.auth.mfa.challenge({ factorId });
  check('mfa.challenge', !challenge.error && !!challenge.data?.id, challenge.error);
  const wrong = await client.auth.mfa.verify({
    factorId,
    challengeId: challenge.data!.id,
    code: '000000',
  });
  check(
    'mfa.verify with a wrong code',
    wrong.error?.code === 'mfa_verification_failed',
    wrong.error,
  );
  const code = totp(base32Decode(enroll.data!.totp.secret), Date.now() / 1000);
  const verify = await client.auth.mfa.verify({ factorId, challengeId: challenge.data!.id, code });
  check('mfa.verify', !verify.error && !!verify.data?.access_token, verify.error);
  const aal2 = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  check(
    'assurance level after MFA: aal2, amr contains totp',
    aal2.data?.currentLevel === 'aal2' &&
      aal2.data?.currentAuthenticationMethods.some(
        (m) => typeof m === 'object' && m.method === 'totp',
      ) === true,
    aal2.data,
  );
  const factors = await client.auth.mfa.listFactors();
  check(
    'mfa.listFactors',
    factors.data?.totp.length === 1 && factors.data.totp[0]?.status === 'verified',
    factors.error ?? factors.data,
  );
  const adminFactors = await admin.auth.admin.mfa.listFactors({ userId });
  check('admin.mfa.listFactors', adminFactors.data?.factors.length === 1, adminFactors.error);

  console.log('storage');
  const token = (await client.auth.getSession()).data.session!.access_token;
  const text = 'id,name\n1,اختبار\n';
  const name = `${userId}/client-${Date.now()}.csv`;
  const up = await client.storage
    .from('imports')
    .upload(name, new Blob([text], { type: 'text/csv' }), { cacheControl: '3600' });
  check('storage.upload(Blob)', !up.error && up.data?.path === name, up.error);
  const dup = await client.storage
    .from('imports')
    .upload(name, new Blob([text], { type: 'text/csv' }));
  check(
    'second upload → StorageApiError statusCode 409',
    (dup.error as { statusCode?: string } | null)?.statusCode === '409',
    dup.error,
  );
  const upsert = await client.storage
    .from('imports')
    .upload(name, Buffer.from(text), { upsert: true, contentType: 'text/csv' });
  check('storage.upload(Buffer, { upsert: true })', !upsert.error, upsert.error);
  const denied = await client.storage
    .from('imports')
    .upload(`${crypto.randomUUID()}/x.csv`, new Blob([text]));
  check(
    'upload outside the own folder is denied by RLS',
    (denied.error as { statusCode?: string } | null)?.statusCode === '403',
    denied.error,
  );
  const down = await client.storage.from('imports').download(name);
  check('storage.download', !down.error && (await down.data!.text()) === text, down.error);
  const exists = await client.storage.from('imports').exists(name);
  check('storage.exists', exists.data === true, exists.error);
  const missing = await client.storage.from('imports').exists(`${userId}/nope.csv`);
  check('storage.exists (missing object)', missing.data === false, missing.error);
  const infoRes = await client.storage.from('imports').info(name);
  check(
    'storage.info',
    !infoRes.error && infoRes.data?.size === Buffer.byteLength(text),
    infoRes.error ?? infoRes.data,
  );
  const signed = await client.storage.from('imports').createSignedUrl(name, 60);
  const viaSigned = signed.data ? await fetch(signed.data.signedUrl) : null;
  check(
    'storage.createSignedUrl + plain fetch',
    !signed.error && viaSigned?.status === 200 && (await viaSigned.text()) === text,
    signed.error,
  );
  const many = await client.storage
    .from('imports')
    .createSignedUrls([name, `${userId}/nope.csv`], 60);
  check(
    'storage.createSignedUrls (one hit, one miss)',
    many.data?.length === 2 && !many.data[0]?.error && !!many.data[1]?.error,
    many.error ?? many.data,
  );
  const listed = await client.storage
    .from('imports')
    .list(userId, { limit: 10, sortBy: { column: 'name', order: 'asc' } });
  check(
    'storage.list',
    !listed.error && listed.data?.length === 1 && listed.data[0]?.name === name.split('/')[1],
    listed.error ?? listed.data,
  );
  const buckets = await client.storage.listBuckets();
  check(
    'storage.listBuckets is empty for users (no policy on storage.buckets)',
    !buckets.error && buckets.data?.length === 0,
    buckets.error ?? buckets.data,
  );
  const adminBuckets = await admin.storage.listBuckets();
  check(
    'storage.listBuckets with the service key',
    (adminBuckets.data ?? []).some((b) => b.id === 'photos'),
    adminBuckets.error,
  );
  const publicUrl = client.storage.from('tiles').getPublicUrl('packs/test.pmtiles').data.publicUrl;
  check(
    'getPublicUrl points at /storage/v1/object/public',
    publicUrl === `${BASE}/storage/v1/object/public/tiles/packs/test.pmtiles`,
    publicUrl,
  );

  console.log('storage: tus-js-client');
  const payload = crypto.randomBytes(250 * 1024);
  const tusName = `${userId}/tus-client-${Date.now()}.bin`;
  let tusError: unknown = null;
  await tusUpload(payload, token, 'imports', tusName).catch((e: unknown) => {
    tusError = e;
  });
  check(
    'tus-js-client upload (3 chunks of 100 kB, creation-with-upload)',
    tusError === null,
    String(tusError),
  );
  const tusDown = await client.storage.from('imports').download(tusName);
  check(
    'TUS object downloads intact',
    !tusDown.error && Buffer.from(await tusDown.data!.arrayBuffer()).equals(payload),
    tusDown.error,
  );
  let foreignError: unknown = null;
  await tusUpload(payload.subarray(0, 10), token, 'imports', `${crypto.randomUUID()}/x.bin`).catch(
    (e: unknown) => {
      foreignError = e;
    },
  );
  check(
    'tus-js-client upload outside the own folder fails with 403',
    String(foreignError).includes('403'),
    String(foreignError),
  );
  const removed = await admin.storage.from('imports').remove([name, tusName]);
  check(
    'storage.remove with the service key',
    !removed.error && removed.data?.length === 2,
    removed.error ?? removed.data,
  );

  console.log('functions');
  const nope = await client.functions.invoke('does-not-exist', { body: {} });
  check(
    'functions.invoke(unknown) → FunctionsHttpError 404',
    (nope.error as { context?: Response } | null)?.context?.status === 404,
    String(nope.error),
  );
  if (stack) {
    const hello = await client.functions.invoke('hello', { body: { name: 'client' } });
    check(
      'functions.invoke("hello")',
      !hello.error && (hello.data as { message?: string } | null)?.message === 'hello client',
      hello.error ?? hello.data,
    );
  }

  console.log('sign out');
  const unenroll = await client.auth.mfa.unenroll({ factorId });
  check('mfa.unenroll', !unenroll.error, unenroll.error);
  const out = await client.auth.signOut();
  check('signOut', !out.error, out.error);
  const after = await client.auth.getUser(token);
  check('the old access token no longer resolves a user', !!after.error, after.data);
  await db.query('delete from public.profiles where id = $1', [userId]).catch(() => undefined);
  const del = await admin.auth.admin.deleteUser(userId);
  check('admin.deleteUser', !del.error || del.error.status === 500, del.error);
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
