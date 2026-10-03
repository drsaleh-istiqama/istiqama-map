/**
 * /auth/v1 — the subset of the GoTrue API that the application uses (docs/ARCHITECTURE.md
 * Appendix A.6). Request and response shapes follow GoTrue so that @supabase/supabase-js
 * works unchanged.
 */
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseGoDuration } from '../config.ts';
import { isConnectionError, sqlState, withTx } from '../db.ts';
import { HttpError, clientIp, header, readJson, sendEmpty, sendJson } from '../http.ts';
import { bearerToken, roleOf, verifyJwt, type Claims } from '../jwt.ts';
import { log } from '../log.ts';
import { qrSvg } from '../qr.ts';
import { base32Decode, generateTotpSecret, otpauthUri, verifyTotp } from '../totp.ts';
import type { Ctx } from '../types.ts';
import { AuthError, errors, sendAuthError } from './errors.ts';
import { rotateRefreshToken, newRefreshToken } from './refresh.ts';
import {
  PgRefreshStore,
  addAmrClaim,
  createSession,
  findSession,
  findUser,
  insertUser,
  isBanned,
  isValidEmail,
  isValidPhone,
  normalizeEmail,
  normalizePhone,
  otpHash,
  sessionResponse,
  upsertIdentity,
  userJson,
  type ClientMeta,
  type Q,
  type UserRow,
} from './store.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Authed {
  claims: Claims;
  user: UserRow;
  sessionId: string | null;
}

const meta = (req: IncomingMessage): ClientMeta => ({
  userAgent: header(req, 'user-agent')?.slice(0, 400) ?? null,
  ip: clientIp(req),
});

function issuer(ctx: Ctx, req: IncomingMessage): string {
  return `http://${header(req, 'host') ?? `127.0.0.1:${ctx.cfg.port}`}/auth/v1`;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await readJson(req);
  } catch (e) {
    if (e instanceof HttpError && e.status === 400) throw errors.badJson();
    throw e;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Bearer JWT of an end user whose session still exists. */
async function requireUser(ctx: Ctx, req: IncomingMessage): Promise<Authed> {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw errors.noAuthorization();
  const v = verifyJwt(token, ctx.cfg.jwtSecret);
  if (!v.ok)
    throw errors.badJwt(
      v.reason === 'expired' ? 'token has invalid claims: token is expired' : v.message,
    );
  const sub = str(v.claims.sub);
  if (!sub || !UUID_RE.test(sub)) throw errors.missingSub();
  const user = await findUser(ctx.db, 'id', sub);
  if (!user) throw errors.userNotFoundFromJwt();
  const sessionId = str(v.claims.session_id) ?? null;
  if (sessionId) {
    const session = UUID_RE.test(sessionId) ? await findSession(ctx.db, sessionId) : null;
    if (!session || session.user_id !== user.id) throw errors.sessionNotFound();
  }
  return { claims: v.claims, user, sessionId };
}

/** Service-role JWT (Authorization header, or the apikey when no Authorization is sent). */
function requireAdmin(ctx: Ctx, req: IncomingMessage): void {
  const token = bearerToken(req.headers.authorization) ?? header(req, 'apikey');
  if (!token) throw errors.noAuthorization();
  const v = verifyJwt(token, ctx.cfg.jwtSecret);
  if (!v.ok) throw errors.badJwt(v.message);
  if (roleOf(v.claims) !== 'service_role') throw errors.notAdmin();
}

function randomOtp(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(crypto.randomInt(0, 10));
  return out;
}

// ---------------------------------------------------------------------------
// POST /otp
// ---------------------------------------------------------------------------
async function handleOtp(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await body(req);
  const rawEmail = str(b.email);
  const rawPhone = str(b.phone);
  if ((rawEmail && rawPhone) || (!rawEmail && !rawPhone))
    throw errors.validation('Only an email address or phone number should be provided');
  const createUser = b.create_user !== false;
  const channel: 'email' | 'sms' = rawEmail ? 'email' : 'sms';
  const identifier = rawEmail ? normalizeEmail(rawEmail) : normalizePhone(rawPhone!);
  if (channel === 'email' && !isValidEmail(identifier))
    throw errors.validation('Unable to validate email address: invalid format');
  if (channel === 'sms' && !isValidPhone(identifier))
    throw errors.validation('Invalid phone number format (E.164 required)');

  const now = new Date();
  let user = await findUser(ctx.db, channel === 'email' ? 'email' : 'phone', identifier);
  if (!user && !createUser) throw errors.otpDisabled();
  if (!user && !ctx.cfg.enableSignup) throw errors.signupDisabled();

  // Per-identifier limits: minimum interval (GoTrue max_frequency) and an hourly ceiling.
  const minInterval = channel === 'email' ? ctx.cfg.otpEmailMinInterval : ctx.cfg.otpSmsMinInterval;
  const tooSoon = (seconds: number): AuthError =>
    channel === 'email' ? errors.emailRateLimit(seconds) : errors.smsRateLimit(seconds);
  if (minInterval > 0) {
    const wait = ctx.limiter.retryAfter(`otp-interval:${identifier}`, 1, minInterval * 1000);
    if (wait > 0) throw tooSoon(Math.ceil(wait / 1000));
  }
  if (!ctx.limiter.take(`otp-hour:${identifier}`, ctx.cfg.otpMaxPerHour, 3_600_000)) {
    throw tooSoon(
      Math.ceil(
        ctx.limiter.retryAfter(`otp-hour:${identifier}`, ctx.cfg.otpMaxPerHour, 3_600_000) / 1000,
      ),
    );
  }
  if (minInterval > 0) ctx.limiter.take(`otp-interval:${identifier}`, 1, minInterval * 1000);

  const fixed = channel === 'sms' ? ctx.cfg.testOtps.get(identifier) : undefined;
  const code = fixed ?? randomOtp(ctx.cfg.otpLength);
  const hash = otpHash(identifier, code);

  await withTx(ctx.db, async (tx) => {
    let userId = user?.id;
    let isNew = false;
    if (!userId) {
      userId = await insertUser(
        tx,
        {
          email: channel === 'email' ? identifier : null,
          phone: channel === 'sms' ? identifier : null,
          userMetadata: obj(b.data) ?? {},
        },
        now,
      );
      isNew = true;
    }
    // GoTrue: first confirmation uses confirmation_token, later e-mail logins the recovery_token.
    const confirmed = channel === 'email' ? !!user?.email_confirmed_at : !!user?.phone_confirmed_at;
    const tokenType =
      channel === 'email' && confirmed && !isNew ? 'recovery_token' : 'confirmation_token';
    await tx.query(
      `insert into auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
       values (gen_random_uuid(), $1::uuid, $2::auth.one_time_token_type, $3, $4, now() at time zone 'utc', now() at time zone 'utc')
       on conflict (user_id, token_type) do update
         set token_hash = excluded.token_hash, relates_to = excluded.relates_to,
             created_at = excluded.created_at, updated_at = excluded.updated_at`,
      [userId, tokenType, hash, identifier],
    );
    if (tokenType === 'recovery_token') {
      await tx.query(
        'update auth.users set recovery_token = $2, recovery_sent_at = $3, updated_at = $3 where id = $1::uuid',
        [userId, hash, now],
      );
    } else {
      await tx.query(
        'update auth.users set confirmation_token = $2, confirmation_sent_at = $3, updated_at = $3 where id = $1::uuid',
        [userId, hash, now],
      );
    }
    user = await findUser(tx, 'id', userId);
  });

  const expiry = channel === 'email' ? ctx.cfg.otpEmailExpiry : ctx.cfg.otpSmsExpiry;
  if (ctx.cfg.otpProvider === 'fake') {
    ctx.otpOutbox.set(identifier, { code, channel, expiresAt: now.getTime() + expiry * 1000 });
    // Development only: with the fake provider the code is "delivered" through the log.
    log('info', 'otp_issued', {
      provider: 'fake',
      channel,
      identifier,
      code,
      expires_in: expiry,
      test_otp: fixed !== undefined,
    });
  } else if (fixed === undefined) {
    await deliverThroughHook(ctx, channel, user!, code, hash);
  }

  if (channel === 'sms')
    sendJson(res, 200, { message_id: fixed !== undefined ? null : crypto.randomUUID() });
  else sendJson(res, 200, {});
}

/** Non-fake providers: hand the code to the `otp-hook` Edge Function (GoTrue "send SMS/e-mail hook" payload). */
async function deliverThroughHook(
  ctx: Ctx,
  channel: 'email' | 'sms',
  user: UserRow,
  code: string,
  hash: string,
): Promise<void> {
  const payload =
    channel === 'sms'
      ? { user: userJson(user), sms: { otp: code } }
      : {
          user: userJson(user),
          email_data: {
            token: code,
            token_hash: hash,
            redirect_to: ctx.cfg.siteUrl,
            email_action_type: 'magiclink',
            site_url: ctx.cfg.siteUrl,
          },
        };
  const response = await ctx.invokeFunction(
    'otp-hook',
    new Request(`http://127.0.0.1:${ctx.cfg.port}/otp-hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.cfg.serviceKey}`,
        'x-otp-provider': ctx.cfg.otpProvider,
      },
      body: JSON.stringify(payload),
    }),
  );
  if (!response || !response.ok) {
    log('error', 'otp_hook_failed', { status: response?.status ?? null, channel });
    throw errors.unexpected(
      channel === 'sms'
        ? 'Unable to send SMS: the otp-hook function failed'
        : 'Error sending magic link email',
    );
  }
}

// ---------------------------------------------------------------------------
// POST /verify
// ---------------------------------------------------------------------------
const EMAIL_TYPES = new Set(['email', 'magiclink', 'signup', 'recovery']);

async function handleVerify(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await body(req);
  const type = str(b.type) ?? '';
  const token = str(b.token);
  const tokenHash = str(b.token_hash);
  const rawEmail = str(b.email);
  const rawPhone = str(b.phone);
  if (!EMAIL_TYPES.has(type) && type !== 'sms') {
    throw errors.validation(
      type
        ? `Verify type "${type}" is not emulated by the local gateway`
        : 'Verify requires a verification type',
    );
  }
  const channel: 'email' | 'sms' = type === 'sms' ? 'sms' : 'email';
  let identifier: string | null = null;
  if (!tokenHash) {
    if (!token) throw errors.validation('Verify requires either a token or a token hash');
    if (channel === 'sms') {
      if (!rawPhone)
        throw errors.validation(
          'Only an email address or phone number should be provided on verify',
        );
      identifier = normalizePhone(rawPhone);
    } else {
      if (!rawEmail)
        throw errors.validation(
          'Only an email address or phone number should be provided on verify',
        );
      identifier = normalizeEmail(rawEmail);
    }
    if (!ctx.limiter.take(`verify:${identifier}`, 30, 300_000)) throw errors.requestRateLimit();
  }

  const now = new Date();
  const expiry = channel === 'email' ? ctx.cfg.otpEmailExpiry : ctx.cfg.otpSmsExpiry;
  const iss = issuer(ctx, req);
  const payload = await withTx(ctx.db, async (tx) => {
    const hash = tokenHash ?? otpHash(identifier!, token!);
    const found = await tx.query<{ id: string; user_id: string; relates_to: string }>(
      `select t.id, t.user_id, t.relates_to
       from auth.one_time_tokens t
       where t.token_hash = $1
         and t.token_type in ('confirmation_token', 'recovery_token')
         and ($2::text is null or t.relates_to = $2)
         and t.updated_at > (now() at time zone 'utc') - make_interval(secs => $3)
       for update`,
      [hash, identifier, expiry],
    );
    const row = found.rows[0];
    if (!row) throw errors.otpExpired();
    const user = await findUser(tx, 'id', row.user_id, { forUpdate: true });
    if (!user) throw errors.otpExpired();
    if (isBanned(user, now)) throw errors.userBanned();

    // One-time: every pending login code of the user dies with a successful verification.
    await tx.query(
      `delete from auth.one_time_tokens where user_id = $1::uuid and token_type in ('confirmation_token', 'recovery_token')`,
      [user.id],
    );
    const viaEmail = row.relates_to.includes('@');
    await tx.query(
      `update auth.users
       set confirmation_token = '', recovery_token = '',
           email_confirmed_at = case when $2 then coalesce(email_confirmed_at, $3) else email_confirmed_at end,
           phone_confirmed_at = case when $2 then phone_confirmed_at else coalesce(phone_confirmed_at, $3) end,
           updated_at = $3
       where id = $1::uuid`,
      [user.id, viaEmail, now],
    );
    await upsertIdentity(
      tx,
      user.id,
      viaEmail ? 'email' : 'phone',
      viaEmail
        ? { sub: user.id, email: row.relates_to, email_verified: true }
        : { sub: user.id, phone: row.relates_to, phone_verified: true },
      now,
    );
    const method = type === 'magiclink' ? 'magiclink' : type === 'recovery' ? 'recovery' : 'otp';
    const s = await createSession(tx, user.id, method, meta(req), now);
    return sessionResponse(tx, ctx.cfg, iss, user.id, s.sessionId, s.refreshToken, now);
  });
  if (identifier) ctx.otpOutbox.delete(identifier);
  sendJson(res, 200, payload);
}

// ---------------------------------------------------------------------------
// POST /token?grant_type=…
// ---------------------------------------------------------------------------
async function handleToken(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const grant = query.get('grant_type');
  if (grant === 'refresh_token') return handleRefresh(ctx, req, res);
  if (grant === 'password') return handlePassword(ctx, req, res);
  throw new AuthError(
    400,
    'invalid_credentials',
    `unsupported_grant_type: grant type "${grant ?? ''}" is not emulated by the local gateway`,
  );
}

async function handleRefresh(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await body(req);
  const presented = str(b.refresh_token);
  if (!presented) throw errors.validation('refresh_token required');
  const now = new Date();
  const iss = issuer(ctx, req);

  // The transaction commits even when reuse is detected (the family revocation must persist).
  const outcome = await withTx(ctx.db, async (tx) => {
    const result = await rotateRefreshToken(new PgRefreshStore(tx), presented, now, {
      reuseIntervalSeconds: ctx.cfg.refreshReuseInterval,
      rotationEnabled: ctx.cfg.refreshRotation,
      newToken: () => newRefreshToken((n) => crypto.randomBytes(n)),
    });
    if (result.kind === 'not_found') return { error: errors.refreshTokenNotFound() };
    if (result.kind === 'already_used') {
      log('warn', 'refresh_token_reuse', {
        session_id: result.previous.session_id,
        family_revoked: result.familyRevoked,
      });
      return { error: errors.refreshTokenAlreadyUsed() };
    }
    const sessionId = result.token.session_id;
    const session = sessionId ? await findSession(tx, sessionId) : null;
    if (!session) throw errors.refreshTokenNotFound();
    if (session.not_after && session.not_after.getTime() < now.getTime())
      throw errors.sessionExpired();
    const user = await findUser(tx, 'id', session.user_id);
    if (!user) throw errors.refreshTokenNotFound();
    if (isBanned(user, now)) throw errors.userBanned();
    const m = meta(req);
    await tx.query(
      `update auth.sessions set refreshed_at = now() at time zone 'utc', updated_at = $2, user_agent = coalesce($3, user_agent), ip = coalesce($4::inet, ip)
       where id = $1::uuid`,
      [session.id, now, m.userAgent, m.ip],
    );
    return {
      payload: await sessionResponse(
        tx,
        ctx.cfg,
        iss,
        user.id,
        session.id,
        result.token.token,
        now,
      ),
    };
  });
  if ('error' in outcome && outcome.error) throw outcome.error;
  sendJson(res, 200, outcome.payload);
}

async function handlePassword(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await body(req);
  const password = str(b.password);
  const rawEmail = str(b.email);
  const rawPhone = str(b.phone);
  if (!password || (!rawEmail && !rawPhone)) throw errors.invalidCredentials();
  const identifier = rawEmail ? normalizeEmail(rawEmail) : normalizePhone(rawPhone!);
  if (!ctx.limiter.take(`password:${identifier}`, 30, 300_000)) throw errors.requestRateLimit();
  const now = new Date();
  const iss = issuer(ctx, req);
  const payload = await withTx(ctx.db, async (tx) => {
    const match = await tx.query<{ id: string }>(
      `select id from auth.users
       where ${rawEmail ? 'email = $1 and is_sso_user = false' : 'phone = $1'}
         and deleted_at is null
         and coalesce(encrypted_password, '') <> ''
         and encrypted_password = extensions.crypt($2, encrypted_password)`,
      [identifier, password],
    );
    const id = match.rows[0]?.id;
    if (!id) throw errors.invalidCredentials();
    const user = (await findUser(tx, 'id', id))!;
    if (isBanned(user, now)) throw errors.userBanned();
    if (rawEmail && !user.email_confirmed_at) throw errors.emailNotConfirmed();
    if (!rawEmail && !user.phone_confirmed_at) throw errors.phoneNotConfirmed();
    const s = await createSession(tx, user.id, 'password', meta(req), now);
    return sessionResponse(tx, ctx.cfg, iss, user.id, s.sessionId, s.refreshToken, now);
  });
  sendJson(res, 200, payload);
}

// ---------------------------------------------------------------------------
// GET/PUT /user, POST /logout
// ---------------------------------------------------------------------------
async function handleGetUser(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { user } = await requireUser(ctx, req);
  sendJson(res, 200, userJson(user));
}

async function handlePutUser(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { user } = await requireUser(ctx, req);
  const b = await body(req);
  const now = new Date();
  const updated = await withTx(ctx.db, (tx) => applyUserUpdate(tx, user, b, now, false));
  sendJson(res, 200, userJson(updated));
}

/** Shared by PUT /user (self-service) and PUT /admin/users/:id. */
async function applyUserUpdate(
  tx: Q,
  user: UserRow,
  b: Record<string, unknown>,
  now: Date,
  admin: boolean,
): Promise<UserRow> {
  const sets: string[] = ['updated_at = $2'];
  const args: unknown[] = [user.id, now];
  const add = (sql: string, value: unknown): void => {
    args.push(value);
    sets.push(sql.replace('?', `$${args.length}`));
  };

  const password = str(b.password);
  if (password !== undefined) {
    if (password.length < 6) throw errors.weakPassword();
    add(`encrypted_password = extensions.crypt(?, extensions.gen_salt('bf', 10))`, password);
  }
  const email = str(b.email);
  if (email !== undefined) {
    const e = normalizeEmail(email);
    if (!isValidEmail(e))
      throw errors.validation('Unable to validate email address: invalid format');
    if (e !== user.email) {
      const other = await findUser(tx, 'email', e);
      if (other && other.id !== user.id) throw errors.emailExists();
      add('email = ?', e);
      // Local stack runs with auto-confirmation (supabase/config.toml enable_confirmations = false).
      if (!admin || b.email_confirm !== false) sets.push('email_confirmed_at = $2');
      await upsertIdentity(
        tx,
        user.id,
        'email',
        { sub: user.id, email: e, email_verified: true },
        now,
      );
    }
  }
  const phone = str(b.phone);
  if (phone !== undefined) {
    const p = normalizePhone(phone);
    if (!isValidPhone(p)) throw errors.validation('Invalid phone number format (E.164 required)');
    if (p !== user.phone) {
      const other = await findUser(tx, 'phone', p);
      if (other && other.id !== user.id) throw errors.phoneExists();
      add('phone = ?', p);
      if (!admin || b.phone_confirm !== false) sets.push('phone_confirmed_at = $2');
      await upsertIdentity(
        tx,
        user.id,
        'phone',
        { sub: user.id, phone: p, phone_verified: true },
        now,
      );
    }
  }
  // user metadata: `data` on PUT /user, `user_metadata` on the admin API. Keys set to null are removed.
  const userMeta = obj(admin ? b.user_metadata : b.data);
  if (userMeta)
    add(
      `raw_user_meta_data = jsonb_strip_nulls(coalesce(raw_user_meta_data, '{}'::jsonb) || ?::jsonb)`,
      JSON.stringify(userMeta),
    );
  if (admin) {
    const appMeta = obj(b.app_metadata);
    if (appMeta)
      add(
        `raw_app_meta_data = jsonb_strip_nulls(coalesce(raw_app_meta_data, '{}'::jsonb) || ?::jsonb)`,
        JSON.stringify(appMeta),
      );
    if (b.email_confirm === true && email === undefined)
      sets.push('email_confirmed_at = coalesce(email_confirmed_at, $2)');
    if (b.phone_confirm === true && phone === undefined)
      sets.push('phone_confirmed_at = coalesce(phone_confirmed_at, $2)');
    const role = str(b.role);
    if (role !== undefined) add('role = ?', role);
    const ban = str(b.ban_duration);
    if (ban !== undefined) {
      if (ban === 'none') sets.push('banned_until = null');
      else {
        const seconds = parseGoDuration(ban);
        if (seconds === null)
          throw errors.validation(
            `invalid format for ban duration: time: invalid duration "${ban}"`,
          );
        add('banned_until = ?', new Date(now.getTime() + seconds * 1000));
      }
    }
  }
  try {
    await tx.query(`update auth.users set ${sets.join(', ')} where id = $1::uuid`, args);
  } catch (e) {
    if (sqlState(e) === '23505')
      throw email !== undefined ? errors.emailExists() : errors.phoneExists();
    throw e;
  }
  return (await findUser(tx, 'id', user.id))!;
}

async function handleLogout(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const scope = query.get('scope') ?? 'global';
  if (!['global', 'local', 'others'].includes(scope))
    throw errors.validation(`Unsupported logout scope "${scope}"`);
  const { user, sessionId } = await requireUser(ctx, req);
  // Refresh tokens and AMR claims go with the sessions (ON DELETE CASCADE).
  if (scope === 'global')
    await ctx.db.query('delete from auth.sessions where user_id = $1::uuid', [user.id]);
  else if (scope === 'local') {
    if (sessionId) await ctx.db.query('delete from auth.sessions where id = $1::uuid', [sessionId]);
  } else {
    await ctx.db.query(
      'delete from auth.sessions where user_id = $1::uuid and ($2::uuid is null or id <> $2::uuid)',
      [user.id, sessionId],
    );
  }
  sendEmpty(res, 204);
}

// ---------------------------------------------------------------------------
// MFA (TOTP)
// ---------------------------------------------------------------------------
interface FactorRow {
  id: string;
  user_id: string;
  friendly_name: string | null;
  factor_type: string;
  status: 'verified' | 'unverified';
  secret: string | null;
  created_at: Date;
}

async function findFactor(q: Q, userId: string, factorId: string): Promise<FactorRow> {
  if (!UUID_RE.test(factorId)) throw errors.factorNotFound();
  const r = await q.query<FactorRow>(
    'select id, user_id, friendly_name, factor_type::text, status::text, secret, created_at from auth.mfa_factors where id = $1::uuid and user_id = $2::uuid',
    [factorId, userId],
  );
  if (!r.rows[0]) throw errors.factorNotFound();
  return r.rows[0];
}

async function sessionAal(ctx: Ctx, sessionId: string | null): Promise<string> {
  if (!sessionId) return 'aal1';
  return (await findSession(ctx.db, sessionId))?.aal ?? 'aal1';
}

async function handleEnroll(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { user, sessionId } = await requireUser(ctx, req);
  const b = await body(req);
  const factorType = str(b.factor_type);
  if (factorType !== 'totp')
    throw errors.validation(
      'factor_type needs to be totp (phone and webauthn factors are not emulated by the local gateway)',
    );
  const friendlyName = str(b.friendly_name) ?? '';
  const now = new Date();

  // GoTrue drops enrolments that were never verified after the factor expiry (5 minutes).
  await ctx.db.query(
    `delete from auth.mfa_factors where user_id = $1::uuid and status = 'unverified' and created_at < $2`,
    [user.id, new Date(now.getTime() - 300_000)],
  );
  const existing = await ctx.db.query<{ status: string; friendly_name: string | null }>(
    'select status::text, friendly_name from auth.mfa_factors where user_id = $1::uuid',
    [user.id],
  );
  const verified = existing.rows.filter((f) => f.status === 'verified').length;
  if (existing.rows.length >= ctx.cfg.mfaMaxEnrolledFactors) throw errors.tooManyFactors();
  if (verified > 0 && (await sessionAal(ctx, sessionId)) !== 'aal2')
    throw errors.insufficientAal('AAL2 required to enroll a new factor');
  if (friendlyName && existing.rows.some((f) => f.friendly_name === friendlyName))
    throw errors.factorNameConflict(friendlyName);

  let siteHost = 'localhost';
  try {
    siteHost = new URL(ctx.cfg.siteUrl).host;
  } catch {
    /* keep default */
  }
  const issuerName = str(b.issuer) ?? siteHost;
  const secret = generateTotpSecret();
  const uri = otpauthUri(issuerName, user.email || user.phone || user.id, secret);
  const id = crypto.randomUUID();
  try {
    await ctx.db.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
       values ($1, $2::uuid, $3, 'totp', 'unverified', $4, $4, $5)`,
      [id, user.id, friendlyName || null, now, secret],
    );
  } catch (e) {
    if (sqlState(e) === '23505') throw errors.factorNameConflict(friendlyName);
    throw e;
  }
  sendJson(res, 200, {
    id,
    type: 'totp',
    friendly_name: friendlyName || undefined,
    totp: { qr_code: qrSvg(uri), secret, uri },
  });
}

async function handleChallenge(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  factorId: string,
): Promise<void> {
  const { user } = await requireUser(ctx, req);
  const factor = await findFactor(ctx.db, user.id, factorId);
  const now = new Date();
  const id = crypto.randomUUID();
  await ctx.db.query(
    'insert into auth.mfa_challenges (id, factor_id, created_at, ip_address) values ($1, $2::uuid, $3, $4::inet)',
    [id, factor.id, now, clientIp(req)],
  );
  await ctx.db.query(
    'update auth.mfa_factors set last_challenged_at = $2, updated_at = $2 where id = $1::uuid',
    [factor.id, now],
  );
  sendJson(res, 200, {
    id,
    type: factor.factor_type,
    expires_at: Math.floor(now.getTime() / 1000) + ctx.cfg.mfaChallengeExpiry,
  });
}

async function handleMfaVerify(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  factorId: string,
): Promise<void> {
  const { user, sessionId } = await requireUser(ctx, req);
  if (!sessionId) throw errors.sessionNotFound();
  const b = await body(req);
  const challengeId = str(b.challenge_id);
  const code = str(b.code);
  if (!challengeId || !UUID_RE.test(challengeId))
    throw errors.validation('challenge_id is required');
  if (!code) throw errors.validation('code is required');
  const factor = await findFactor(ctx.db, user.id, factorId);
  if (!ctx.limiter.take(`mfa:${factor.id}`, 30, 300_000)) throw errors.requestRateLimit();

  const now = new Date();
  const ch = await ctx.db.query<{ id: string; created_at: Date; verified_at: Date | null }>(
    'select id, created_at, verified_at from auth.mfa_challenges where id = $1::uuid and factor_id = $2::uuid',
    [challengeId, factor.id],
  );
  const challenge = ch.rows[0];
  if (!challenge)
    throw errors.factorNotFound('MFA factor with the provided challenge ID not found');
  if (
    challenge.verified_at ||
    challenge.created_at.getTime() + ctx.cfg.mfaChallengeExpiry * 1000 < now.getTime()
  ) {
    await ctx.db.query('delete from auth.mfa_challenges where id = $1::uuid', [challenge.id]);
    throw errors.challengeExpired(challenge.id);
  }
  if (
    !factor.secret ||
    !verifyTotp(base32Decode(factor.secret), code, now.getTime() / 1000, { skew: 1 })
  ) {
    throw errors.mfaVerificationFailed();
  }

  const iss = issuer(ctx, req);
  const payload = await withTx(ctx.db, async (tx) => {
    await tx.query('update auth.mfa_challenges set verified_at = $2 where id = $1::uuid', [
      challenge.id,
      now,
    ]);
    await tx.query(
      `update auth.mfa_factors set status = 'verified', updated_at = $2 where id = $1::uuid`,
      [factor.id, now],
    );
    await tx.query(
      `update auth.sessions set aal = 'aal2', factor_id = $2::uuid, updated_at = $3 where id = $1::uuid`,
      [sessionId, factor.id, now],
    );
    await addAmrClaim(tx, sessionId, 'totp', now);
    // The session continues with a fresh refresh token (GoTrue swaps it on every AAL change).
    const store = new PgRefreshStore(tx);
    const active = await store.findActiveToken(sessionId);
    if (active) await store.revokeToken(active.id, now);
    const next = await store.insertToken(
      {
        token: newRefreshToken((n) => crypto.randomBytes(n)),
        user_id: user.id,
        session_id: sessionId,
        parent: active?.token ?? null,
      },
      now,
    );
    // Abandoned enrolments and every other session that has not passed MFA are dropped.
    await tx.query(
      `delete from auth.mfa_factors where user_id = $1::uuid and status = 'unverified' and id <> $2::uuid`,
      [user.id, factor.id],
    );
    await tx.query(
      `delete from auth.sessions where user_id = $1::uuid and id <> $2::uuid and coalesce(aal::text, 'aal1') < 'aal2'`,
      [user.id, sessionId],
    );
    return sessionResponse(tx, ctx.cfg, iss, user.id, sessionId, next.token, now);
  });
  sendJson(res, 200, payload);
}

async function handleUnenroll(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  factorId: string,
): Promise<void> {
  const { user, sessionId } = await requireUser(ctx, req);
  const factor = await findFactor(ctx.db, user.id, factorId);
  if (factor.status === 'verified' && (await sessionAal(ctx, sessionId)) !== 'aal2') {
    throw new AuthError(422, 'insufficient_aal', 'AAL2 required to unenroll verified factor');
  }
  await withTx(ctx.db, (tx) => deleteFactor(tx, factor.id));
  sendJson(res, 200, { id: factor.id });
}

/** Removes a factor and downgrades the sessions that were elevated with it (GoTrue DowngradeSessionsToAAL1). */
async function deleteFactor(tx: Q, factorId: string): Promise<void> {
  await tx.query(
    `delete from auth.mfa_amr_claims c using auth.sessions s
     where c.session_id = s.id and s.factor_id = $1::uuid and c.authentication_method = 'totp'`,
    [factorId],
  );
  await tx.query(
    `update auth.sessions set aal = 'aal1', factor_id = null where factor_id = $1::uuid`,
    [factorId],
  );
  await tx.query('delete from auth.mfa_factors where id = $1::uuid', [factorId]);
}

// ---------------------------------------------------------------------------
// Admin API (service role)
// ---------------------------------------------------------------------------
async function adminCreateUser(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const b = await body(req);
  const email = str(b.email) ? normalizeEmail(str(b.email)!) : null;
  const phone = str(b.phone) ? normalizePhone(str(b.phone)!) : null;
  if (!email && !phone)
    throw errors.validation('Cannot create a user without either an email or phone');
  if (email && !isValidEmail(email))
    throw errors.validation('Unable to validate email address: invalid format');
  if (phone && !isValidPhone(phone))
    throw errors.validation('Invalid phone number format (E.164 required)');
  const id = str(b.id);
  if (id !== undefined && !UUID_RE.test(id))
    throw errors.validation('ID must conform to the uuid v4 format');
  const password = str(b.password);
  const now = new Date();
  let bannedUntil: Date | null = null;
  const ban = str(b.ban_duration);
  if (ban !== undefined && ban !== 'none') {
    const seconds = parseGoDuration(ban);
    if (seconds === null)
      throw errors.validation(`invalid format for ban duration: time: invalid duration "${ban}"`);
    bannedUntil = new Date(now.getTime() + seconds * 1000);
  }
  const created = await withTx(ctx.db, async (tx) => {
    if (email && (await findUser(tx, 'email', email))) throw errors.emailExists();
    if (phone && (await findUser(tx, 'phone', phone))) throw errors.phoneExists();
    try {
      const newId = await insertUser(
        tx,
        {
          id,
          email,
          phone,
          password: password ?? null,
          emailConfirmed: b.email_confirm === true,
          phoneConfirmed: b.phone_confirm === true,
          userMetadata: obj(b.user_metadata) ?? {},
          appMetadata: obj(b.app_metadata) ?? {},
          role: str(b.role),
          bannedUntil,
        },
        now,
      );
      return (await findUser(tx, 'id', newId))!;
    } catch (e) {
      if (sqlState(e) === '23505') throw email ? errors.emailExists() : errors.phoneExists();
      throw e;
    }
  });
  sendJson(res, 200, userJson(created));
}

async function adminListUsers(
  ctx: Ctx,
  _req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const page = Math.max(1, Number(query.get('page')) || 1);
  const perPage = Math.min(1000, Math.max(1, Number(query.get('per_page')) || 50));
  const total = Number(
    (
      await ctx.db.query<{ n: string }>(
        'select count(*) as n from auth.users where deleted_at is null',
      )
    ).rows[0]!.n,
  );
  const ids = await ctx.db.query<{ id: string }>(
    'select id from auth.users where deleted_at is null order by created_at asc nulls last, id asc limit $1 offset $2',
    [perPage, (page - 1) * perPage],
  );
  const users: Record<string, unknown>[] = [];
  for (const { id } of ids.rows) {
    const u = await findUser(ctx.db, 'id', id);
    if (u) users.push(userJson(u));
  }
  const last = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  if (page < last) links.push(`</admin/users?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  links.push(`</admin/users?page=${last}&per_page=${perPage}>; rel="last"`);
  sendJson(
    res,
    200,
    { users, aud: 'authenticated' },
    { 'x-total-count': total, link: links.join(', ') },
  );
}

async function adminUser(ctx: Ctx, id: string): Promise<UserRow> {
  if (!UUID_RE.test(id)) throw errors.validation('user_id must be an UUID');
  const u = await findUser(ctx.db, 'id', id);
  if (!u) throw errors.userNotFound();
  return u;
}

async function adminDeleteUser(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const user = await adminUser(ctx, id);
  const b = await body(req);
  if (b.should_soft_delete === true) {
    const now = new Date();
    await withTx(ctx.db, async (tx) => {
      await tx.query('delete from auth.sessions where user_id = $1::uuid', [user.id]);
      await tx.query('delete from auth.identities where user_id = $1::uuid', [user.id]);
      await tx.query(
        `update auth.users
         set deleted_at = $2, updated_at = $2, encrypted_password = '',
             email = case when email is null then null else encode(extensions.digest(email, 'sha256'), 'hex') end,
             phone = case when phone is null then null else encode(extensions.digest(phone, 'sha256'), 'hex') end,
             raw_user_meta_data = '{}'::jsonb, raw_app_meta_data = '{}'::jsonb,
             confirmation_token = '', recovery_token = ''
         where id = $1::uuid`,
        [user.id, now],
      );
    });
  } else {
    try {
      await ctx.db.query('delete from auth.users where id = $1::uuid', [user.id]);
    } catch (e) {
      // Rows of the application still reference the user (no ON DELETE CASCADE).
      if (sqlState(e) === '23503') throw errors.unexpected('Database error deleting user');
      throw e;
    }
  }
  sendJson(res, 200, {});
}

async function handleAdmin(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  query: URLSearchParams,
): Promise<void> {
  requireAdmin(ctx, req);
  const method = req.method ?? 'GET';
  // parts: ['admin', 'users', id?, sub?, subId?]
  if (parts[1] !== 'users') throw errors.notEmulated(`/admin/${parts[1] ?? ''}`);
  const id = parts[2];
  if (id === undefined) {
    if (method === 'POST') return adminCreateUser(ctx, req, res);
    if (method === 'GET') return adminListUsers(ctx, req, res, query);
  } else if (parts[3] === undefined) {
    if (method === 'GET') return sendJson(res, 200, userJson(await adminUser(ctx, id)));
    if (method === 'PUT') {
      const user = await adminUser(ctx, id);
      const b = await body(req);
      const updated = await withTx(ctx.db, (tx) => applyUserUpdate(tx, user, b, new Date(), true));
      return sendJson(res, 200, userJson(updated));
    }
    if (method === 'DELETE') return adminDeleteUser(ctx, req, res, id);
  } else if (parts[3] === 'logout' && method === 'POST') {
    // LOCAL EXTENSION (not part of GoTrue): end every session of a user by id.
    const user = await adminUser(ctx, id);
    await ctx.db.query('delete from auth.sessions where user_id = $1::uuid', [user.id]);
    return sendEmpty(res, 204);
  } else if (parts[3] === 'factors') {
    const user = await adminUser(ctx, id);
    if (parts[4] === undefined && method === 'GET') return sendJson(res, 200, user.factors);
    if (parts[4] !== undefined && method === 'DELETE') {
      const factor = await findFactor(ctx.db, user.id, parts[4]);
      await withTx(ctx.db, (tx) => deleteFactor(tx, factor.id));
      return sendJson(res, 200, { id: factor.id });
    }
  }
  throw errors.notEmulated(`${method} /${parts.join('/')}`);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export async function handleAuth(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string,
  queryString: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const parts = subPath.split('/').filter(Boolean);
  const query = new URLSearchParams(queryString);
  const route = parts[0] ?? '';
  try {
    if (route === 'otp' && method === 'POST') return await handleOtp(ctx, req, res);
    if (route === 'verify' && method === 'POST') return await handleVerify(ctx, req, res);
    if (route === 'token' && method === 'POST') return await handleToken(ctx, req, res, query);
    if (route === 'user' && parts.length === 1 && method === 'GET')
      return await handleGetUser(ctx, req, res);
    if (route === 'user' && parts.length === 1 && method === 'PUT')
      return await handlePutUser(ctx, req, res);
    if (route === 'logout' && method === 'POST') return await handleLogout(ctx, req, res, query);
    if (route === 'factors') {
      if (parts.length === 1 && method === 'POST') return await handleEnroll(ctx, req, res);
      if (parts.length === 3 && parts[2] === 'challenge' && method === 'POST')
        return await handleChallenge(ctx, req, res, parts[1]!);
      if (parts.length === 3 && parts[2] === 'verify' && method === 'POST')
        return await handleMfaVerify(ctx, req, res, parts[1]!);
      if (parts.length === 2 && method === 'DELETE')
        return await handleUnenroll(ctx, req, res, parts[1]!);
    }
    if (route === 'admin') return await handleAdmin(ctx, req, res, parts, query);
    if (route === 'health' && method === 'GET') {
      return sendJson(res, 200, {
        version: 'local-gateway',
        name: 'GoTrue',
        description: 'GoTrue is a user registration and authentication API',
      });
    }
    if (route === 'settings' && method === 'GET') {
      return sendJson(res, 200, {
        external: { email: true, phone: true, anonymous_users: false },
        disable_signup: !ctx.cfg.enableSignup,
        mailer_autoconfirm: true,
        phone_autoconfirm: true,
        sms_provider: ctx.cfg.otpProvider,
        mfa_enabled: true,
        saml_enabled: false,
      });
    }
    if (route === 'signup' && method === 'POST' && !ctx.cfg.enableSignup)
      throw errors.signupDisabled();
    throw errors.notEmulated(`${method} /auth/v1/${parts.join('/')}`);
  } catch (e) {
    if (e instanceof AuthError) return sendAuthError(req, res, e);
    if (e instanceof HttpError)
      return sendAuthError(
        req,
        res,
        new AuthError(e.status, e.status === 413 ? 'validation_failed' : 'bad_json', e.message),
      );
    // Database trouble must look retryable (5xx): supabase-js then keeps the session.
    const status = isConnectionError(e) ? 503 : 500;
    log('error', 'auth_error', {
      route: `${method} /auth/v1/${route}`,
      error: e instanceof Error ? e.message : String(e),
    });
    return sendAuthError(
      req,
      res,
      new AuthError(
        status,
        'unexpected_failure',
        status === 503
          ? 'Database is not reachable'
          : 'Unexpected failure, please check server logs for more information',
      ),
    );
  }
}
