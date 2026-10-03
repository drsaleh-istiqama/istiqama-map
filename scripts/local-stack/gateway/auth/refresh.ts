/**
 * Refresh-token rotation with reuse detection — the same decision tree as GoTrue
 * (internal/api/token_refresh.go):
 *
 *   unknown token                         → not_found
 *   active token                          → revoke it, issue a child (rotated)
 *   revoked token, parent of the session's
 *     currently active token              → hand back that active token again (the client
 *                                           lost the previous response; nothing is issued)
 *   revoked token inside the reuse window,
 *     session still has an active token   → issue another child (concurrent refreshes)
 *   any other revoked token               → revoke the whole session family, already_used
 *
 * The logic is written against a small store interface so that it can be unit-tested
 * without a database; `PgRefreshStore` in store.ts is the real implementation.
 */
export interface RefreshTokenRow {
  id: number;
  token: string;
  user_id: string;
  session_id: string | null;
  revoked: boolean;
  parent: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RefreshStore {
  /** Must lock the row for the rest of the transaction (SELECT … FOR UPDATE). */
  findToken(token: string): Promise<RefreshTokenRow | null>;
  /** Newest non-revoked token of the session. */
  findActiveToken(sessionId: string): Promise<RefreshTokenRow | null>;
  revokeToken(id: number, now: Date): Promise<void>;
  insertToken(
    row: { token: string; user_id: string; session_id: string | null; parent: string | null },
    now: Date,
  ): Promise<RefreshTokenRow>;
  /** Revoke every token of the session (or of the parent chain when there is no session). Returns the number revoked. */
  revokeFamily(token: RefreshTokenRow, now: Date): Promise<number>;
}

export interface RotateOptions {
  reuseIntervalSeconds: number;
  rotationEnabled: boolean;
  newToken: () => string;
}

export type RotateResult =
  | { kind: 'rotated'; token: RefreshTokenRow; previous: RefreshTokenRow }
  | { kind: 'reused_active'; token: RefreshTokenRow; previous: RefreshTokenRow }
  | { kind: 'not_found' }
  | { kind: 'already_used'; familyRevoked: boolean; previous: RefreshTokenRow };

export async function rotateRefreshToken(
  store: RefreshStore,
  presented: string,
  now: Date,
  opts: RotateOptions,
): Promise<RotateResult> {
  const token = await store.findToken(presented);
  if (!token) return { kind: 'not_found' };

  if (token.revoked) {
    const active = token.session_id ? await store.findActiveToken(token.session_id) : null;
    if (active && active.parent === token.token) {
      return { kind: 'reused_active', token: active, previous: token };
    }
    const reuseUntil = token.updated_at.getTime() + opts.reuseIntervalSeconds * 1000;
    // Stricter than GoTrue in one corner: once a family has been revoked (the session has no
    // active token left) nothing can be exchanged any more, not even inside the reuse window.
    if (now.getTime() > reuseUntil || !active) {
      let familyRevoked = false;
      if (opts.rotationEnabled) {
        await store.revokeFamily(token, now);
        familyRevoked = true;
      }
      return { kind: 'already_used', familyRevoked, previous: token };
    }
  } else {
    await store.revokeToken(token.id, now);
  }

  const issued = await store.insertToken(
    {
      token: opts.newToken(),
      user_id: token.user_id,
      session_id: token.session_id,
      parent: token.token,
    },
    now,
  );
  return { kind: 'rotated', token: issued, previous: token };
}

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 12 random characters, like GoTrue v2 refresh tokens. `randomBytes` is injectable for tests. */
export function newRefreshToken(randomBytes: (n: number) => Uint8Array): string {
  let out = '';
  while (out.length < 12) {
    for (const b of randomBytes(24)) {
      // rejection sampling keeps the distribution uniform (252 = 7 * 36)
      if (b < 252 && out.length < 12) out += TOKEN_ALPHABET[b % 36];
    }
  }
  return out;
}
