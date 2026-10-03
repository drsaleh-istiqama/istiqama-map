/**
 * A throw-away PostgREST + gateway pair on private ports for the smoke tests, so that they can
 * run against any database without touching the developer's running stack.
 * State (logs, storage, sample functions) lives in .local/smoke.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';

export const SMOKE_DIR = path.join(ROOT, '.local', 'smoke');

export interface PrivateStackOptions {
  dbName: string;
  pgPort: number;
  gatewayPort: number;
  postgrestPort: number;
  /** Extra environment for the gateway process. */
  gatewayEnv?: Record<string, string>;
}

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

export class PrivateStack {
  readonly baseUrl: string;
  readonly databaseUrl: string;
  private children: ChildProcess[] = [];
  private gateway: ChildProcess | null = null;

  constructor(private opts: PrivateStackOptions) {
    this.baseUrl = `http://127.0.0.1:${opts.gatewayPort}`;
    this.databaseUrl = `postgresql://postgres@127.0.0.1:${opts.pgPort}/${opts.dbName}`;
  }

  private startGateway(): ChildProcess {
    const out = fs.openSync(path.join(SMOKE_DIR, 'gateway.log'), 'a');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(ROOT, 'scripts', 'local-stack', 'gateway', 'server.ts')],
      {
        cwd: ROOT,
        stdio: ['ignore', out, out],
        env: {
          ...process.env,
          GATEWAY_PORT: String(this.opts.gatewayPort),
          POSTGREST_URL: `http://127.0.0.1:${this.opts.postgrestPort}`,
          DATABASE_URL: this.databaseUrl,
          SUPABASE_URL: this.baseUrl,
          STORAGE_DIR: path.join(SMOKE_DIR, 'storage'),
          FUNCTIONS_DIR: path.join(SMOKE_DIR, 'functions'),
          OTP_PROVIDER: 'fake',
          OTP_MIN_INTERVAL_SECONDS: '0',
          REFRESH_TOKEN_REUSE_INTERVAL: '1',
          ...this.opts.gatewayEnv,
        },
      },
    );
    this.children.push(child);
    return child;
  }

  /** Writes the sample functions, starts PostgREST and the gateway, waits until both answer. */
  async start(): Promise<void> {
    fs.rmSync(SMOKE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(SMOKE_DIR, 'functions', 'hello'), { recursive: true });
    fs.mkdirSync(path.join(SMOKE_DIR, 'functions', '_shared'), { recursive: true });
    fs.writeFileSync(
      path.join(SMOKE_DIR, 'functions', '_shared', 'greet.ts'),
      `export const greet = (name: string): string => 'hello ' + name;\n`,
    );
    fs.writeFileSync(
      path.join(SMOKE_DIR, 'functions', 'hello', 'index.ts'),
      [
        `import { greet } from '../_shared/greet.ts';`,
        `declare const Deno: { env: { get(k: string): string | undefined }; serve(h: unknown): unknown };`,
        `const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info' };`,
        `export async function handler(req: Request): Promise<Response> {`,
        `  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });`,
        `  const body = req.method === 'POST' ? await req.json() : {};`,
        `  const url = new URL(req.url);`,
        `  return Response.json(`,
        `    { message: greet(String(body.name ?? 'world')), path: url.pathname, anon: Deno.env.get('SUPABASE_ANON_KEY') !== undefined },`,
        `    { headers: cors },`,
        `  );`,
        `}`,
        `if (typeof Deno !== 'undefined') Deno.serve(handler);`,
        ``,
      ].join('\n'),
    );

    // Deno-style function: no export, Deno.serve only, an `npm:` specifier and a thrown error path.
    fs.mkdirSync(path.join(SMOKE_DIR, 'functions', 'deno-style'), { recursive: true });
    fs.writeFileSync(
      path.join(SMOKE_DIR, 'functions', 'deno-style', 'index.ts'),
      [
        `import jwt from 'npm:jsonwebtoken@9';`,
        `declare const Deno: { serve(h: (req: Request) => Response | Promise<Response>): unknown };`,
        `Deno.serve(async (req) => {`,
        `  const url = new URL(req.url);`,
        `  if (url.searchParams.get('fail')) throw new Error('boom');`,
        `  return new Response(JSON.stringify({ decode: typeof jwt.decode, method: req.method, body: await req.text() }), {`,
        `    status: 201,`,
        `    headers: { 'content-type': 'application/json', 'x-custom': 'yes' },`,
        `  });`,
        `});`,
        ``,
      ].join('\n'),
    );

    const postgrest = path.join(
      ROOT,
      '.local',
      'postgrest',
      process.platform === 'win32' ? 'postgrest.exe' : 'postgrest',
    );
    if (!fs.existsSync(postgrest))
      throw new Error(`PostgREST binary not found at ${postgrest} (npm run stack:setup)`);
    const out = fs.openSync(path.join(SMOKE_DIR, 'postgrest.log'), 'a');
    this.children.push(
      spawn(postgrest, [], {
        cwd: ROOT,
        stdio: ['ignore', out, out],
        env: {
          ...process.env,
          PATH: `${path.join(ROOT, '.local', 'pg', 'bin')}${path.delimiter}${process.env.PATH}`,
          PGRST_DB_URI: `postgres://authenticator:postgres@127.0.0.1:${this.opts.pgPort}/${this.opts.dbName}`,
          PGRST_DB_SCHEMAS: 'public',
          PGRST_DB_ANON_ROLE: 'anon',
          PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
          PGRST_DB_POOL: '10',
          PGRST_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ?? '',
          PGRST_SERVER_HOST: '127.0.0.1',
          PGRST_SERVER_PORT: String(this.opts.postgrestPort),
        },
      }),
    );
    this.gateway = this.startGateway();
    if (!(await waitFor(`http://127.0.0.1:${this.opts.postgrestPort}/`, 30_000)))
      throw new Error('PostgREST did not start (see .local/smoke/postgrest.log)');
    if (!(await waitFor(`${this.baseUrl}/dev/health`, 30_000)))
      throw new Error('gateway did not start (see .local/smoke/gateway.log)');
  }

  /** Kill and start the gateway again (PostgREST keeps running). */
  async restartGateway(): Promise<void> {
    const old = this.gateway;
    if (!old) return;
    await new Promise<void>((resolve) => {
      old.once('exit', () => resolve());
      old.kill();
    });
    await sleep(300);
    this.gateway = this.startGateway();
    if (!(await waitFor(`${this.baseUrl}/dev/health`, 30_000)))
      throw new Error('gateway did not come back after the restart');
  }

  stop(): void {
    for (const c of this.children) {
      try {
        c.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

/** `--name value` / `--flag` command-line helpers shared by the smoke scripts. */
export function cli(argv: string[]): {
  flag: (name: string) => boolean;
  opt: (name: string, fallback: string) => string;
} {
  return {
    flag: (name) => argv.includes(`--${name}`),
    opt: (name, fallback) => {
      const i = argv.indexOf(`--${name}`);
      return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
    },
  };
}

export function databaseNameFromEnv(): string {
  return (
    /\/([^/?]+)(\?|$)/.exec(
      (process.env.DATABASE_URL ?? '').replace(/^postgres(ql)?:\/\/[^/]+/, ''),
    )?.[1] ?? 'istiqama'
  );
}
