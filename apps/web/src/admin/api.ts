/**
 * Server calls of the administration console.
 *
 *  - admin RPCs (people-admin.md §6–7) through `transport.rpc` of src/sync (POST, timeout,
 *    typed errors);
 *  - the `admin` Edge Function for everything that has an Auth half — revoking sessions or a
 *    device (refresh tokens are ended too), (de)activating an account (Auth ban) and
 *    creating an account (self sign-up is disabled) — supabase/functions/README.md §5.6;
 *  - direct PostgREST reads/writes of the reference tables, which RLS lets only `hq_admin`
 *    at aal2 change (authz.md §4.1). Every update carries the row `version` it was based on,
 *    so two administrators never overwrite each other silently.
 *
 * Only the shared supabase client (anon key + the administrator's JWT) is used: never the
 * service key. After a change to a table that devices pull, `syncNow()` brings it to this
 * device at once. Everything is behind replaceable ports (`setAdminPorts`) for the tests.
 */
import type { RoleName } from '../auth';
import { refreshContext, supabase } from '../auth';
import { syncNow, transport } from '../sync';
import { loadAppSettings } from '../ui';
import { AdminError, functionError, restError } from './errors';
import {
  SYNCED_REF_TABLES,
  type AdminUser,
  type CreateUserInput,
  type CreateUserResult,
  type RefTable,
  type RemoveRoleResult,
  type RestoreDeviceResult,
  type RevokeResult,
  type ScopeType,
  type SetActiveResult,
  type SetRoleResult,
  type SyncStatusReport,
} from './types';

export type Order = ReadonlyArray<readonly [column: string, ascending: boolean]>;

export interface AdminPorts {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  /** POST to the `admin` Edge Function with the administrator's JWT. */
  invoke<T>(body: Record<string, unknown>): Promise<T>;
  select<T>(
    table: string,
    columns: string,
    order: Order,
    eq?: Record<string, string>,
  ): Promise<T[]>;
  insert<T>(table: RefTable, row: Record<string, unknown>): Promise<T>;
  /** Optimistic update: only when the stored `version` is still `version` (else `stale`). */
  update<T>(
    table: RefTable,
    id: string,
    version: number,
    patch: Record<string, unknown>,
  ): Promise<T>;
  syncNow(): Promise<void>;
  refreshSettings(): Promise<void>;
  refreshContext(): Promise<unknown>;
  online(): boolean;
}

type PgResult = {
  data: unknown;
  error: { code?: string | null; message?: string | null } | null;
  status: number;
};

/** PostgREST `max_rows` of supabase/config.toml. */
const PAGE_ROWS = 1000;

async function run(query: PromiseLike<unknown>): Promise<PgResult> {
  try {
    return (await query) as PgResult;
  } catch (e) {
    throw new AdminError('network', '', 0, e instanceof Error ? e.message : String(e));
  }
}

const productionPorts: AdminPorts = {
  rpc: (fn, args) => transport.rpc(fn, args),

  async invoke<T>(body: Record<string, unknown>): Promise<T> {
    let result: { data: unknown; error: unknown };
    try {
      result = await supabase.functions.invoke('admin', { body });
    } catch (e) {
      throw new AdminError('network', '', 0, e instanceof Error ? e.message : String(e));
    }
    const { data, error } = result;
    if (!error) return data as T;
    const name = (error as { name?: string }).name ?? '';
    const context = (error as { context?: unknown }).context;
    if (name === 'FunctionsHttpError' && context instanceof Response) {
      let parsed: unknown;
      try {
        parsed = await context.clone().json();
      } catch {
        parsed = null;
      }
      throw functionError(context.status, parsed);
    }
    if (name === 'FunctionsRelayError') throw new AdminError('server', '', 502);
    throw new AdminError('network', '', 0, (error as Error).message);
  },

  async select<T>(table: string, columns: string, order: Order, eq: Record<string, string> = {}) {
    // PostgREST answers at most `max_rows` (1000) rows per request: read page by page, with
    // the id as the last sort key so that pages never overlap.
    const out: T[] = [];
    for (let from = 0; from < 100_000; from += PAGE_ROWS) {
      let query = supabase.from(table).select(columns);
      for (const [column, value] of Object.entries(eq)) query = query.eq(column, value);
      for (const [column, ascending] of order) query = query.order(column, { ascending });
      const res = await run(
        query.order('id', { ascending: true }).range(from, from + PAGE_ROWS - 1),
      );
      if (res.error) throw restError(res.error, res.status);
      const rows = (Array.isArray(res.data) ? res.data : []) as T[];
      out.push(...rows);
      if (rows.length < PAGE_ROWS) break;
    }
    return out;
  },

  async insert<T>(table: RefTable, row: Record<string, unknown>) {
    const res = await run(supabase.from(table).insert(row).select().single());
    if (res.error) throw restError(res.error, res.status);
    return res.data as T;
  },

  async update<T>(table: RefTable, id: string, version: number, patch: Record<string, unknown>) {
    const res = await run(
      supabase.from(table).update(patch).eq('id', id).eq('version', version).select().maybeSingle(),
    );
    if (res.error) throw restError(res.error, res.status);
    if (!res.data) throw new AdminError('conflict', 'stale', 409);
    return res.data as T;
  },

  syncNow: () => syncNow(),
  refreshSettings: () => loadAppSettings(),
  refreshContext: () => refreshContext(),
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
};

let ports: AdminPorts = productionPorts;

/** Tests replace single ports; `resetAdminPorts()` restores the real ones. */
export function setAdminPorts(partial: Partial<AdminPorts>): void {
  ports = { ...productionPorts, ...partial };
}

export function resetAdminPorts(): void {
  ports = productionPorts;
}

export function isOnline(): boolean {
  return ports.online();
}

function requireOnline(): void {
  if (!ports.online()) throw new AdminError('network', 'offline', 0);
}

/** Pulls a change to a synced reference table onto this device; failures stay silent. */
function afterReferenceChange(table: RefTable): void {
  if (!SYNCED_REF_TABLES.has(table)) return;
  void ports.syncNow().catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Users, roles, sessions, devices
// ---------------------------------------------------------------------------------------------

/** Every user the caller administers (hq_admin: all; country_manager: own country). */
export async function listUsers(): Promise<AdminUser[]> {
  requireOnline();
  const data = await ports.rpc<unknown>('admin_users', { p_search: null, p_limit: 5000 });
  return Array.isArray(data) ? (data as AdminUser[]) : [];
}

export async function setRole(
  userId: string,
  role: RoleName,
  scopeType: ScopeType,
  scopeId: string | null,
): Promise<SetRoleResult> {
  requireOnline();
  return ports.rpc<SetRoleResult>('admin_set_role', {
    p_user_id: userId,
    p_role: role,
    p_scope_type: scopeType,
    p_scope_id: scopeType === 'global' ? null : scopeId,
  });
}

export async function removeRole(roleId: string): Promise<RemoveRoleResult> {
  requireOnline();
  return ports.rpc<RemoveRoleResult>('admin_remove_role', { p_role_id: roleId });
}

/** All sessions of a user, or one device (blocked until restored) + all sessions. */
export async function revokeSessions(
  userId: string,
  deviceId: string | null = null,
): Promise<RevokeResult> {
  requireOnline();
  return ports.invoke<RevokeResult>({
    action: 'revoke_sessions',
    user_id: userId,
    ...(deviceId ? { device_id: deviceId } : {}),
  });
}

export async function setUserActive(userId: string, active: boolean): Promise<SetActiveResult> {
  requireOnline();
  return ports.invoke<SetActiveResult>({ action: 'set_user_active', user_id: userId, active });
}

export async function restoreDevice(
  userId: string,
  deviceId: string,
): Promise<RestoreDeviceResult> {
  requireOnline();
  return ports.rpc<RestoreDeviceResult>('admin_restore_device', {
    p_user_id: userId,
    p_device_id: deviceId,
  });
}

/** Provisions an account (Auth user + profile + optional first role) — head office only. */
export async function createUser(input: CreateUserInput): Promise<CreateUserResult> {
  requireOnline();
  const body: Record<string, unknown> = {
    action: 'create_user',
    full_name: input.full_name,
    preferred_language: input.preferred_language,
  };
  if (input.email) body.email = input.email;
  if (input.phone) body.phone = input.phone;
  if (input.role && input.scope_type) {
    body.role = input.role;
    body.scope_type = input.scope_type;
    if (input.scope_type !== 'global' && input.scope_id) body.scope_id = input.scope_id;
  }
  return ports.invoke<CreateUserResult>(body);
}

/** The administrator changed their own grants: re-read the context (capabilities, scope). */
export function refreshOwnContext(): void {
  void ports.refreshContext().catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Sync status board
// ---------------------------------------------------------------------------------------------

export async function loadSyncStatus(): Promise<SyncStatusReport> {
  requireOnline();
  return ports.rpc<SyncStatusReport>('sync_status', {});
}

// ---------------------------------------------------------------------------------------------
// Reference tables (direct DML; RLS: hq_admin only)
// ---------------------------------------------------------------------------------------------

const ORDER: Record<RefTable, Order> = {
  countries: [['name_en', true]],
  branches: [['code', true]],
  option_values: [
    ['list_key', true],
    ['sort_order', true],
    ['code', true],
  ],
  fx_rates: [
    ['currency', true],
    ['effective_date', false],
  ],
  app_settings: [['key', true]],
  map_packs: [['code', true]],
};

/** Every row of a reference table, soft-deleted ones included (they block their codes). */
export async function listRows<T>(table: RefTable): Promise<T[]> {
  requireOnline();
  return ports.select<T>(table, '*', ORDER[table]);
}

export async function insertRow<T>(table: RefTable, row: Record<string, unknown>): Promise<T> {
  requireOnline();
  const created = await ports.insert<T>(table, row);
  afterReferenceChange(table);
  if (table === 'app_settings') void ports.refreshSettings().catch(() => undefined);
  return created;
}

export async function updateRow<T>(
  table: RefTable,
  row: { id: string; version: number },
  patch: Record<string, unknown>,
): Promise<T> {
  requireOnline();
  const updated = await ports.update<T>(table, row.id, row.version, patch);
  afterReferenceChange(table);
  if (table === 'app_settings') void ports.refreshSettings().catch(() => undefined);
  return updated;
}

/** Soft delete (brief §2: deletion is always soft; devices receive the tombstone). */
export function softDeleteRow<T>(
  table: RefTable,
  row: { id: string; version: number },
): Promise<T> {
  return updateRow<T>(table, row, { deleted_at: new Date().toISOString() });
}

export function restoreRow<T>(table: RefTable, row: { id: string; version: number }): Promise<T> {
  return updateRow<T>(table, row, { deleted_at: null });
}

/** Live admin areas of a country straight from the server (the device has none yet). */
export async function fetchAreas<T>(countryId: string): Promise<T[]> {
  requireOnline();
  const rows = await ports.select<T & { deleted_at?: string | null }>(
    'admin_areas',
    'id,country_id,parent_id,level,name_ar,name_en,name_sw,deleted_at',
    [
      ['level', true],
      ['name_en', true],
    ],
    { country_id: countryId },
  );
  return rows.filter((r) => !r.deleted_at);
}
