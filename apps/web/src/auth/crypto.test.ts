import { describe, expect, it } from 'vitest';
import {
  IV_BYTES,
  PBKDF2_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  SALT_BYTES,
  deriveKey,
  openText,
  randomBytes,
  sealText,
} from './crypto';

const SECRET = JSON.stringify({ access_token: 'aaa.bbb.ccc', refresh_token: 'r3fr3sh-t0k3n' });

describe('PIN crypto (PBKDF2-SHA-256 → AES-256-GCM)', () => {
  it('uses a work factor of at least 210,000 iterations', () => {
    expect(PBKDF2_MIN_ITERATIONS).toBe(210_000);
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(PBKDF2_MIN_ITERATIONS);
  });

  it('refuses to derive a key with a weaker work factor', async () => {
    await expect(deriveKey('4071', randomBytes(SALT_BYTES), 100_000)).rejects.toThrow(
      'pbkdf2_iterations_too_low',
    );
  });

  it('round-trips: same PIN and salt decrypt what was encrypted', async () => {
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey('4071', salt, PBKDF2_ITERATIONS);
    const sealed = await sealText(key, SECRET);
    // A key derived again from the same PIN + salt (as after a restart) opens it.
    const again = await deriveKey('4071', salt, PBKDF2_ITERATIONS);
    expect(await openText(again, sealed)).toBe(SECRET);
  });

  it('a wrong PIN cannot decrypt', async () => {
    const salt = randomBytes(SALT_BYTES);
    const sealed = await sealText(await deriveKey('4071', salt, PBKDF2_ITERATIONS), SECRET);
    const wrong = await deriveKey('4072', salt, PBKDF2_ITERATIONS);
    await expect(openText(wrong, sealed)).rejects.toBeDefined();
  });

  it('the same PIN with another salt cannot decrypt', async () => {
    const sealed = await sealText(
      await deriveKey('4071', randomBytes(SALT_BYTES), PBKDF2_ITERATIONS),
      SECRET,
    );
    const other = await deriveKey('4071', randomBytes(SALT_BYTES), PBKDF2_ITERATIONS);
    await expect(openText(other, sealed)).rejects.toBeDefined();
  });

  it('detects tampering with the ciphertext', async () => {
    const key = await deriveKey('4071', randomBytes(SALT_BYTES), PBKDF2_ITERATIONS);
    const sealed = await sealText(key, SECRET);
    const bytes = new Uint8Array(sealed.data.slice(0));
    bytes[0] = bytes[0]! ^ 0x01;
    await expect(openText(key, { iv: sealed.iv, data: bytes.buffer })).rejects.toBeDefined();
  });

  it('never reuses an IV and the ciphertext does not contain the plaintext', async () => {
    const key = await deriveKey('4071', randomBytes(SALT_BYTES), PBKDF2_ITERATIONS);
    const a = await sealText(key, SECRET);
    const b = await sealText(key, SECRET);
    expect(a.iv).toHaveLength(IV_BYTES);
    expect(Array.from(a.iv)).not.toEqual(Array.from(b.iv));
    expect(Array.from(new Uint8Array(a.data))).not.toEqual(Array.from(new Uint8Array(b.data)));
    const visible = new TextDecoder('latin1').decode(a.data);
    expect(visible).not.toContain('r3fr3sh-t0k3n');
    expect(visible).not.toContain('access_token');
  });

  it('the derived key is not extractable', async () => {
    const key = await deriveKey('4071', randomBytes(SALT_BYTES), PBKDF2_ITERATIONS);
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeDefined();
  });
});
