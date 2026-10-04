/**
 * PIN vault — encrypted session at rest + the storage adapter handed to supabase-js (brief §3).
 *
 * How it works
 * ------------
 * supabase-js reads and writes its session through `vault.storage`. The plaintext lives ONLY in
 * this object's memory. On disk (IndexedDB database "istiqama-auth", outside the Dexie data
 * database) there is one record: salt + PBKDF2 work factor + AES-GCM IV + ciphertext of
 * `{ items, extras }` (the supabase session, the cached `my_context()` and a few settings).
 * The AES key is derived from the PIN, is non-extractable and is held in memory only while the
 * app is unlocked. `lock()` drops key and plaintext; `unlock(pin)` needs no network.
 * Until a PIN has been chosen nothing is persisted at all (a reload before PIN setup means
 * signing in again).
 *
 * Threat model — what this protects and what it does not
 * ------------------------------------------------------
 * PROTECTS: casual access to a lost, borrowed or stolen phone. Somebody who opens the app (or
 * copies the browser profile and looks for tokens) finds no usable access/refresh token without
 * the PIN, the data screens are not rendered while locked, guesses through the UI are throttled
 * (1 s, 2 s, 4 s … doubling) and the stored session is destroyed after 10 consecutive failures.
 *
 * DOES NOT PROTECT against a determined attacker who can copy the device storage: a 4–8 digit
 * PIN has 10^4..10^8 values, PBKDF2 only makes each guess cost a fraction of a second, and the
 * failure counter is necessarily stored in the clear next to the ciphertext — offline, it can be
 * reset or ignored. A 4-digit PIN falls in seconds on a laptop. The counter and the delay are a
 * speed bump, not a boundary. The boundary is server-side: an administrator revokes the user's
 * sessions/device (`admin_revoke_sessions`), which kills the refresh token inside the ciphertext
 * and makes `private.session_ok()` refuse the access token on the next statement.
 * Also out of scope: the synced records in IndexedDB (Dexie) are not encrypted — only the
 * session is; malware or a compromised browser running while the app is unlocked sees
 * everything the user sees; and a thief who also controls the SIM/e-mail can simply sign in
 * again (deactivate the account in that case).
 */
import { batch, signal, type Signal } from '@preact/signals';
import {
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  deriveKey,
  openText,
  randomBytes,
  sealText,
  type Bytes,
} from './crypto';
import { AuthFlowError, toFlowError } from './errors';
import { KvStore } from './idb';

export const VAULT_DB_NAME = 'istiqama-auth';
export const MAX_PIN_FAILURES = 10;
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

const VAULT_KEY = 'vault';
const ATTEMPTS_KEY = 'attempts';

export type UnlockResult = 'ok' | 'wrong' | 'throttled' | 'wiped' | 'no_vault';

export interface PinAttempts {
  /** Consecutive wrong PINs since the last successful unlock. */
  failures: number;
  /** Epoch milliseconds before which `unlock` refuses to try (0 = no wait). */
  retryAt: number;
}

interface VaultRecord {
  v: 1;
  salt: Bytes;
  iterations: number;
  iv: Bytes;
  data: ArrayBuffer;
  updatedAt: number;
}

interface AttemptsRecord {
  failures: number;
  lastFailureAt: number;
}

interface Payload {
  items: Record<string, string>;
  extras: Record<string, unknown>;
}

/** Storage interface expected by supabase-js (`auth.storage`). */
export interface VaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface VaultOptions {
  /** supabase-js `storageKey`: the item that holds the session. */
  sessionKey: string;
  dbName?: string;
  iterations?: number;
  now?: () => number;
}

export type VaultListener = (key: string, value: string | null) => void;

export function isValidPin(pin: string): boolean {
  return new RegExp(`^[0-9]{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

/**
 * The handful of PINs everybody tries first. With only ten guesses before the vault is wiped,
 * refusing them is worth more than any work factor.
 */
export function isWeakPin(pin: string): boolean {
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return true; // 0000, 777777
  const steps = digits.slice(1).map((d, i) => (d - digits[i]! + 10) % 10);
  if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return true; // 1234, 7890, 4321
  if (pin.length % 2 === 0) {
    const pair = pin.slice(0, 2);
    if (pair.repeat(pin.length / 2) === pin) return true; // 1212, 696969
  }
  return pin === '2580' || pin === '0852';
}

/** Wait imposed after `failures` consecutive wrong PINs: 1 s, 2 s, 4 s, … (doubling). */
export function retryDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return 1000 * 2 ** Math.min(failures - 1, 20);
}

export class Vault {
  /** A PIN exists and the app has not been unlocked (fail closed until `init` has run). */
  readonly locked: Signal<boolean> = signal(true);
  /** `null` until the first read of the store. */
  readonly pinSet: Signal<boolean | null> = signal(null);
  readonly attempts: Signal<PinAttempts> = signal({ failures: 0, retryAt: 0 });

  readonly storage: VaultStorage = {
    getItem: (key) => this.items.get(key) ?? null,
    setItem: (key, value) => this.setItem(key, value),
    removeItem: (key) => this.removeItem(key),
  };

  private readonly kv: KvStore;
  private readonly sessionKey: string;
  private readonly iterations: number;
  private readonly now: () => number;

  private items = new Map<string, string>();
  private extras: Record<string, unknown> = {};
  private key: CryptoKey | null = null;
  private salt: Bytes | null = null;
  private keyIterations = 0;
  /** Whether a vault record exists on disk (unknown before `init`). */
  private exists = false;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** A sign-in started by the user may replace a locked vault (see `setItem`). */
  private freshSignInExpected = false;
  /** Bumped by `wipe`: queued writes of an older generation are dropped. */
  private generation = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private opChain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<VaultListener>();

  constructor(options: VaultOptions) {
    this.sessionKey = options.sessionKey;
    this.kv = new KvStore(options.dbName ?? VAULT_DB_NAME);
    this.iterations = options.iterations ?? PBKDF2_ITERATIONS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Reads whether a vault exists. Idempotent; never throws (no storage = no vault). */
  init(): Promise<void> {
    this.initPromise ??= (async () => {
      try {
        const [record, attempts] = await Promise.all([
          this.kv.get<VaultRecord>(VAULT_KEY),
          this.kv.get<AttemptsRecord>(ATTEMPTS_KEY),
        ]);
        this.exists = record !== undefined;
        this.publishAttempts(attempts);
      } catch (error) {
        console.warn('auth vault: storage is not available', error);
        this.exists = false;
      }
      this.initialized = true;
      this.pinSet.value = this.exists;
      this.locked.value = this.exists && this.key === null;
    })();
    return this.initPromise;
  }

  subscribe(listener: VaultListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async isSet(): Promise<boolean> {
    await this.init();
    return this.exists;
  }

  isUnlocked(): boolean {
    return this.key !== null;
  }

  /**
   * Announces that the user is completing a sign-in (OTP verification, magic link). Only then
   * may a session written while the vault is locked replace it; any other write while locked
   * (for example a response that arrives after the app locked itself) is dropped.
   */
  expectFreshSignIn(): void {
    this.freshSignInExpected = true;
  }

  getExtra<T>(name: string): T | undefined {
    return this.extras[name] as T | undefined;
  }

  /** Stores a small JSON value next to the session (encrypted with it). */
  async setExtra(name: string, value: unknown): Promise<void> {
    if (this.locked.peek()) return;
    if (value === undefined) delete this.extras[name];
    else this.extras[name] = value;
    await this.persist();
  }

  /**
   * Session rotated by another tab: keep memory in step (the other tab already persisted it).
   * Only ever replaces a session this tab already holds — it never signs a tab in or unlocks it.
   */
  adoptExternal(key: string, value: string): void {
    const current = this.items.get(key);
    if (current === undefined || current === value) return;
    this.items.set(key, value);
    this.emit(key, value);
  }

  /** Chooses or changes the PIN and encrypts what is currently in memory under it. */
  setPin(pin: string): Promise<void> {
    return this.exclusive(async () => {
      await this.init();
      if (!isValidPin(pin)) throw new AuthFlowError('pin_invalid');
      if (isWeakPin(pin)) throw new AuthFlowError('pin_weak');
      if (this.exists && !this.key) throw new AuthFlowError('pin_locked');
      if (!this.items.has(this.sessionKey)) throw new AuthFlowError('no_session');
      const previous = { key: this.key, salt: this.salt, iterations: this.keyIterations };
      try {
        const salt = randomBytes(SALT_BYTES);
        this.key = await deriveKey(pin, salt, this.iterations);
        this.salt = salt;
        this.keyIterations = this.iterations;
        await this.persist(true);
        await this.kv.delete(ATTEMPTS_KEY);
      } catch (error) {
        // Nothing changed on disk: keep working with the previous key (or none).
        this.key = previous.key;
        this.salt = previous.salt;
        this.keyIterations = previous.iterations;
        const flow = toFlowError(error);
        throw flow.kind === 'generic' ? new AuthFlowError('storage', error) : flow;
      }
      this.exists = true;
      this.pinSet.value = true;
      this.locked.value = false;
      this.publishAttempts(undefined);
    });
  }

  /**
   * Tries the PIN. Works offline. While already unlocked it only verifies the PIN (used before
   * changing it) — wrong guesses count either way.
   */
  unlock(pin: string): Promise<UnlockResult> {
    return this.exclusive(async () => {
      await this.init();
      if (!this.exists) return 'no_vault';
      if (!isValidPin(pin)) return 'wrong';
      await this.writeChain;

      const previous = (await this.kv.get<AttemptsRecord>(ATTEMPTS_KEY)) ?? {
        failures: 0,
        lastFailureAt: 0,
      };
      const now = this.now();
      if (now < previous.lastFailureAt + retryDelayMs(previous.failures)) {
        this.publishAttempts(previous);
        return 'throttled';
      }
      const record = await this.kv.get<VaultRecord>(VAULT_KEY);
      if (!record) {
        await this.destroy();
        return 'no_vault';
      }
      // Count the attempt BEFORE trying it, so that closing the tab mid-way cannot dodge it.
      const attempt: AttemptsRecord = { failures: previous.failures + 1, lastFailureAt: now };
      await this.kv.put(ATTEMPTS_KEY, attempt);

      const opened = await this.tryOpen(pin, record);

      if (!opened) {
        if (attempt.failures >= MAX_PIN_FAILURES) {
          await this.destroy();
          return 'wiped';
        }
        this.publishAttempts(attempt);
        return 'wrong';
      }

      await this.kv.delete(ATTEMPTS_KEY);
      this.publishAttempts(undefined);
      if (this.key) return 'ok'; // verification only: memory is already the newer state

      this.key = opened.key;
      this.salt = record.salt;
      this.keyIterations = record.iterations;
      this.items = new Map(Object.entries(opened.payload.items ?? {}));
      this.extras = { ...(opened.payload.extras ?? {}) };
      this.freshSignInExpected = false;
      // One batch: observers never see "unlocked but no session" in between.
      batch(() => {
        this.locked.value = false;
        for (const [itemKey, value] of this.items) this.emit(itemKey, value);
      });
      return 'ok';
    });
  }

  /**
   * Drops key and plaintext from memory (synchronous). Without a PIN there is nothing on disk
   * to come back to, so the in-memory session is simply forgotten.
   */
  lock(): void {
    const hadSession = this.items.has(this.sessionKey);
    this.key = null;
    this.salt = null;
    this.items = new Map();
    this.extras = {};
    this.freshSignInExpected = false;
    batch(() => {
      // Before the first read of the store the answer is unknown: stay closed.
      this.locked.value = this.initialized ? this.exists : true;
      if (hadSession) this.emit(this.sessionKey, null);
    });
  }

  /** Deletes the stored session, the PIN and the failure counter. Other local data is untouched. */
  wipe(): Promise<void> {
    return this.exclusive(() => this.destroy());
  }

  /** Test hook: every record on disk. */
  dump(): Promise<Array<{ key: string; value: unknown }>> {
    return this.writeChain.then(() => this.kv.dump());
  }

  /** Test hook: wait for queued writes. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  close(): Promise<void> {
    return this.kv.close();
  }

  // ---------------------------------------------------------------------------------------

  /** Derives the key from `pin` and decrypts the record; null when the PIN is wrong. */
  private async tryOpen(
    pin: string,
    record: VaultRecord,
  ): Promise<{ key: CryptoKey; payload: Payload } | null> {
    try {
      const key = await deriveKey(pin, record.salt, record.iterations);
      const text = await openText(key, { iv: record.iv, data: record.data });
      return { key, payload: JSON.parse(text) as Payload };
    } catch {
      return null;
    }
  }

  private async setItem(key: string, value: string): Promise<void> {
    await this.init();
    if (!this.key && this.exists) {
      // Locked. Only an explicit new sign-in may take over; it supersedes the old vault.
      if (key !== this.sessionKey || !this.freshSignInExpected) return;
      await this.wipe();
    }
    if (key === this.sessionKey) this.freshSignInExpected = false;
    this.items.set(key, value);
    this.emit(key, value);
    await this.persist();
  }

  private async removeItem(key: string): Promise<void> {
    await this.init();
    if (key === this.sessionKey) {
      // The session is gone (sign-out, or the server refused the refresh token): a PIN that
      // protects nothing is meaningless — the next sign-in chooses a new one.
      if (this.exists || this.items.has(key)) await this.wipe();
      return;
    }
    if (this.items.delete(key)) {
      this.emit(key, null);
      await this.persist();
    }
  }

  private async destroy(): Promise<void> {
    this.generation += 1;
    const hadSession = this.items.has(this.sessionKey);
    this.key = null;
    this.salt = null;
    this.items = new Map();
    this.extras = {};
    this.exists = false;
    this.freshSignInExpected = false;
    try {
      await this.writeChain;
      await this.kv.write([
        { key: VAULT_KEY, delete: true },
        { key: ATTEMPTS_KEY, delete: true },
      ]);
    } catch (error) {
      console.warn('auth vault: could not delete the stored session', error);
    }
    batch(() => {
      this.pinSet.value = false;
      this.locked.value = false;
      this.publishAttempts(undefined);
      if (hadSession) this.emit(this.sessionKey, null);
    });
  }

  /** Encrypts the current memory state and queues the write. No key (no PIN yet) = no write. */
  private persist(rethrow = false): Promise<void> {
    const key = this.key;
    const salt = this.salt;
    if (!key || !salt) return Promise.resolve();
    const generation = this.generation;
    const iterations = this.keyIterations;
    const plaintext = JSON.stringify({
      items: Object.fromEntries(this.items),
      extras: this.extras,
    } satisfies Payload);
    const task = this.writeChain.then(async () => {
      if (generation !== this.generation) return;
      const sealed = await sealText(key, plaintext);
      if (generation !== this.generation) return;
      const record: VaultRecord = {
        v: 1,
        salt,
        iterations,
        iv: sealed.iv,
        data: sealed.data,
        updatedAt: this.now(),
      };
      await this.kv.put(VAULT_KEY, record);
    });
    this.writeChain = task.catch((error: unknown) => {
      console.warn('auth vault: could not persist the session', error);
    });
    return rethrow ? task : this.writeChain;
  }

  private publishAttempts(record: AttemptsRecord | undefined): void {
    const failures = record?.failures ?? 0;
    const retryAt = record && failures > 0 ? record.lastFailureAt + retryDelayMs(failures) : 0;
    this.attempts.value = { failures, retryAt };
  }

  private emit(key: string, value: string | null): void {
    for (const listener of this.listeners) {
      try {
        listener(key, value);
      } catch (error) {
        console.error(error);
      }
    }
  }

  /** PIN operations run one at a time: parallel guesses cannot race the failure counter. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(operation, operation);
    this.opChain = run.catch(() => undefined);
    return run;
  }
}
