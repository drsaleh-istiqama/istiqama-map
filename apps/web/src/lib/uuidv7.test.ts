import { beforeEach, describe, expect, it } from 'vitest';
import { __resetUuidv7ForTests, isUuid, uuidv7, uuidv7Timestamp } from './uuidv7';

const V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The 12-bit `rand_a` field, used as the monotonic counter. */
const counterOf = (id: string): number => parseInt(id.slice(15, 18), 16);

beforeEach(() => {
  __resetUuidv7ForTests();
});

describe('uuidv7', () => {
  it('has the RFC 9562 layout: version 7, variant 10, lower-case canonical text', () => {
    for (let i = 0; i < 200; i++) expect(uuidv7()).toMatch(V7_RE);
  });

  it('encodes the Unix time in milliseconds in the first 48 bits', () => {
    // fixed vector: 0x017F22E279B0 ms = 2022-02-22T19:22:22.000Z (RFC 9562 appendix A.6)
    expect(uuidv7(0x017f22e279b0).slice(0, 13)).toBe('017f22e2-79b0');
    const now = 1_759_485_600_123; // 2025-10-03
    const id = uuidv7(now);
    expect(uuidv7Timestamp(id)).toBe(now);
    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(now);
    // a timestamp above 2^32 ms keeps its upper 16 bits
    const far = 0xffff_ffff_ffff;
    expect(uuidv7Timestamp(uuidv7(far))).toBe(far);
  });

  it('uses the current time by default', () => {
    const before = Date.now();
    const ts = uuidv7Timestamp(uuidv7());
    const after = Date.now();
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);
  });

  it('is strictly increasing inside one millisecond', () => {
    const now = 1_700_000_000_000;
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) ids.push(uuidv7(now));
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // the counter advances by one while the millisecond stays the same
    expect(counterOf(ids[1]!)).toBe(counterOf(ids[0]!) + 1);
    expect(uuidv7Timestamp(ids[1]!)).toBe(now);
  });

  it('seeds the counter with 11 random bits on a new millisecond (head room for 2048 ids)', () => {
    for (let ms = 1_700_000_000_000; ms < 1_700_000_000_200; ms++) {
      expect(counterOf(uuidv7(ms))).toBeLessThan(0x800);
    }
  });

  it('moves to the next millisecond when the counter overflows, never backwards', () => {
    const now = 1_700_000_000_000;
    let previous = uuidv7(now);
    let rolled = false;
    for (let i = 0; i < 5000; i++) {
      const id = uuidv7(now);
      expect(id > previous).toBe(true);
      if (uuidv7Timestamp(id)! > now) rolled = true;
      previous = id;
    }
    expect(rolled).toBe(true);
  });

  it('stays monotonic when the wall clock steps backwards', () => {
    const a = uuidv7(1_700_000_005_000);
    const b = uuidv7(1_700_000_000_000); // clock went back five seconds
    const c = uuidv7(1_700_000_004_999);
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
    expect(uuidv7Timestamp(b)).toBe(1_700_000_005_000);
    // once the clock passes the last timestamp it is used again
    const d = uuidv7(1_700_000_005_001);
    expect(uuidv7Timestamp(d)).toBe(1_700_000_005_001);
    expect(d > c).toBe(true);
  });

  it('sorts by creation time as text (the property the outbox and keyset cursors rely on)', () => {
    const ids = [
      uuidv7(1000),
      uuidv7(2000),
      uuidv7(2000),
      uuidv7(70_000_000_000),
      uuidv7(1_800_000_000_000),
    ];
    expect([...ids].sort()).toEqual(ids);
  });

  it('survives a broken clock value', () => {
    expect(uuidv7(Number.NaN)).toMatch(V7_RE);
    expect(uuidv7(-5)).toMatch(V7_RE);
    expect(uuidv7(1234.9)).toMatch(V7_RE);
  });

  it('does not repeat random tails', () => {
    const tails = new Set<string>();
    for (let i = 0; i < 500; i++) tails.add(uuidv7(1_700_000_000_000 + i).slice(19));
    expect(tails.size).toBe(500);
  });
});

describe('isUuid / uuidv7Timestamp', () => {
  it('recognises UUID text of any version', () => {
    expect(isUuid(uuidv7())).toBe(true);
    expect(isUuid('0A000000-0000-4000-8000-00000000000A')).toBe(true);
    expect(isUuid('0a000000-0000-4000-8000-00000000000')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('returns null for other versions', () => {
    expect(uuidv7Timestamp('0a000000-0000-4000-8000-00000000000a')).toBeNull();
    expect(uuidv7Timestamp('garbage')).toBeNull();
  });
});
