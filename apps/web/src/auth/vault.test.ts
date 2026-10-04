import { describe, expect, it, vi } from 'vitest';
import { PBKDF2_MIN_ITERATIONS } from './crypto';
import { AuthFlowError } from './errors';
import { MAX_PIN_FAILURES, Vault, isValidPin, isWeakPin, retryDelayMs } from './vault';

const KEY = 'istiqama-auth';
const PIN = '4071';
const ACCESS = 'eyJhbGciOiJIUzI1NiJ9.ACCESS-TOKEN-PAYLOAD.signature';
const REFRESH = 'REFRESH-0u20m998iaz5';
const EMAIL = 'collector.pemba@example.org';

function sessionJson(refresh = REFRESH, access = ACCESS): string {
  return JSON.stringify({
    access_token: access,
    refresh_token: refresh,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 1_791_044_010,
    user: { id: 'user-1', email: EMAIL },
  });
}

let sequence = 0;

function makeVault(dbName = `vault-test-${++sequence}-${Math.random().toString(36).slice(2)}`) {
  const clock = { now: 1_800_000_000_000 };
  const vault = new Vault({ sessionKey: KEY, dbName, now: () => clock.now });
  return { vault, clock, dbName };
}

/** A vault with a session and a PIN, as after the first sign-in. */
async function makeProtectedVault() {
  const made = makeVault();
  await made.vault.storage.setItem(KEY, sessionJson());
  await made.vault.setPin(PIN);
  return made;
}

/** Everything the vault wrote to IndexedDB (keys, strings, raw bytes) as one searchable text. */
async function storedText(vault: Vault): Promise<string> {
  const chunks: string[] = [];
  const visit = (value: unknown): void => {
    if (value instanceof ArrayBuffer) chunks.push(new TextDecoder('latin1').decode(value));
    else if (ArrayBuffer.isView(value)) chunks.push(new TextDecoder('latin1').decode(value));
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit);
    else chunks.push(String(value));
  };
  for (const entry of await vault.dump()) {
    chunks.push(entry.key);
    visit(entry.value);
  }
  return chunks.join('\n');
}

function expectNoPlaintext(text: string): void {
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain(REFRESH);
  expect(text).not.toContain('access_token');
  expect(text).not.toContain('refresh_token');
  expect(text).not.toContain(EMAIL);
}

describe('PIN rules', () => {
  it('accepts 4 to 8 digits only', () => {
    expect(isValidPin('4071')).toBe(true);
    expect(isValidPin('73915382')).toBe(true);
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('123456789')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('')).toBe(false);
  });

  it('flags the PINs everybody tries first', () => {
    for (const weak of [
      '0000',
      '1111',
      '777777',
      '1234',
      '0123',
      '7890',
      '4321',
      '9876',
      '1212',
      '696969',
      '2580',
    ]) {
      expect(isWeakPin(weak), weak).toBe(true);
    }
    for (const fine of ['4071', '739153', '8642', '1357', '20417']) {
      expect(isWeakPin(fine), fine).toBe(false);
    }
  });

  it('doubles the wait after every failure', () => {
    expect(retryDelayMs(0)).toBe(0);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(retryDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000,
    ]);
  });
});

describe('vault as supabase-js storage', () => {
  it('keeps the session in memory only until a PIN exists', async () => {
    const { vault } = makeVault();
    await vault.storage.setItem(KEY, sessionJson());
    expect(vault.storage.getItem(KEY)).toBe(sessionJson());
    expect(await vault.dump()).toEqual([]);
    expect(await vault.isSet()).toBe(false);
    expect(vault.locked.value).toBe(false);
  });

  it('never writes plaintext tokens: only salt, IV and ciphertext reach IndexedDB', async () => {
    const { vault } = await makeProtectedVault();
    const dump = await vault.dump();
    expect(dump.map((entry) => entry.key)).toEqual(['vault']);
    const record = dump[0]!.value as {
      salt: Uint8Array;
      iv: Uint8Array;
      iterations: number;
      data: ArrayBuffer;
    };
    expect(record.salt).toHaveLength(16);
    expect(record.iv).toHaveLength(12);
    expect(record.iterations).toBeGreaterThanOrEqual(PBKDF2_MIN_ITERATIONS);
    expect(record.data.byteLength).toBeGreaterThan(sessionJson().length);
    expectNoPlaintext(await storedText(vault));
  });

  it('keeps later writes encrypted too (token rotation, cached context)', async () => {
    const { vault } = await makeProtectedVault();
    await vault.storage.setItem(KEY, sessionJson('REFRESH-rotated-777', `${ACCESS}-rotated`));
    await vault.setExtra('me', {
      user_id: 'user-1',
      profile: { full_name: 'Collector One', phone: '+255700000001' },
    });
    await vault.flush();
    const text = await storedText(vault);
    expectNoPlaintext(text);
    expect(text).not.toContain('REFRESH-rotated-777');
    expect(text).not.toContain('Collector One');
    expect(text).not.toContain('+255700000001');
  });

  it('round-trips through lock and unlock', async () => {
    const { vault } = await makeProtectedVault();
    await vault.setExtra('me', { user_id: 'user-1' });
    const seen: Array<string | null> = [];
    vault.subscribe((key, value) => {
      if (key === KEY) seen.push(value);
    });

    vault.lock();
    expect(vault.locked.value).toBe(true);
    expect(vault.storage.getItem(KEY)).toBeNull();
    expect(vault.getExtra('me')).toBeUndefined();
    expect(vault.isUnlocked()).toBe(false);
    expect(seen).toEqual([null]);

    expect(await vault.unlock(PIN)).toBe('ok');
    expect(vault.locked.value).toBe(false);
    expect(vault.storage.getItem(KEY)).toBe(sessionJson());
    expect(vault.getExtra('me')).toEqual({ user_id: 'user-1' });
    expect(seen).toEqual([null, sessionJson()]);
  });

  it('starts locked after a restart and unlocks from disk alone', async () => {
    const { vault, dbName } = await makeProtectedVault();
    await vault.storage.setItem(KEY, sessionJson('REFRESH-latest'));
    await vault.flush();
    await vault.close();

    const { vault: restarted } = makeVault(dbName);
    expect(restarted.locked.value).toBe(true); // fail closed before the store was even read
    await restarted.init();
    expect(restarted.locked.value).toBe(true);
    expect(restarted.pinSet.value).toBe(true);
    expect(restarted.storage.getItem(KEY)).toBeNull();
    expect(await restarted.unlock(PIN)).toBe('ok');
    expect(restarted.storage.getItem(KEY)).toBe(sessionJson('REFRESH-latest'));
  });

  it('drops writes that arrive while locked', async () => {
    const { vault } = await makeProtectedVault();
    vault.lock();
    await vault.storage.setItem(KEY, sessionJson('REFRESH-late-answer'));
    expect(vault.storage.getItem(KEY)).toBeNull();
    expect(vault.locked.value).toBe(true);
    expect(await vault.unlock(PIN)).toBe('ok');
    expect(vault.storage.getItem(KEY)).toBe(sessionJson());
  });

  it('lets an explicit new sign-in replace a locked vault (new PIN needed)', async () => {
    const { vault } = await makeProtectedVault();
    vault.lock();
    vault.expectFreshSignIn();
    await vault.storage.setItem(KEY, sessionJson('REFRESH-new-sign-in'));
    expect(vault.locked.value).toBe(false);
    expect(vault.pinSet.value).toBe(false);
    expect(vault.storage.getItem(KEY)).toBe(sessionJson('REFRESH-new-sign-in'));
    expect(await vault.dump()).toEqual([]);
    expect(await vault.unlock(PIN)).toBe('no_vault');
  });

  it('removing the session destroys the vault', async () => {
    const { vault } = await makeProtectedVault();
    const seen: Array<string | null> = [];
    vault.subscribe((_key, value) => seen.push(value));
    await vault.storage.removeItem(KEY);
    expect(seen).toEqual([null]);
    expect(await vault.dump()).toEqual([]);
    expect(vault.pinSet.value).toBe(false);
    expect(vault.locked.value).toBe(false);
    expect(vault.storage.getItem(KEY)).toBeNull();
  });

  it('locking without a PIN simply forgets the in-memory session', async () => {
    const { vault } = makeVault();
    await vault.storage.setItem(KEY, sessionJson());
    vault.lock();
    expect(vault.storage.getItem(KEY)).toBeNull();
    expect(vault.locked.value).toBe(false);
    expect(await vault.dump()).toEqual([]);
  });

  it('adopts a session rotated by another tab only when it already holds one', async () => {
    const { vault } = makeVault();
    vault.adoptExternal(KEY, sessionJson('REFRESH-other-tab'));
    expect(vault.storage.getItem(KEY)).toBeNull();

    await vault.storage.setItem(KEY, sessionJson());
    await vault.setPin(PIN);
    vault.adoptExternal(KEY, sessionJson('REFRESH-other-tab'));
    expect(vault.storage.getItem(KEY)).toBe(sessionJson('REFRESH-other-tab'));

    vault.lock();
    vault.adoptExternal(KEY, sessionJson('REFRESH-while-locked'));
    expect(vault.storage.getItem(KEY)).toBeNull();
  });
});

describe('choosing and changing the PIN', () => {
  it('rejects malformed and guessable PINs and needs a session', async () => {
    const { vault } = makeVault();
    await expect(vault.setPin(PIN)).rejects.toMatchObject({ kind: 'no_session' });
    await vault.storage.setItem(KEY, sessionJson());
    await expect(vault.setPin('12a4')).rejects.toMatchObject({ kind: 'pin_invalid' });
    await expect(vault.setPin('123')).rejects.toMatchObject({ kind: 'pin_invalid' });
    await expect(vault.setPin('1234')).rejects.toMatchObject({ kind: 'pin_weak' });
    await expect(vault.setPin('0000')).rejects.toBeInstanceOf(AuthFlowError);
    expect(await vault.isSet()).toBe(false);
    expect(await vault.dump()).toEqual([]);
  });

  it('cannot be changed while locked', async () => {
    const { vault } = await makeProtectedVault();
    vault.lock();
    await expect(vault.setPin('8642')).rejects.toMatchObject({ kind: 'pin_locked' });
  });

  it('re-encrypts under the new PIN; the old one stops working', async () => {
    const { vault, clock } = await makeProtectedVault();
    await vault.setPin('8642');
    vault.lock();
    expect(await vault.unlock(PIN)).toBe('wrong');
    clock.now += 1000;
    expect(await vault.unlock('8642')).toBe('ok');
    expect(vault.storage.getItem(KEY)).toBe(sessionJson());
  });

  it('verifies the PIN while unlocked (before a change) and counts failures', async () => {
    const { vault, clock } = await makeProtectedVault();
    expect(await vault.unlock('5555')).toBe('wrong');
    expect(vault.attempts.value.failures).toBe(1);
    expect(vault.storage.getItem(KEY)).toBe(sessionJson()); // still unlocked
    clock.now += 1000;
    expect(await vault.unlock(PIN)).toBe('ok');
    expect(vault.attempts.value.failures).toBe(0);
  });
});

describe('wrong PIN: throttling and wipe', () => {
  it('counts a failure, then refuses to try again before the delay has passed', async () => {
    const { vault, clock } = await makeProtectedVault();
    vault.lock();
    expect(await vault.unlock('9999')).toBe('wrong');
    expect(vault.attempts.value).toEqual({ failures: 1, retryAt: clock.now + 1000 });

    // Too early: not even the right PIN is tried, and nothing is counted.
    clock.now += 999;
    expect(await vault.unlock(PIN)).toBe('throttled');
    expect(vault.locked.value).toBe(true);
    expect(vault.attempts.value.failures).toBe(1);

    clock.now += 1;
    expect(await vault.unlock(PIN)).toBe('ok');
    expect(vault.attempts.value).toEqual({ failures: 0, retryAt: 0 });
  });

  it('ignores input that cannot be a PIN without spending an attempt', async () => {
    const { vault } = await makeProtectedVault();
    vault.lock();
    expect(await vault.unlock('12')).toBe('wrong');
    expect(await vault.unlock('abcd')).toBe('wrong');
    expect(await vault.unlock('123456789')).toBe('wrong');
    expect(vault.attempts.value.failures).toBe(0);
  });

  it('serialises parallel guesses: one is tried, the rest are throttled', async () => {
    const { vault } = await makeProtectedVault();
    vault.lock();
    const results = await Promise.all(
      ['5001', '5002', '5003', '5004', PIN].map((guess) => vault.unlock(guess)),
    );
    expect(results).toEqual(['wrong', 'throttled', 'throttled', 'throttled', 'throttled']);
    expect(vault.attempts.value.failures).toBe(1);
    expect(vault.locked.value).toBe(true);
  });

  it('remembers the failure count across a restart', async () => {
    const { vault, clock, dbName } = await makeProtectedVault();
    vault.lock();
    for (let i = 0; i < 3; i += 1) {
      expect(await vault.unlock('9999')).toBe('wrong');
      clock.now += retryDelayMs(i + 1);
    }
    await vault.close();
    const restarted = new Vault({ sessionKey: KEY, dbName, now: () => clock.now - 1 });
    await restarted.init();
    expect(restarted.attempts.value.failures).toBe(3);
    expect(await restarted.unlock(PIN)).toBe('throttled');
  });

  it('delays grow exponentially and the 10th consecutive failure wipes the session — and nothing else', async () => {
    // Unsent work lives in another database; it must survive the wipe.
    const otherDb = `istiqama-map-sim-${Math.random().toString(36).slice(2)}`;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(otherDb, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('outbox');
      open.onsuccess = () => {
        const tx = open.result.transaction('outbox', 'readwrite');
        tx.objectStore('outbox').put({ op_id: 'unsent-1', table: 'projects' }, 1);
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });

    const { vault, clock } = await makeProtectedVault();
    vault.lock();
    const delays: number[] = [];
    for (let attempt = 1; attempt < MAX_PIN_FAILURES; attempt += 1) {
      expect(await vault.unlock('9999')).toBe('wrong');
      expect(vault.attempts.value.failures).toBe(attempt);
      delays.push(vault.attempts.value.retryAt - clock.now);
      clock.now = vault.attempts.value.retryAt;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000]);
    expect(await vault.isSet()).toBe(true);

    expect(await vault.unlock('9999')).toBe('wiped');
    expect(await vault.isSet()).toBe(false);
    expect(vault.pinSet.value).toBe(false);
    expect(vault.locked.value).toBe(false);
    expect(vault.attempts.value).toEqual({ failures: 0, retryAt: 0 });
    expect(await vault.dump()).toEqual([]);
    // Even the right PIN is useless now: a full sign-in is required.
    expect(await vault.unlock(PIN)).toBe('no_vault');
    expect(vault.storage.getItem(KEY)).toBeNull();

    const survivor = await new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open(otherDb, 1);
      open.onsuccess = () => {
        const request = open.result.transaction('outbox', 'readonly').objectStore('outbox').get(1);
        request.onsuccess = () => {
          open.result.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
      };
      open.onerror = () => reject(open.error);
    });
    expect(survivor).toEqual({ op_id: 'unsent-1', table: 'projects' });
  }, 30_000);

  it('a correct PIN resets the count', async () => {
    const { vault, clock } = await makeProtectedVault();
    vault.lock();
    for (let i = 1; i <= 4; i += 1) {
      expect(await vault.unlock('9999')).toBe('wrong');
      clock.now = vault.attempts.value.retryAt;
    }
    expect(await vault.unlock(PIN)).toBe('ok');
    vault.lock();
    expect(await vault.unlock('9999')).toBe('wrong');
    expect(vault.attempts.value.failures).toBe(1);
  });
});

describe('storage failures', () => {
  it('reports a friendly storage error when the PIN cannot be saved', async () => {
    const { vault } = makeVault();
    await vault.storage.setItem(KEY, sessionJson());
    await vault.init();
    const original = indexedDB.open.bind(indexedDB);
    await vault.close();
    const spy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    try {
      await expect(vault.setPin(PIN)).rejects.toMatchObject({ kind: 'storage' });
      expect(vault.pinSet.value).toBe(false);
      expect(vault.storage.getItem(KEY)).toBe(sessionJson()); // the session is not lost
    } finally {
      spy.mockRestore();
    }
    expect(typeof original).toBe('function');
    await vault.setPin(PIN);
    expect(await vault.isSet()).toBe(true);
  });
});
