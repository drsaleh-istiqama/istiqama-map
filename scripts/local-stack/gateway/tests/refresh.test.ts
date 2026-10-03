import { describe, expect, it } from 'vitest';
import {
  newRefreshToken,
  rotateRefreshToken,
  type RefreshStore,
  type RefreshTokenRow,
  type RotateOptions,
} from '../auth/refresh.ts';

/** In-memory stand-in for auth.refresh_tokens. */
class MemoryStore implements RefreshStore {
  rows: RefreshTokenRow[] = [];
  private seq = 0;

  seed(token: string, sessionId: string | null, at: Date): RefreshTokenRow {
    const row: RefreshTokenRow = {
      id: ++this.seq,
      token,
      user_id: 'user-1',
      session_id: sessionId,
      revoked: false,
      parent: null,
      created_at: at,
      updated_at: at,
    };
    this.rows.push(row);
    return row;
  }
  async findToken(token: string): Promise<RefreshTokenRow | null> {
    return this.rows.find((r) => r.token === token) ?? null;
  }
  async findActiveToken(sessionId: string): Promise<RefreshTokenRow | null> {
    return [...this.rows].reverse().find((r) => r.session_id === sessionId && !r.revoked) ?? null;
  }
  async revokeToken(id: number, now: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id)!;
    row.revoked = true;
    row.updated_at = now;
  }
  async insertToken(
    row: { token: string; user_id: string; session_id: string | null; parent: string | null },
    now: Date,
  ): Promise<RefreshTokenRow> {
    const created: RefreshTokenRow = {
      id: ++this.seq,
      ...row,
      revoked: false,
      created_at: now,
      updated_at: now,
    };
    this.rows.push(created);
    return created;
  }
  async revokeFamily(token: RefreshTokenRow, now: Date): Promise<number> {
    let n = 0;
    for (const r of this.rows) {
      if (r.session_id === token.session_id && !r.revoked) {
        r.revoked = true;
        r.updated_at = now;
        n++;
      }
    }
    return n;
  }
}

let counter = 0;
const opts: RotateOptions = {
  reuseIntervalSeconds: 10,
  rotationEnabled: true,
  newToken: () => `tok-${++counter}`,
};
const t = (seconds: number): Date => new Date(1_700_000_000_000 + seconds * 1000);

describe('refresh-token rotation', () => {
  it('rotates an active token: the old one is revoked, the new one is its child', async () => {
    const store = new MemoryStore();
    store.seed('A', 's1', t(0));
    const r = await rotateRefreshToken(store, 'A', t(60), opts);
    expect(r.kind).toBe('rotated');
    if (r.kind !== 'rotated') return;
    expect(r.token.parent).toBe('A');
    expect(r.token.session_id).toBe('s1');
    expect(r.token.revoked).toBe(false);
    expect((await store.findToken('A'))!.revoked).toBe(true);
    expect((await store.findActiveToken('s1'))!.token).toBe(r.token.token);
  });

  it('unknown token → not_found', async () => {
    expect((await rotateRefreshToken(new MemoryStore(), 'nope', t(0), opts)).kind).toBe(
      'not_found',
    );
  });

  it('re-sending the just-rotated token returns the active child and issues nothing', async () => {
    const store = new MemoryStore();
    store.seed('A', 's1', t(0));
    const first = await rotateRefreshToken(store, 'A', t(60), opts);
    const before = store.rows.length;
    // even long after the reuse interval: the client simply never received the response
    const second = await rotateRefreshToken(store, 'A', t(3600), opts);
    expect(second.kind).toBe('reused_active');
    if (first.kind === 'rotated' && second.kind === 'reused_active')
      expect(second.token.token).toBe(first.token.token);
    expect(store.rows.length).toBe(before);
  });

  it('a revoked token inside the reuse interval may be exchanged again while the session is alive', async () => {
    const store = new MemoryStore();
    store.seed('A', 's1', t(0));
    const b = await rotateRefreshToken(store, 'A', t(60), opts); // A → B
    if (b.kind !== 'rotated') throw new Error('unexpected');
    await rotateRefreshToken(store, b.token.token, t(62), opts); // B → C (A is no longer the parent of the active token)
    const late = await rotateRefreshToken(store, 'A', t(65), opts); // 5 s after A was revoked
    expect(late.kind).toBe('rotated');
    if (late.kind === 'rotated') expect(late.token.parent).toBe('A');
  });

  it('reuse outside the interval revokes the whole session family', async () => {
    const store = new MemoryStore();
    store.seed('A', 's1', t(0));
    store.seed('X', 's2', t(0)); // another session of the same user
    const b = await rotateRefreshToken(store, 'A', t(60), opts);
    if (b.kind !== 'rotated') throw new Error('unexpected');
    const c = await rotateRefreshToken(store, b.token.token, t(120), opts);
    if (c.kind !== 'rotated') throw new Error('unexpected');

    const attack = await rotateRefreshToken(store, 'A', t(500), opts);
    expect(attack).toMatchObject({ kind: 'already_used', familyRevoked: true });
    expect(store.rows.filter((r) => r.session_id === 's1').every((r) => r.revoked)).toBe(true);
    // other sessions are untouched
    expect((await store.findActiveToken('s2'))!.token).toBe('X');

    // the legitimate holder of the newest token is signed out too — even immediately
    const victim = await rotateRefreshToken(store, c.token.token, t(501), opts);
    expect(victim.kind).toBe('already_used');
    expect(await store.findActiveToken('s1')).toBeNull();
  });

  it('with rotation disabled reuse is reported but the family survives', async () => {
    const store = new MemoryStore();
    store.seed('A', 's1', t(0));
    const b = await rotateRefreshToken(store, 'A', t(60), opts);
    if (b.kind !== 'rotated') throw new Error('unexpected');
    await rotateRefreshToken(store, b.token.token, t(120), opts);
    const r = await rotateRefreshToken(store, 'A', t(500), { ...opts, rotationEnabled: false });
    expect(r).toMatchObject({ kind: 'already_used', familyRevoked: false });
    expect(await store.findActiveToken('s1')).not.toBeNull();
  });

  it('reuse interval 0 means any second use outside the parent rule is an attack', async () => {
    const store = new MemoryStore();
    store.seed('A', 's1', t(0));
    const b = await rotateRefreshToken(store, 'A', t(60), { ...opts, reuseIntervalSeconds: 0 });
    if (b.kind !== 'rotated') throw new Error('unexpected');
    await rotateRefreshToken(store, b.token.token, t(61), { ...opts, reuseIntervalSeconds: 0 });
    const r = await rotateRefreshToken(store, 'A', t(62), { ...opts, reuseIntervalSeconds: 0 });
    expect(r.kind).toBe('already_used');
  });
});

describe('newRefreshToken', () => {
  it('is 12 characters of [a-z0-9], like GoTrue v2 tokens', () => {
    const bytes = (n: number): Uint8Array =>
      Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);
    expect(newRefreshToken(bytes)).toMatch(/^[a-z0-9]{12}$/);
  });

  it('skips bytes that would bias the distribution', () => {
    let call = 0;
    const bytes = (n: number): Uint8Array =>
      call++ === 0 ? new Uint8Array(n).fill(255) : new Uint8Array(n).fill(0);
    expect(newRefreshToken(bytes)).toBe('aaaaaaaaaaaa');
    expect(call).toBe(2);
  });
});
