/**
 * Database access. The gateway connects as the local superuser (the real services use
 * supabase_auth_admin / supabase_storage_admin). Storage metadata statements run inside a
 * transaction that impersonates the caller exactly like the Supabase Storage API does:
 * `set local role <jwt role>` + `request.jwt.claims`, so the RLS policies on storage.objects
 * written in our migrations decide.
 */
import pg from 'pg';
import type { Claims, Role } from './jwt.ts';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createDb(connectionString: string, max: number): Db {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'local-gateway',
  });
  // An idle client that loses its connection must not crash the process.
  pool.on('error', () => undefined);
  return pool;
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    try {
      await client.query('rollback');
    } catch {
      /* connection already gone */
    }
    throw e;
  } finally {
    client.release();
  }
}

export interface Caller {
  role: Role;
  claims: Claims;
  /** `sub` claim when the caller is an end user. */
  userId: string | null;
}

export interface RequestInfo {
  method: string;
  path: string;
  /** Lower-cased request headers without credentials. */
  headers: Record<string, string>;
  operation?: string;
}

/** Run `fn` as the caller's database role with the JWT claims PostgREST would expose. */
export async function withCaller<T>(
  db: Db,
  caller: Caller,
  info: RequestInfo,
  fn: (tx: Tx) => Promise<T>,
  opts: { rollback?: boolean } = {},
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('role', $1, true),
              set_config('request.jwt.claims', $2, true),
              set_config('request.jwt.claim.sub', $3, true),
              set_config('request.jwt.claim.role', $1, true),
              set_config('request.headers', $4, true),
              set_config('request.method', $5, true),
              set_config('request.path', $6, true),
              set_config('storage.operation', $7, true)`,
      [
        caller.role,
        JSON.stringify(caller.claims),
        caller.userId ?? '',
        JSON.stringify(info.headers),
        info.method,
        info.path,
        info.operation ?? '',
      ],
    );
    const result = await fn(client);
    await client.query(opts.rollback ? 'rollback' : 'commit');
    return result;
  } catch (e) {
    try {
      await client.query('rollback');
    } catch {
      /* connection already gone */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** SQLSTATE of a node-postgres error, if any. */
export function sqlState(e: unknown): string | undefined {
  return typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string'
    ? (e as { code: string }).code
    : undefined;
}

/** Connection-level failures (database down, pool timeout): must surface as 5xx, never 4xx. */
export function isConnectionError(e: unknown): boolean {
  const code = sqlState(e);
  if (code && /^(08|57P0|53)/.test(code)) return true;
  const msg = e instanceof Error ? e.message : '';
  return /ECONNREFUSED|ECONNRESET|timeout exceeded when trying to connect|Connection terminated/i.test(
    msg,
  );
}
