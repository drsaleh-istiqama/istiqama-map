/**
 * Environment access that works on the Supabase Edge Runtime (Deno) and under Node (local
 * gateway, Vitest). Never import Node built-ins from function code.
 */

interface DenoLike {
  env?: { get(name: string): string | undefined };
  serve?: (handler: (req: Request) => Response | Promise<Response>) => unknown;
}

interface EdgeRuntimeLike {
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface Globals {
  Deno?: DenoLike;
  EdgeRuntime?: EdgeRuntimeLike;
  process?: { env?: Record<string, string | undefined> };
}

const g = globalThis as unknown as Globals;

/** Value of an environment variable, `undefined` when unset or empty. */
export function env(name: string): string | undefined {
  let value: string | undefined;
  try {
    value = g.Deno?.env?.get(name);
  } catch {
    value = undefined; // Deno without --allow-env for this variable
  }
  if (value === undefined) value = g.process?.env?.[name];
  return value === undefined || value === '' ? undefined : value;
}

export class MissingEnvError extends Error {
  constructor(name: string) {
    super(`Missing environment variable ${name}`);
    this.name = 'MissingEnvError';
  }
}

export function requireEnv(name: string): string {
  const value = env(name);
  if (value === undefined) throw new MissingEnvError(name);
  return value;
}

/** Integer setting with bounds; falls back when unset or not a number. */
export function intEnv(
  name: string,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function boolEnv(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

/** Base URL of the API gateway (Kong on Supabase, the local gateway in development). */
export function supabaseUrl(): string {
  return requireEnv('SUPABASE_URL').replace(/\/+$/, '');
}

export function anonKey(): string {
  return requireEnv('SUPABASE_ANON_KEY');
}

/** Service-role key. Only for the code paths a contract names explicitly. */
export function serviceKey(): string {
  return requireEnv('SUPABASE_SERVICE_ROLE_KEY');
}

/** `production` switches off development conveniences (fake OTP provider). */
export function appEnv(): string {
  return (env('APP_ENV') ?? env('VITE_APP_ENV') ?? 'development').toLowerCase();
}

/**
 * Keep a promise alive after the response was sent. On the Edge Runtime this is
 * `EdgeRuntime.waitUntil`; elsewhere (local gateway: a long-lived process) the promise simply
 * keeps running. Rejections are logged, never thrown into the request.
 */
export function runInBackground(task: Promise<unknown>, label: string): void {
  const guarded = task.catch((e: unknown) => {
    console.error(`[${label}] background task failed:`, e instanceof Error ? e.message : e);
  });
  const waitUntil = g.EdgeRuntime?.waitUntil;
  if (typeof waitUntil === 'function') {
    try {
      waitUntil.call(g.EdgeRuntime, guarded);
    } catch {
      /* the promise keeps running anyway */
    }
  }
}

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * `Deno.serve(handler)` when this module is the entry point of an Edge Function worker.
 * The local gateway and the unit tests import the module and use the exported `handler`
 * instead: there `import.meta.main` is `false` (Node >= 24.2) or `Deno` does not exist.
 */
export function serveIfEntryPoint(meta: ImportMeta, handler: Handler): void {
  const main = (meta as { main?: boolean }).main;
  const serve = g.Deno?.serve;
  if (main !== false && typeof serve === 'function') serve.call(g.Deno, handler);
}
