/**
 * Local Supabase-compatible gateway (Docker-less development stack).
 *
 *   /rest/v1/*       → PostgREST (reverse proxy)
 *   /auth/v1/*       → GoTrue emulation (OTP, sessions, MFA TOTP, admin API)
 *   /storage/v1/*    → Storage API emulation (objects on disk, RLS-checked, TUS uploads)
 *   /functions/v1/*  → supabase/functions/<name>/index.ts, loaded in-process
 *   /dev/*           → development helpers (never present on real Supabase)
 *
 * Start:  node --import tsx scripts/local-stack/gateway/server.ts
 * Configuration: environment variables only (see config.ts and README.md).
 */
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { handleAuth } from './auth/routes.ts';
import { normalizeEmail, normalizePhone } from './auth/store.ts';
import { assertUsable, loadConfig, loadDotenv } from './config.ts';
import { createDb } from './db.ts';
import { FunctionHost, handleFunction } from './functions.ts';
import {
  answerPreflight,
  applyCors,
  clientIp,
  header,
  isPreflight,
  sendJson,
  splitUrl,
} from './http.ts';
import { roleOf, verifyJwt } from './jwt.ts';
import { flushLogs, log, logRequest, setLogLevel } from './log.ts';
import { createRestProxy } from './proxy.ts';
import { RateLimiter } from './ratelimit.ts';
import { handleStorage, sweepStorage } from './storage/routes.ts';
import type { Ctx } from './types.ts';

loadDotenv();
const cfg = loadConfig();
try {
  assertUsable(cfg);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
setLogLevel(cfg.logLevel);

// Values the Edge Functions expect from the platform.
process.env.SUPABASE_URL ??= `http://127.0.0.1:${cfg.port}`;
process.env.SUPABASE_DB_URL ??= cfg.databaseUrl;

fs.mkdirSync(cfg.storageDir, { recursive: true });

const db = createDb(cfg.databaseUrl, cfg.dbPoolSize);
const functions = new FunctionHost(cfg);
const ctx: Ctx = {
  cfg,
  db,
  limiter: new RateLimiter(),
  otpOutbox: new Map(),
  invokeFunction: (name, request) => functions.invoke(name, request),
};
const proxyRest = createRestProxy(cfg.postgrestUrl);

/** `/prefix` or `/prefix/...` → the remainder (always starting with "/"), else null. */
function under(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest === '') return '/';
  return rest.startsWith('/') ? rest : null;
}

/** Kong key-auth: a known API key in the `apikey` header (or query parameter). */
function checkApiKey(req: IncomingMessage, res: ServerResponse, query: string): boolean {
  let key = header(req, 'apikey');
  if (!key && query) key = new URLSearchParams(query).get('apikey') ?? undefined;
  if (!key) {
    sendJson(res, 401, { message: 'No API key found in request' });
    return false;
  }
  if (key !== cfg.anonKey && key !== cfg.serviceKey) {
    sendJson(res, 401, {
      message: 'Invalid API key',
      hint: 'Double check your Supabase `anon` or `service_role` API key.',
    });
    return false;
  }
  return true;
}

const AUTH_OPEN = new Set(['/verify', '/callback', '/authorize']);

async function handleDev(
  req: IncomingMessage,
  res: ServerResponse,
  sub: string,
  query: string,
): Promise<void> {
  if (sub === '/health') {
    let database = false;
    let schema = false;
    try {
      const r = await db.query<{ ok: boolean }>(
        `select to_regclass('auth.users') is not null as ok`,
      );
      database = true;
      schema = r.rows[0]?.ok === true;
    } catch {
      /* reported below */
    }
    let postgrest = false;
    try {
      const r = await fetch(new URL('/', cfg.postgrestUrl), {
        method: 'HEAD',
        signal: AbortSignal.timeout(2000),
      });
      postgrest = r.status < 500;
    } catch {
      /* reported below */
    }
    sendJson(res, database && schema && postgrest ? 200 : 503, {
      status: database && schema && postgrest ? 'ok' : 'degraded',
      database,
      auth_schema: schema,
      postgrest,
      otp_provider: cfg.otpProvider,
    });
    return;
  }
  if (sub === '/otp' && req.method === 'GET') {
    if (cfg.otpProvider !== 'fake') {
      sendJson(res, 404, {
        error: 'not_found',
        message: 'GET /dev/otp is only available with OTP_PROVIDER=fake',
      });
      return;
    }
    // Codes are handed out to local test runners only, even when the gateway listens on the LAN.
    const ip = clientIp(req);
    if (ip !== '127.0.0.1' && ip !== '::1') {
      sendJson(res, 403, {
        error: 'forbidden',
        message: 'GET /dev/otp is only available from this machine (read the gateway log instead)',
      });
      return;
    }
    const raw = new URLSearchParams(query).get('identifier') ?? '';
    const identifier = raw.includes('@') ? normalizeEmail(raw) : normalizePhone(raw);
    const entry = ctx.otpOutbox.get(identifier);
    if (!entry || entry.expiresAt < Date.now()) {
      sendJson(res, 404, { error: 'not_found', message: `No pending code for ${identifier}` });
      return;
    }
    sendJson(res, 200, {
      code: entry.code,
      identifier,
      channel: entry.channel,
      expires_at: new Date(entry.expiresAt).toISOString(),
    });
    return;
  }
  sendJson(res, 404, { error: 'not_found', message: 'Unknown development endpoint' });
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  const started = performance.now();
  const { path, query } = splitUrl(req.url ?? '/');
  res.once('close', () =>
    logRequest(req.method ?? 'GET', path, res.statusCode, performance.now() - started),
  );

  let sub: string | null;
  if ((sub = under(path, '/rest/v1')) !== null) {
    applyCors(req, res, cfg.corsOrigin);
    if (isPreflight(req)) return answerPreflight(req, res);
    if (!checkApiKey(req, res, query)) return;
    return proxyRest(req, res, query ? `${sub}?${query}` : sub);
  }

  const fail = (e: unknown): void => {
    log('error', 'unhandled', { path, error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    else res.destroy();
  };

  if ((sub = under(path, '/functions/v1')) !== null) {
    // No CORS help here: on Supabase the function itself must answer preflights.
    handleFunction(cfg, functions, req, res, sub, query).catch(fail);
    return;
  }

  applyCors(req, res, cfg.corsOrigin);
  if (isPreflight(req)) return answerPreflight(req, res);

  if ((sub = under(path, '/auth/v1')) !== null) {
    if (!(AUTH_OPEN.has(sub) && req.method === 'GET') && !checkApiKey(req, res, query)) return;
    handleAuth(ctx, req, res, sub, query).catch(fail);
    return;
  }
  if ((sub = under(path, '/storage/v1')) !== null) {
    handleStorage(ctx, req, res, sub, query).catch(fail);
    return;
  }
  if ((sub = under(path, '/dev')) !== null) {
    handleDev(req, res, sub, query).catch(fail);
    return;
  }
  sendJson(res, 404, { message: 'no Route matched with those values' });
}

// ---------------------------------------------------------------------------
// Timers replacing pg_cron (docs/ARCHITECTURE.md Appendix A.6)
// ---------------------------------------------------------------------------
const runningJobs = new Set<string>();

/**
 * Run one of the SQL jobs that pg_cron runs in production (migration 0058), as the database
 * owner and without JWT claims — exactly how a cron job calls it. Silently skipped while the
 * function does not exist; never overlaps with itself.
 */
function sqlJob(name: string, signature: string, statement: string): () => Promise<void> {
  return async () => {
    if (runningJobs.has(name)) return;
    runningJobs.add(name);
    const t0 = performance.now();
    try {
      const exists = await db.query<{ ok: boolean }>(
        'select to_regprocedure($1) is not null as ok',
        [signature],
      );
      if (!exists.rows[0]?.ok) return;
      await db.query(statement);
      log('info', 'cron_job', { job: name, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      log('warn', 'cron_job_failed', {
        job: name,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      runningJobs.delete(name);
    }
  };
}

const refreshReports = sqlJob(
  'refresh-reports',
  'public.refresh_reports()',
  'select public.refresh_reports()',
);
const rateLimitCleanup = sqlJob(
  'rate-limit-cleanup',
  'private.rate_limit_cleanup(interval)',
  'select private.rate_limit_cleanup()',
);
const expireExports = sqlJob(
  'expire-exports',
  'private.expire_export_jobs()',
  'select private.expire_export_jobs()',
);

async function purgePhotos(): Promise<void> {
  try {
    const response = await functions.invoke(
      'purge-photos',
      new Request(`http://127.0.0.1:${cfg.port}/purge-photos`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.serviceKey}`,
          apikey: cfg.serviceKey,
        },
        body: '{}',
      }),
    );
    if (response) log(response.ok ? 'info' : 'warn', 'purge_photos', { status: response.status });
  } catch (e) {
    log('warn', 'purge_photos_failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

function every(ms: number, firstDelayMs: number, job: () => Promise<void>): void {
  if (ms <= 0) return;
  setTimeout(() => {
    void job();
    setInterval(() => void job(), ms).unref();
  }, firstDelayMs).unref();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = http.createServer({ keepAlive: true, keepAliveTimeout: 65_000 }, onRequest);
server.headersTimeout = 70_000;
server.requestTimeout = 0; // slow field uploads must not be cut off
server.on('clientError', (_e, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});
server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(
    e.code === 'EADDRINUSE'
      ? `gateway: port ${cfg.port} is already in use`
      : `gateway: ${e.message}`,
  );
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  for (const w of cfg.warnings) log('warn', 'config_warning', { warning: w });
  for (const [name, key] of [
    ['SUPABASE_ANON_KEY', cfg.anonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', cfg.serviceKey],
  ] as const) {
    const v = verifyJwt(key, cfg.jwtSecret);
    const expected = name === 'SUPABASE_ANON_KEY' ? 'anon' : 'service_role';
    if (!v.ok || roleOf(v.claims) !== expected) {
      log('warn', 'config_warning', {
        warning: `${name} is not a valid ${expected} JWT for SUPABASE_JWT_SECRET — PostgREST will reject it`,
      });
    }
  }
  log('info', 'gateway_started', {
    url: `http://${cfg.host}:${cfg.port}`,
    postgrest: cfg.postgrestUrl.origin,
    storage_dir: cfg.storageDir,
    functions_dir: cfg.functionsDir,
    otp_provider: cfg.otpProvider,
    signup_enabled: cfg.enableSignup,
    jwt_expiry: cfg.jwtExpiry,
  });
  db.query(`select to_regclass('auth.users') is not null as ok`).then(
    (r) => {
      if (!r.rows[0]?.ok)
        log('warn', 'config_warning', {
          warning:
            'schema "auth" is missing — run "npm run db:reset" (it applies supabase-shim.sql)',
        });
    },
    (e: Error) => log('error', 'database_unreachable', { error: e.message }),
  );
  flushLogs();
});

every(cfg.reportsRefreshMinutes * 60_000, 60_000, refreshReports);
every(3_600_000, 7 * 60_000, rateLimitCleanup);
every(24 * 3_600_000, 10 * 60_000, expireExports);
every(cfg.purgeEveryHours * 3_600_000, 5 * 60_000, purgePhotos);
every(3_600_000, 10_000, () => sweepStorage(ctx));

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  log('info', 'gateway_stopping');
  flushLogs();
  server.close(() => {
    void db.end().finally(() => process.exit(0));
  });
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
