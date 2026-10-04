/**
 * Auth-side half of a session revocation (service role).
 *
 * `admin_revoke_sessions` / `admin_set_user_active` kill the ACCESS tokens at once
 * (`profiles.sessions_revoked_at`, checked on every statement). The REFRESH tokens live in
 * GoTrue and must be ended there as well, otherwise a refreshed token gets a new `iat` and
 * passes again (docs/contracts/authz.md §7, people-admin.md §6).
 *
 * GoTrue has no "sign out user X" admin endpoint (`auth.admin.signOut` needs the user's own
 * access token), so the sessions are ended by the first of these that is available:
 *   1. RPC `admin_end_auth_sessions(p_user_id uuid)` — a SECURITY DEFINER SQL function
 *      restricted to the service role that runs `delete from auth.sessions where user_id = $1`
 *      (the portable way; see supabase/functions/README.md for the SQL). The name can be
 *      changed with `AUTH_LOGOUT_RPC`; the value `none` skips this step.
 *   2. `POST /auth/v1/admin/users/{id}/logout` — exists on the local gateway only.
 * When neither exists the outcome says so (`done: false`); the caller reports it and the
 * administrator should deactivate the account (a ban blocks token refresh on every platform).
 */
import { serviceClient, serviceHeaders } from './clients.ts';
import { env, supabaseUrl } from './env.ts';

export interface AuthLogoutOutcome {
  done: boolean;
  method: 'rpc' | 'admin_endpoint' | null;
  /** Why it was not done, for the log and the administrator. */
  detail?: string;
}

export async function endAuthSessions(userId: string): Promise<AuthLogoutOutcome> {
  const notes: string[] = [];

  const rpc = env('AUTH_LOGOUT_RPC') ?? 'admin_end_auth_sessions';
  if (rpc !== 'none') {
    const { error, status } = await serviceClient().rpc(rpc, { p_user_id: userId });
    if (!error) return { done: true, method: 'rpc' };
    // PGRST202: the function is not in the schema cache (not installed) → try the next way.
    notes.push(
      error.code === 'PGRST202' || status === 404
        ? `rpc ${rpc} is not installed`
        : `rpc ${rpc} failed: ${error.message}`,
    );
  }

  try {
    const res = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(userId)}/logout`, {
      method: 'POST',
      headers: serviceHeaders({ 'content-type': 'application/json' }),
      body: '{}',
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return { done: true, method: 'admin_endpoint' };
    notes.push(`admin logout endpoint answered ${res.status}`);
  } catch (e) {
    notes.push(`admin logout endpoint failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { done: false, method: null, detail: notes.join('; ') };
}

export interface AuthBanOutcome {
  done: boolean;
  banned: boolean;
  detail?: string;
}

/**
 * Ban (deactivated account) or unban (reactivated) the Auth user. A banned user cannot sign
 * in and cannot refresh a token — on Supabase and on the local gateway alike.
 */
export async function setAuthBan(userId: string, banned: boolean): Promise<AuthBanOutcome> {
  const { error } = await serviceClient().auth.admin.updateUserById(userId, {
    ban_duration: banned ? '876000h' : 'none', // 100 years, GoTrue's idiom for "until unbanned"
  });
  return error ? { done: false, banned, detail: error.message } : { done: true, banned };
}
