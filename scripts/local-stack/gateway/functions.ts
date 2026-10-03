/**
 * /functions/v1/<name> — runs supabase/functions/<name>/index.ts inside the gateway process.
 *
 * Contract with the function modules (docs/ARCHITECTURE.md §6): Deno-compatible TypeScript
 * that either exports `handler` / a default export `(req: Request) => Response | Promise<Response>`
 * or calls `Deno.serve(handler)`. A minimal `globalThis.Deno` (env, serve, version, cwd,
 * readTextFile, readFile) is provided; `Deno.serve` only records the handler.
 *
 * Differences from the real Edge Runtime are listed in docs/contracts/local-gateway.md
 * (no isolate per request, no resource limits, Node APIs instead of Deno APIs).
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { register } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pathToFileURL } from 'node:url';
import type { GatewayConfig } from './config.ts';
import { header, sendJson } from './http.ts';
import { bearerToken, verifyJwt } from './jwt.ts';
import { log } from './log.ts';

export type FunctionHandler = (req: Request) => Response | Promise<Response>;

interface Loaded {
  handler: FunctionHandler;
  /** Files of the module graph (to detect edits) and their newest mtime at load time. */
  files: string[];
  stamp: number;
  checkedAt: number;
}

let captured: FunctionHandler | null = null;
let shimInstalled = false;

function installDenoShim(port: number): void {
  if (shimInstalled) return;
  shimInstalled = true;
  const g = globalThis as unknown as { Deno?: unknown; EdgeRuntime?: unknown };
  // Background work after the response (`EdgeRuntime.waitUntil(promise)`): the gateway is a
  // long-lived process, so the promise simply keeps running; failures are logged.
  g.EdgeRuntime ??= {
    waitUntil: (p: Promise<unknown>): void => {
      Promise.resolve(p).catch((e: unknown) =>
        log('error', 'function_background_error', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    },
  };
  if (g.Deno !== undefined) return;
  g.Deno = {
    env: {
      get: (key: string): string | undefined => process.env[key],
      set: (key: string, value: string): void => {
        process.env[key] = value;
      },
      has: (key: string): boolean => process.env[key] !== undefined,
      delete: (key: string): void => {
        delete process.env[key];
      },
      toObject: (): Record<string, string | undefined> => ({ ...process.env }),
    },
    serve: (a: unknown, b?: unknown): unknown => {
      const handler =
        typeof a === 'function'
          ? a
          : typeof b === 'function'
            ? b
            : typeof (a as { handler?: unknown } | null)?.handler === 'function'
              ? (a as { handler: unknown }).handler
              : null;
      if (handler) captured = handler as FunctionHandler;
      return {
        finished: new Promise<void>(() => undefined),
        shutdown: async (): Promise<void> => undefined,
        ref: (): void => undefined,
        unref: (): void => undefined,
        addr: { transport: 'tcp', hostname: '127.0.0.1', port },
      };
    },
    version: { deno: '0.0.0-local-gateway', v8: process.versions.v8, typescript: '' },
    build: { os: process.platform === 'win32' ? 'windows' : process.platform, arch: process.arch },
    args: [] as string[],
    cwd: (): string => process.cwd(),
    readTextFile: (p: string | URL): Promise<string> => fs.promises.readFile(p, 'utf8'),
    readFile: (p: string | URL): Promise<Uint8Array> => fs.promises.readFile(p),
  };
}

let npmHookInstalled = false;

/** Let `npm:<package>[@version][/path]` specifiers (Deno style) resolve from node_modules. */
function installNpmSpecifierHook(): void {
  if (npmHookInstalled) return;
  npmHookInstalled = true;
  const source = [
    'export async function resolve(specifier, context, nextResolve) {',
    "  if (specifier.startsWith('npm:')) {",
    '    const m = /^npm:(@[^/]+\\/[^@/]+|[^@/]+)(?:@[^/]+)?(\\/.*)?$/.exec(specifier);',
    "    if (m) return nextResolve(m[1] + (m[2] ?? ''), context);",
    '  }',
    '  return nextResolve(specifier, context);',
    '}',
  ].join('\n');
  try {
    register(`data:text/javascript,${encodeURIComponent(source)}`, import.meta.url);
  } catch (e) {
    log('warn', 'functions_npm_hook_failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class FunctionHost {
  private loaded = new Map<string, Loaded>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private cfg: GatewayConfig) {}

  entry(name: string): string | null {
    if (!NAME_RE.test(name)) return null;
    const file = path.join(this.cfg.functionsDir, name, 'index.ts');
    return fs.existsSync(file) ? file : null;
  }

  private newestMtime(files: string[]): number {
    let newest = 0;
    for (const f of files) {
      try {
        newest = Math.max(newest, fs.statSync(f).mtimeMs);
      } catch {
        return Infinity; // a file of the graph disappeared: reload
      }
    }
    return newest;
  }

  /** Load (or reload after an edit) the function module. Loads are serialised because Deno.serve is captured globally. */
  private load(name: string, entry: string): Promise<Loaded> {
    const run = async (): Promise<Loaded> => {
      const current = this.loaded.get(name);
      const now = Date.now();
      if (current) {
        if (now - current.checkedAt < 500) return current;
        current.checkedAt = now;
        if (this.newestMtime(current.files) <= current.stamp) return current;
        log('info', 'function_reload', { name });
      }
      installDenoShim(this.cfg.port);
      installNpmSpecifierHook();
      const files = new Set<string>([entry]);
      captured = null;
      const url = pathToFileURL(entry).href;
      let mod: Record<string, unknown>;
      try {
        // A fresh tsx namespace re-evaluates the whole module graph (index.ts and _shared/*).
        const { tsImport } = await import('tsx/esm/api');
        mod = (await tsImport(url, {
          parentURL: import.meta.url,
          onImport: (u: string) => {
            if (u.startsWith('file:') && !u.includes('/node_modules/')) {
              try {
                files.add(
                  path.normalize(
                    decodeURIComponent(new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
                  ),
                );
              } catch {
                /* ignore odd URLs */
              }
            }
          },
        })) as Record<string, unknown>;
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND' ||
          !String((e as Error).message).includes('tsx')
        )
          throw e;
        mod = (await import(`${url}?v=${now}`)) as Record<string, unknown>;
      }
      const pick = (v: unknown): FunctionHandler | null =>
        typeof v === 'function' ? (v as FunctionHandler) : null;
      const def = mod.default as { fetch?: unknown } | undefined;
      const handler = pick(mod.handler) ?? pick(mod.default) ?? pick(def?.fetch) ?? captured;
      captured = null;
      if (!handler)
        throw new Error(
          `supabase/functions/${name}/index.ts exports no handler (export "handler", a default function, or call Deno.serve)`,
        );
      const list = [...files];
      const loaded: Loaded = {
        handler,
        files: list,
        stamp: this.newestMtime(list),
        checkedAt: now,
      };
      this.loaded.set(name, loaded);
      return loaded;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** In-process invocation. Returns null when the function does not exist. */
  async invoke(name: string, request: Request): Promise<Response | null> {
    const entry = this.entry(name);
    if (!entry) return null;
    let loaded: Loaded;
    try {
      loaded = await this.load(name, entry);
    } catch (e) {
      throw new FunctionBootError(e instanceof Error ? e.message : String(e), { cause: e });
    }
    return loaded.handler(request);
  }
}

/** The module could not be imported (syntax error, missing dependency, no handler). */
export class FunctionBootError extends Error {}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
]);

/** Node request → Fetch Request (the body is streamed). */
export function toFetchRequest(req: IncomingMessage, url: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, v);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as BodyInit;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** Fetch Response → Node response (streamed). */
export async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie' && !HOP_BY_HOP.has(key)) res.setHeader(key, value);
  });
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(response.status);
  if (!response.body) {
    res.end();
    return;
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      res,
    );
  } catch {
    res.destroy();
  }
}

export async function handleFunction(
  cfg: GatewayConfig,
  host: FunctionHost,
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string,
  queryString: string,
): Promise<void> {
  const parts = subPath.split('/').filter(Boolean);
  const name = parts[0] ?? '';
  if (!host.entry(name)) {
    sendJson(res, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
    return;
  }
  // The Edge Runtime checks the JWT before the function runs unless verify_jwt = false
  // in supabase/config.toml. CORS preflights are passed through to the function.
  if (req.method !== 'OPTIONS' && (cfg.functionVerifyJwt.get(name) ?? true)) {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { code: 401, message: 'Missing authorization header' });
      return;
    }
    if (!verifyJwt(token, cfg.jwtSecret).ok) {
      sendJson(res, 401, { code: 401, message: 'Invalid JWT' });
      return;
    }
  }
  // Like the hosted runtime, the function sees "/<name>/<rest>" (no "/functions/v1" prefix).
  const url = `http://${header(req, 'host') ?? `127.0.0.1:${cfg.port}`}/${parts.join('/')}${queryString ? `?${queryString}` : ''}`;
  let response: Response | null;
  try {
    response = await host.invoke(name, toFetchRequest(req, url));
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const boot = err instanceof FunctionBootError;
    log('error', boot ? 'function_boot_error' : 'function_error', {
      name,
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 6).join(' | '),
    });
    if (res.headersSent) res.destroy();
    else if (boot)
      sendJson(res, 503, {
        code: 'BOOT_ERROR',
        message: 'Function failed to start (please check logs)',
        error: err.message,
      });
    else
      sendJson(res, 500, {
        code: 'WORKER_ERROR',
        message: 'Function exited due to an error (please check logs)',
        error: err.message,
      });
    return;
  }
  if (!response) {
    sendJson(res, 404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
    return;
  }
  if (!(response instanceof Response)) {
    sendJson(res, 500, { code: 'WORKER_ERROR', message: 'The function did not return a Response' });
    return;
  }
  await writeFetchResponse(res, response);
}
