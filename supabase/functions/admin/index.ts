/**
 * admin — administration actions that need the Auth admin API next to an admin RPC
 * (docs/contracts/people-admin.md §6).
 *
 *   POST { "action": "revoke_sessions", "user_id": "…", "device_id"?: "…" }
 *   POST { "action": "set_user_active", "user_id": "…", "active": true | false }
 *   POST { "action": "restore_device",  "user_id": "…", "device_id": "…" }
 *   POST { "action": "set_role",        "user_id": "…", "role": "…", "scope_type": "…", "scope_id"?: "…" }
 *   POST { "action": "remove_role",     "role_id": "…" }
 *   POST { "action": "create_user",     "email"?: "…", "phone"?: "+255…", "full_name": "…",
 *          "preferred_language"?: "ar", "role"?: "…", "scope_type"?: "…", "scope_id"?: "…" }
 *
 * Authorisation is the database's: every action first calls its admin RPC (or, for
 * `create_user`, `my_context()`) WITH THE CALLER's JWT. Only when that succeeded is the
 * service role used, and only for the Auth half:
 *   - `auth_logout_required` in the RPC result → end the user's Auth sessions (refresh tokens);
 *   - `set_user_active` → ban / unban the Auth user, so that a deactivated account can
 *     neither sign in nor refresh;
 *   - `create_user` → create the Auth user (self sign-up is disabled).
 * The response is the RPC result plus `auth_logout` / `auth_ban` describing that half.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireUser } from '../_shared/auth.ts';
import { endAuthSessions, setAuthBan } from '../_shared/authAdmin.ts';
import { serviceClient, userClient, withRetry } from '../_shared/clients.ts';
import { serveIfEntryPoint } from '../_shared/env.ts';
import { createHandler, errors, isRecord, isUuid, json, readJson, unwrap } from '../_shared/http.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

type Body = Record<string, unknown>;
type RpcResult = Record<string, unknown>;

function uuid(body: Body, key: string): string {
  const v = body[key];
  if (!isUuid(v)) throw errors.validation('invalid_argument', `${key} must be a UUID.`);
  return v;
}

function optionalString(body: Body, key: string, max = 200): string | null {
  const v = body[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max)
    throw errors.validation('invalid_argument', `${key} must be a string.`);
  return v;
}

function requiredString(body: Body, key: string, max = 200): string {
  const v = optionalString(body, key, max);
  if (v === null || v.trim() === '') throw errors.validation('invalid_argument', `${key} is required.`);
  return v.trim();
}

/** The admin RPCs are idempotent, so a transient failure may be retried. */
async function adminRpc(user: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  return unwrap<RpcResult>(await withRetry<RpcResult>(() => user.rpc(fn, args)));
}

async function withAuthLogout(result: RpcResult, userId: string): Promise<RpcResult> {
  if (result.auth_logout_required !== true) return result;
  const outcome = await endAuthSessions(userId);
  if (!outcome.done)
    console.error(`[admin] refresh tokens of ${userId} were NOT revoked: ${outcome.detail ?? ''}`);
  return { ...result, auth_logout: outcome };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

async function createUser(user: SupabaseClient, body: Body): Promise<Response> {
  // Only the head office (hq_admin at aal2) provisions accounts; the profile insert below is
  // additionally guarded by RLS (`profiles_insert_hq`) because it runs with the caller's JWT.
  const ctx = unwrap<{ capabilities?: { is_hq?: boolean }; mfa_required?: boolean }>(
    await withRetry(() => user.rpc('my_context')),
  );
  if (ctx.capabilities?.is_hq !== true)
    throw errors.forbidden(ctx.mfa_required ? 'mfa_required' : 'forbidden');

  const email = optionalString(body, 'email', 254)?.trim().toLowerCase() ?? null;
  const phone = optionalString(body, 'phone', 20)?.replace(/[\s-]/g, '') ?? null;
  if (!email && !phone) throw errors.validation('invalid_argument', 'email or phone is required.');
  if (email && !EMAIL_RE.test(email)) throw errors.validation('invalid_argument', 'email is not valid.');
  if (phone && !PHONE_RE.test(phone))
    throw errors.validation('invalid_argument', 'phone must be in E.164 form (+255…).');
  const fullName = requiredString(body, 'full_name');
  const language = optionalString(body, 'preferred_language', 5) ?? 'ar';
  if (!['ar', 'sw', 'en'].includes(language))
    throw errors.validation('invalid_argument', 'preferred_language must be "ar", "sw" or "en".');
  const role = optionalString(body, 'role', 40);
  const scopeType = optionalString(body, 'scope_type', 20);
  const scopeId = optionalString(body, 'scope_id', 64);
  if (role && !scopeType) throw errors.validation('invalid_argument', 'scope_type is required with role.');
  if (scopeId && !isUuid(scopeId)) throw errors.validation('invalid_argument', 'scope_id must be a UUID.');

  const svc = serviceClient();
  const created = await svc.auth.admin.createUser({
    ...(email ? { email, email_confirm: true } : {}),
    ...(phone ? { phone, phone_confirm: true } : {}),
    user_metadata: { full_name: fullName },
  });
  if (created.error || !created.data.user) {
    const code = created.error?.code ?? '';
    if (code === 'email_exists' || code === 'phone_exists' || created.error?.status === 422)
      throw errors.conflict('user_exists', created.error?.message);
    throw errors.upstream('auth_error', created.error?.message);
  }
  const id = created.data.user.id;

  const profile = await user
    .from('profiles')
    .upsert({ id, full_name: fullName, phone, preferred_language: language }, { onConflict: 'id' })
    .select('id, full_name, phone, preferred_language, active')
    .single();
  if (profile.error) {
    // No profile → the account would be unusable: take the Auth user back.
    await svc.auth.admin.deleteUser(id).catch(() => undefined);
    unwrap(profile);
  }

  let grant: RpcResult | null = null;
  let roleError: unknown = null;
  if (role) {
    const res = await withRetry<RpcResult>(() =>
      user.rpc('admin_set_role', { p_user_id: id, p_role: role, p_scope_type: scopeType, p_scope_id: scopeId }),
    );
    if (res.error) roleError = { code: res.error.code, message: res.error.message, details: res.error.details ?? null };
    else grant = res.data;
  }
  return json({ user_id: id, email, phone, profile: profile.data, role: grant, role_error: roleError }, 201);
}

export const handler = createHandler('admin', ['POST'], async (req) => {
  const caller = await requireUser(req);
  // The RPCs allow 120 admin writes per minute; this only sheds bursts earlier.
  enforceRateLimit('admin', caller.userId, 120);
  const body = await readJson(req, 64 * 1024);
  if (!isRecord(body) || typeof body.action !== 'string')
    throw errors.validation('invalid_action', 'Send { "action": "…" }.');
  const user = userClient(req);

  switch (body.action) {
    case 'revoke_sessions': {
      const userId = uuid(body, 'user_id');
      const result = await adminRpc(user, 'admin_revoke_sessions', {
        p_user_id: userId,
        p_device_id: optionalString(body, 'device_id', 128),
      });
      return json(await withAuthLogout(result, userId));
    }
    case 'set_user_active': {
      const userId = uuid(body, 'user_id');
      if (typeof body.active !== 'boolean')
        throw errors.validation('invalid_argument', 'active must be true or false.');
      const result = await adminRpc(user, 'admin_set_user_active', { p_user_id: userId, p_active: body.active });
      const withLogout = await withAuthLogout(result, userId);
      // Deactivated accounts are banned in Auth as well (no sign-in, no token refresh);
      // reactivation lifts the ban.
      const ban = await setAuthBan(userId, !body.active);
      if (!ban.done) console.error(`[admin] auth ban of ${userId} not updated: ${ban.detail ?? ''}`);
      return json({ ...withLogout, auth_ban: ban });
    }
    case 'restore_device':
      return json(
        await adminRpc(user, 'admin_restore_device', {
          p_user_id: uuid(body, 'user_id'),
          p_device_id: requiredString(body, 'device_id', 128),
        }),
      );
    case 'set_role': {
      const scopeId = optionalString(body, 'scope_id', 64);
      if (scopeId !== null && !isUuid(scopeId))
        throw errors.validation('invalid_argument', 'scope_id must be a UUID.');
      return json(
        await adminRpc(user, 'admin_set_role', {
          p_user_id: uuid(body, 'user_id'),
          p_role: requiredString(body, 'role', 40),
          p_scope_type: requiredString(body, 'scope_type', 20),
          p_scope_id: scopeId,
        }),
      );
    }
    case 'remove_role':
      return json(await adminRpc(user, 'admin_remove_role', { p_role_id: uuid(body, 'role_id') }));
    case 'create_user':
      return createUser(user, body);
    default:
      throw errors.validation('invalid_action', `Unknown action "${body.action}".`);
  }
});

export default handler;
serveIfEntryPoint(import.meta, handler);
