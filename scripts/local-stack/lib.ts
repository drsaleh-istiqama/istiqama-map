/**
 * Shared helpers for the Docker-less local stack (portable PostgreSQL + PostgREST + gateway).
 * Production and CI use the real Supabase stack; these scripts only exist because the
 * development machine cannot run Docker (see docs/ARCHITECTURE.md §1).
 */
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCAL = path.join(ROOT, '.local');
export const PG_HOME = path.join(LOCAL, 'pg');
export const PG_DATA = path.join(LOCAL, 'pgdata');
export const LOG_DIR = path.join(LOCAL, 'logs');
export const RUN_DIR = path.join(LOCAL, 'run');
export const DOWNLOADS = path.join(LOCAL, 'downloads');
export const EXE = process.platform === 'win32' ? '.exe' : '';

export const pgBin = (name: string): string => path.join(PG_HOME, 'bin', name + EXE);

/** Parse a dotenv-style file without overriding variables that are already set. */
export function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1]!;
    let value = m[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface StackConfig {
  pgPort: number;
  postgrestPort: number;
  gatewayPort: number;
  dbName: string;
  jwtSecret: string;
  anonKey: string;
  serviceKey: string;
}

export function config(): StackConfig {
  loadEnvFile(path.join(ROOT, '.env.local'));
  loadEnvFile(path.join(ROOT, '.env'));
  const dbUrl = process.env.DATABASE_URL ?? '';
  const dbName =
    /\/([^/?]+)(\?|$)/.exec(dbUrl.replace(/^postgres(ql)?:\/\/[^/]+/, ''))?.[1] ?? 'istiqama';
  return {
    pgPort: Number(process.env.PG_PORT ?? 54322),
    postgrestPort: Number(process.env.POSTGREST_PORT ?? 54323),
    gatewayPort: Number(process.env.GATEWAY_PORT ?? 54321),
    dbName,
    jwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
    anonKey: process.env.SUPABASE_ANON_KEY ?? '',
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  };
}

export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0)
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} exited with ${res.status}`);
}

export function capture(
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
  };
}

export function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const fail = (): void => {
      socket.destroy();
      resolve(false);
    };
    socket.once('error', fail);
    socket.once('timeout', fail);
  });
}

export async function waitForPort(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Start a long-running child that survives this script; stdout/stderr go to .local/logs. */
export function startDetached(
  name: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): number {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const out = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'a');
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(path.join(RUN_DIR, `${name}.pid`), String(child.pid));
  return child.pid ?? -1;
}

export function stopByPidFile(name: string): boolean {
  const file = path.join(RUN_DIR, `${name}.pid`);
  if (!fs.existsSync(file)) return false;
  const pid = Number(fs.readFileSync(file, 'utf8').trim());
  fs.rmSync(file, { force: true });
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

/** Base psql arguments for the local superuser connection. */
export function psqlArgs(db: string): string[] {
  const { pgPort } = config();
  return ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'postgres', '-d', db, '-X'];
}

export const PG_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PGCLIENTENCODING: 'UTF8',
  PGOPTIONS: '--client-min-messages=warning',
};

/** Parse `--flag value` / `--flag` style arguments; positional arguments are returned in `_`. */
export function parseArgs(
  argv: string[],
  booleans: string[] = [],
): Record<string, string | boolean | string[]> & { _: string[] } {
  const out: Record<string, string | boolean | string[]> & { _: string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (booleans.includes(key) || i + 1 >= argv.length || argv[i + 1]!.startsWith('--'))
        out[key] = true;
      else out[key] = argv[++i]!;
    } else out._.push(a);
  }
  return out;
}
