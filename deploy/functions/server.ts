/**
 * Edge Functions server for the self-hosted (Railway) deployment.
 *
 * The Railway Supabase template has no Edge Runtime, so supabase/functions/<name>/index.ts are
 * served by this small Node process, reusing the module loader of the local gateway
 * (scripts/local-stack/gateway/functions.ts: Deno shim, `npm:` specifiers, handler capture).
 *
 * Envoy routes `/functions/v1/*` here with the prefix stripped (cluster "functions", port 9000,
 * variable FUNCTIONS_HOST on the Envoy service), so a request arrives as `/<name>/<rest>`,
 * exactly what the hosted runtime and the local gateway give the function.
 *
 * Envoy does not check tokens on the functions route, so this server does what the Edge
 * Runtime does with `verify_jwt = true`: a missing / expired / badly signed bearer token is
 * refused before the function runs. Accepted: HS256 with JWT_SECRET (anon / service-role keys)
 * and ES256 against SUPABASE_JWKS (GoTrue user tokens when asymmetric signing keys are set).
 *
 * Environment (the template's `supabase-secrets --service functions` entrypoint derives the
 * first four from ROOT_SECRET, see deploy/functions/Dockerfile):
 *   JWT_SECRET, SUPABASE_JWKS, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_URL            internal Envoy URL, e.g. http://envoy.railway.internal:8000
 *   APP_ORIGINS             https://map.istiqama.om
 *   PORT                    default 9000 (must match Envoy's functions cluster)
 *   FUNCTIONS_NO_VERIFY_JWT comma list, default "otp-hook" (Auth hook: signed, no JWT)
 *   PURGE_PHOTOS_UTC        "HH:MM" daily in-process run of purge-photos with the service key;
 *                           "off" disables it. Default "01:30".
 */
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FunctionBootError,
  FunctionHost,
  toFetchRequest,
  writeFetchResponse,
} from '../../scripts/local-stack/gateway/functions.ts';
import type { GatewayConfig } from '../../scripts/local-stack/gateway/config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT ?? 9000);
const FUNCTIONS_DIR = process.env.FUNCTIONS_DIR ?? path.join(ROOT, 'supabase', 'functions');
const NO_VERIFY = new Set(
  (process.env.FUNCTIONS_NO_VERIFY_JWT ?? 'otp-hook')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`,
  );
}

for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!process.env[name]) log('warn', 'env_missing', { name });
}

// ---------------------------------------------------------------------------------------------
// JWT verification (HS256 legacy secret, ES256 JWKS)
// ---------------------------------------------------------------------------------------------

type Jwk = { kty?: string; kid?: string; alg?: string; [k: string]: unknown };
const jwks: Jwk[] = (() => {
  try {
    const parsed = JSON.parse(process.env.SUPABASE_JWKS ?? '{"keys":[]}') as { keys?: Jwk[] };
    return (parsed.keys ?? []).filter((k) => k.kty === 'EC');
  } catch {
    log('warn', 'jwks_unparsable');
    return [];
  }
})();

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function verifyToken(token: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (!header || !payload) return false;
  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  let ok = false;
  if (header.alg === 'HS256') {
    const secret = process.env.JWT_SECRET;
    if (!secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(data).digest();
    ok = expected.length === sig.length && crypto.timingSafeEqual(expected, sig);
  } else if (header.alg === 'ES256') {
    const candidates = header.kid ? jwks.filter((k) => k.kid === header.kid) : jwks;
    for (const jwk of candidates) {
      try {
        const input = { key: jwk, format: 'jwk' } as unknown as crypto.JsonWebKeyInput;
        const key = crypto.createPublicKey(input);
        if (crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)) {
          ok = true;
          break;
        }
      } catch {
        /* try the next key */
      }
    }
  }
  if (!ok) return false;
  const exp = payload.exp;
  return typeof exp !== 'number' || exp > nowSeconds;
}

// ---------------------------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------------------------

const host = new FunctionHost({ port: PORT, functionsDir: FUNCTIONS_DIR } as GatewayConfig);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const pathname = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? '' : raw.slice(q + 1);
  if (pathname === '/_health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  const parts = pathname.split('/').filter(Boolean);
  const name = parts[0] ?? '';
  if (!host.entry(name)) {
    sendJson(res, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
    return;
  }
  if (req.method !== 'OPTIONS' && !NO_VERIFY.has(name)) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) {
      sendJson(res, 401, { code: 401, message: 'Missing authorization header' });
      return;
    }
    if (!verifyToken(m[1]!.trim())) {
      sendJson(res, 401, { code: 401, message: 'Invalid JWT' });
      return;
    }
  }
  const url = `http://${req.headers.host ?? `127.0.0.1:${PORT}`}/${parts.join('/')}${query ? `?${query}` : ''}`;
  const started = Date.now();
  let response: Response | null;
  try {
    response = await host.invoke(name, toFetchRequest(req, url));
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const boot = err instanceof FunctionBootError;
    log('error', boot ? 'function_boot_error' : 'function_error', { name, error: err.message });
    if (res.headersSent) res.destroy();
    else
      sendJson(res, boot ? 503 : 500, {
        code: boot ? 'BOOT_ERROR' : 'WORKER_ERROR',
        message: boot
          ? 'Function failed to start (please check logs)'
          : 'Function exited due to an error (please check logs)',
      });
    return;
  }
  if (!(response instanceof Response)) {
    sendJson(res, 500, { code: 'WORKER_ERROR', message: 'The function did not return a Response' });
    return;
  }
  await writeFetchResponse(res, response);
  log('info', 'request', {
    name,
    method: req.method,
    status: response.status,
    ms: Date.now() - started,
  });
}

// ---------------------------------------------------------------------------------------------
// Daily purge-photos (service role, in process) — the hosted equivalent is a Supabase Cron job
// ---------------------------------------------------------------------------------------------

function schedulePurge(): void {
  const at = process.env.PURGE_PHOTOS_UTC ?? '01:30';
  if (at === 'off') return;
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!m || !key) {
    log('warn', 'purge_schedule_disabled', {
      reason: !m ? 'bad PURGE_PHOTOS_UTC' : 'no service key',
    });
    return;
  }
  const next = (): number => {
    const now = new Date();
    const t = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        Number(m[1]),
        Number(m[2]),
      ),
    );
    if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
    return t.getTime() - now.getTime();
  };
  const run = async (): Promise<void> => {
    try {
      const response = await host.invoke(
        'purge-photos',
        new Request(`http://127.0.0.1:${PORT}/purge-photos`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            apikey: key,
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      );
      const text = response ? await response.text() : 'not found';
      log('info', 'purge_photos_done', { status: response?.status, result: text.slice(0, 500) });
    } catch (e) {
      log('error', 'purge_photos_failed', { error: e instanceof Error ? e.message : String(e) });
    }
    setTimeout(() => void run(), next());
  };
  setTimeout(() => void run(), next());
  log('info', 'purge_scheduled', { utc: at });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    log('error', 'unhandled', { error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) sendJson(res, 500, { code: 'WORKER_ERROR', message: 'internal error' });
    else res.destroy();
  });
});
// "::" accepts IPv6 (Railway private network) and IPv4.
server.listen(PORT, '::', () => {
  log('info', 'functions_server_listening', { port: PORT, dir: FUNCTIONS_DIR });
  schedulePurge();
});
