/** SQL access to the GoTrue tables of the `auth` schema (see supabase-shim.sql). */
import crypto from 'node:crypto';
import type pg from 'pg';
import type { GatewayConfig } from '../config.ts';
import { buildAccessClaims, signJwt, type AmrEntry } from '../jwt.ts';
import { newRefreshToken, type RefreshStore, type RefreshTokenRow } from './refresh.ts';

/** Anything that can run a query: the pool or a transaction client. */
export type Q = Pick<pg.ClientBase, 'query'> | pg.Pool;

export interface FactorJson {
  id: string;
  friendly_name?: string | null;
  factor_type: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  aud: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  email_confirmed_at: Date | null;
  phone_confirmed_at: Date | null;
  confirmed_at: Date | null;
  confirmation_sent_at: Date | null;
  recovery_sent_at: Date | null;
  last_sign_in_at: Date | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  created_at: Date | null;
  updated_at: Date | null;
  banned_until: Date | null;
  deleted_at: Date | null;
  is_anonymous: boolean;
  factors: FactorJson[];
  identities: Record<string, unknown>[];
}

const USER_SELECT = `
  select u.id, u.aud, u.role, u.email, u.phone, u.email_confirmed_at, u.phone_confirmed_at, u.confirmed_at,
         u.confirmation_sent_at, u.recovery_sent_at, u.last_sign_in_at, u.raw_app_meta_data, u.raw_user_meta_data,
         u.created_at, u.updated_at, u.banned_until, u.deleted_at, u.is_anonymous,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'id', f.id, 'friendly_name', f.friendly_name, 'factor_type', f.factor_type, 'status', f.status,
                    'created_at', f.created_at, 'updated_at', f.updated_at) order by f.created_at)
           from auth.mfa_factors f where f.user_id = u.id), '[]'::jsonb) as factors,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'identity_id', i.id, 'id', i.provider_id, 'user_id', i.user_id, 'identity_data', i.identity_data,
                    'provider', i.provider, 'last_sign_in_at', i.last_sign_in_at, 'created_at', i.created_at,
                    'updated_at', i.updated_at, 'email', i.email) order by i.created_at)
           from auth.identities i where i.user_id = u.id), '[]'::jsonb) as identities
  from auth.users u`;

export type UserKey = 'id' | 'email' | 'phone';

export async function findUser(
  q: Q,
  key: UserKey,
  value: string,
  opts: { forUpdate?: boolean } = {},
): Promise<UserRow | null> {
  const where =
    key === 'id'
      ? 'u.id = $1::uuid'
      : key === 'email'
        ? 'u.email = $1 and u.is_sso_user = false'
        : 'u.phone = $1';
  const res = await q.query<UserRow>(
    `${USER_SELECT} where ${where} and u.deleted_at is null${opts.forUpdate ? ' for update of u' : ''}`,
    [value],
  );
  return res.rows[0] ?? null;
}

const iso = (d: Date | null | undefined): string | undefined => (d ? d.toISOString() : undefined);

/** The user object exactly as GoTrue serialises it (absent timestamps are omitted). */
export function userJson(u: UserRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: u.id,
    aud: u.aud ?? 'authenticated',
    role: u.role ?? 'authenticated',
    email: u.email ?? '',
  };
  const put = (k: string, v: unknown): void => {
    if (v !== undefined && v !== null) out[k] = v;
  };
  put('email_confirmed_at', iso(u.email_confirmed_at));
  out.phone = u.phone ?? '';
  put('phone_confirmed_at', iso(u.phone_confirmed_at));
  put('confirmation_sent_at', iso(u.confirmation_sent_at));
  put('confirmed_at', iso(u.confirmed_at));
  put('recovery_sent_at', iso(u.recovery_sent_at));
  put('last_sign_in_at', iso(u.last_sign_in_at));
  out.app_metadata = u.raw_app_meta_data ?? {};
  out.user_metadata = u.raw_user_meta_data ?? {};
  if (u.factors.length) out.factors = u.factors;
  out.identities = u.identities;
  put('created_at', iso(u.created_at));
  put('updated_at', iso(u.updated_at));
  put('banned_until', iso(u.banned_until));
  out.is_anonymous = u.is_anonymous;
  return out;
}

export function isBanned(u: UserRow, now: Date): boolean {
  return u.banned_until !== null && u.banned_until.getTime() > now.getTime();
}

/** GoTrue: lower-cased, trimmed e-mail; phone without "+" and spaces. */
export function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}
export function normalizePhone(v: string): string {
  return v.replace(/[\s()-]/g, '').replace(/^\+/, '');
}
export function isValidEmail(v: string): boolean {
  return v.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
export function isValidPhone(v: string): boolean {
  return /^[1-9]\d{6,14}$/.test(v);
}

/** GoTrue crypto.GenerateTokenHash: hex(sha224(emailOrPhone + otp)). */
export function otpHash(identifier: string, code: string): string {
  return crypto
    .createHash('sha224')
    .update(identifier + code)
    .digest('hex');
}

export interface NewUser {
  id?: string;
  email?: string | null;
  phone?: string | null;
  password?: string | null;
  emailConfirmed?: boolean;
  phoneConfirmed?: boolean;
  userMetadata?: Record<string, unknown>;
  appMetadata?: Record<string, unknown>;
  role?: string;
  bannedUntil?: Date | null;
}

export async function insertUser(q: Q, u: NewUser, now: Date): Promise<string> {
  const id = u.id ?? crypto.randomUUID();
  const provider = u.email ? 'email' : 'phone';
  const providers = [...(u.email ? ['email'] : []), ...(u.phone ? ['phone'] : [])];
  const appMeta = { provider, providers, ...(u.appMetadata ?? {}) };
  await q.query(
    `insert into auth.users
       (instance_id, id, aud, role, email, phone, encrypted_password, email_confirmed_at, phone_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at, banned_until, is_anonymous, is_sso_user)
     values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', $2, $3, $4,
        case when $5::text is null then '' else extensions.crypt($5::text, extensions.gen_salt('bf', 10)) end,
        $6, $7, $8, $9, $10, $10, $11, false, false)`,
    [
      id,
      u.role || 'authenticated',
      u.email ?? null,
      u.phone ?? null,
      u.password ?? null,
      u.email && u.emailConfirmed ? now : null,
      u.phone && u.phoneConfirmed ? now : null,
      JSON.stringify(appMeta),
      JSON.stringify(u.userMetadata ?? {}),
      now,
      u.bannedUntil ?? null,
    ],
  );
  if (u.email)
    await upsertIdentity(
      q,
      id,
      'email',
      { sub: id, email: u.email, email_verified: !!u.emailConfirmed, phone_verified: false },
      now,
    );
  if (u.phone)
    await upsertIdentity(
      q,
      id,
      'phone',
      { sub: id, phone: u.phone, email_verified: false, phone_verified: !!u.phoneConfirmed },
      now,
    );
  return id;
}

export async function upsertIdentity(
  q: Q,
  userId: string,
  provider: 'email' | 'phone',
  data: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await q.query(
    `insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values (gen_random_uuid(), ($1::uuid)::text, $1::uuid, $2, $3, $4, $4, $4)
     on conflict (provider_id, provider) do update
       set identity_data = auth.identities.identity_data || excluded.identity_data, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(data), provider, now],
  );
}

export interface SessionRow {
  id: string;
  user_id: string;
  aal: 'aal1' | 'aal2' | 'aal3' | null;
  factor_id: string | null;
  not_after: Date | null;
  created_at: Date | null;
}

export async function findSession(q: Q, id: string): Promise<SessionRow | null> {
  const res = await q.query<SessionRow>(
    'select id, user_id, aal, factor_id, not_after, created_at from auth.sessions where id = $1::uuid',
    [id],
  );
  return res.rows[0] ?? null;
}

export async function sessionAmr(q: Q, sessionId: string): Promise<AmrEntry[]> {
  const res = await q.query<{ method: string; ts: string }>(
    `select authentication_method as method, floor(extract(epoch from updated_at))::bigint as ts
     from auth.mfa_amr_claims where session_id = $1::uuid order by updated_at desc`,
    [sessionId],
  );
  return res.rows.map((r) => ({ method: r.method, timestamp: Number(r.ts) }));
}

export async function addAmrClaim(
  q: Q,
  sessionId: string,
  method: string,
  now: Date,
): Promise<void> {
  await q.query(
    `insert into auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
     values (gen_random_uuid(), $1::uuid, $2, $2, $3)
     on conflict (session_id, authentication_method) do update set updated_at = excluded.updated_at`,
    [sessionId, now, method],
  );
}

export interface ClientMeta {
  userAgent: string | null;
  ip: string | null;
}

/** New session (aal1) + its first refresh token + AMR claim; stamps last_sign_in_at. */
export async function createSession(
  q: Q,
  userId: string,
  method: string,
  meta: ClientMeta,
  now: Date,
): Promise<{ sessionId: string; refreshToken: string }> {
  const sessionId = crypto.randomUUID();
  await q.query(
    `insert into auth.sessions (id, user_id, created_at, updated_at, aal, user_agent, ip)
     values ($1, $2::uuid, $3, $3, 'aal1', $4, $5::inet)`,
    [sessionId, userId, now, meta.userAgent, meta.ip],
  );
  await addAmrClaim(q, sessionId, method, now);
  const refreshToken = newRefreshToken((n) => crypto.randomBytes(n));
  await q.query(
    `insert into auth.refresh_tokens (instance_id, token, user_id, session_id, revoked, parent, created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', $1, $2, $3::uuid, false, null, $4, $4)`,
    [refreshToken, userId, sessionId, now],
  );
  await q.query('update auth.users set last_sign_in_at = $2, updated_at = $2 where id = $1::uuid', [
    userId,
    now,
  ]);
  return { sessionId, refreshToken };
}

/** The GoTrue session payload: `{access_token, token_type, expires_in, expires_at, refresh_token, user}`. */
export async function sessionResponse(
  q: Q,
  cfg: GatewayConfig,
  issuer: string,
  userId: string,
  sessionId: string,
  refreshToken: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const user = await findUser(q, 'id', userId);
  const session = await findSession(q, sessionId);
  if (!user || !session) throw new Error('session or user vanished while issuing a token');
  const amr = await sessionAmr(q, sessionId);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const claims = buildAccessClaims({
    issuer,
    userId: user.id,
    aud: user.aud ?? 'authenticated',
    role: user.role ?? 'authenticated',
    email: user.email,
    phone: user.phone,
    appMetadata: user.raw_app_meta_data ?? {},
    userMetadata: user.raw_user_meta_data ?? {},
    sessionId,
    aal: session.aal === 'aal2' ? 'aal2' : 'aal1',
    amr,
    isAnonymous: user.is_anonymous,
    nowSeconds,
    expiresIn: cfg.jwtExpiry,
  });
  return {
    access_token: signJwt(claims as unknown as Record<string, unknown>, cfg.jwtSecret),
    token_type: 'bearer',
    expires_in: cfg.jwtExpiry,
    expires_at: nowSeconds + cfg.jwtExpiry,
    refresh_token: refreshToken,
    user: userJson(user),
  };
}

/** RefreshStore backed by auth.refresh_tokens; use inside a transaction. */
export class PgRefreshStore implements RefreshStore {
  constructor(private q: Q) {}

  private static COLS =
    'id::int as id, token, user_id, session_id, coalesce(revoked, false) as revoked, parent, created_at, updated_at';

  async findToken(token: string): Promise<RefreshTokenRow | null> {
    const res = await this.q.query<RefreshTokenRow>(
      `select ${PgRefreshStore.COLS} from auth.refresh_tokens where token = $1 for update`,
      [token],
    );
    return res.rows[0] ?? null;
  }

  async findActiveToken(sessionId: string): Promise<RefreshTokenRow | null> {
    const res = await this.q.query<RefreshTokenRow>(
      `select ${PgRefreshStore.COLS} from auth.refresh_tokens
       where session_id = $1::uuid and revoked is not true order by id desc limit 1`,
      [sessionId],
    );
    return res.rows[0] ?? null;
  }

  async revokeToken(id: number, now: Date): Promise<void> {
    await this.q.query(
      'update auth.refresh_tokens set revoked = true, updated_at = $2 where id = $1',
      [id, now],
    );
  }

  async insertToken(
    row: { token: string; user_id: string; session_id: string | null; parent: string | null },
    now: Date,
  ): Promise<RefreshTokenRow> {
    const res = await this.q.query<RefreshTokenRow>(
      `insert into auth.refresh_tokens (instance_id, token, user_id, session_id, revoked, parent, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, $2, $3::uuid, false, $4, $5, $5)
       returning ${PgRefreshStore.COLS}`,
      [row.token, row.user_id, row.session_id, row.parent, now],
    );
    return res.rows[0]!;
  }

  async revokeFamily(token: RefreshTokenRow, now: Date): Promise<number> {
    if (token.session_id) {
      const res = await this.q.query(
        'update auth.refresh_tokens set revoked = true, updated_at = $2 where session_id = $1::uuid and revoked is not true',
        [token.session_id, now],
      );
      return res.rowCount ?? 0;
    }
    const res = await this.q.query(
      `with recursive family as (
         select id, token from auth.refresh_tokens where token = $1
         union
         select r.id, r.token from auth.refresh_tokens r join family f on r.parent = f.token
       )
       update auth.refresh_tokens r set revoked = true, updated_at = $2
       from family f where r.id = f.id and r.revoked is not true`,
      [token.token, now],
    );
    return res.rowCount ?? 0;
  }
}
