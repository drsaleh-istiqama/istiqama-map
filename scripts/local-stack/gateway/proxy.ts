/**
 * /rest/v1/* → PostgREST. Streaming reverse proxy over keep-alive connections; this is the
 * hot path of the load tests, so it does no parsing beyond copying headers.
 *
 * Like Kong on Supabase: the `/rest/v1` prefix is stripped, and when the client sent no
 * Authorization header the API key is used as the bearer token.
 */
import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { clientIp, sendJson } from './http.ts';
import { log } from './log.ts';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

export type RestProxy = (req: IncomingMessage, res: ServerResponse, upstreamPath: string) => void;

export function createRestProxy(target: URL): RestProxy {
  const agent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 10_000,
    maxSockets: 1024,
    maxFreeSockets: 256,
    scheduling: 'lifo',
  });
  const hostname = target.hostname;
  const port = Number(target.port || 80);
  const hostHeader = target.host;
  const basePath = target.pathname.replace(/\/$/, '');

  const forward = (
    req: IncomingMessage,
    res: ServerResponse,
    upstreamPath: string,
    attempt: number,
  ): void => {
    const headers: OutgoingHttpHeaders = {};
    for (const key in req.headers) {
      if (!HOP_BY_HOP.has(key)) headers[key] = req.headers[key];
    }
    if (headers.authorization === undefined) {
      const key = req.headers.apikey;
      if (typeof key === 'string' && key) headers.authorization = `Bearer ${key}`;
    }
    headers.host = hostHeader;
    headers['x-forwarded-for'] = clientIp(req);
    if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-proto'] = 'http';

    const bodyless = req.method === 'GET' || req.method === 'HEAD';
    const upstream = http.request(
      { agent, hostname, port, method: req.method, path: basePath + upstreamPath, headers },
      (ur) => {
        const out: OutgoingHttpHeaders = {};
        for (const key in ur.headers) {
          // CORS is answered by the gateway; PostgREST's own CORS headers would duplicate it.
          if (!HOP_BY_HOP.has(key) && !key.startsWith('access-control-'))
            out[key] = ur.headers[key];
        }
        res.writeHead(ur.statusCode ?? 502, out);
        ur.pipe(res);
      },
    );
    upstream.on('error', (e: NodeJS.ErrnoException) => {
      // A kept-alive socket may have been closed by PostgREST just as we reused it.
      if (
        bodyless &&
        attempt === 0 &&
        !res.headersSent &&
        (e.code === 'ECONNRESET' || e.code === 'EPIPE')
      ) {
        forward(req, res, upstreamPath, 1);
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      log('error', 'postgrest_unreachable', { error: e.message });
      sendJson(res, 502, {
        code: 'GATEWAY_UPSTREAM',
        message: 'An invalid response was received from the upstream server',
        hint: 'PostgREST is not reachable — is the local stack running? (npm run stack:start)',
      });
    });
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
    if (bodyless) upstream.end();
    else req.pipe(upstream);
  };

  return (req, res, upstreamPath) => forward(req, res, upstreamPath, 0);
}
