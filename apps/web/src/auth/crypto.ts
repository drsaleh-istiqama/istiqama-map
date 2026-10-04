/**
 * WebCrypto primitives of the PIN vault: PBKDF2-HMAC-SHA-256 → AES-256-GCM.
 *
 * - The derived key is non-extractable: its bytes never become visible to JavaScript.
 * - Every encryption uses a fresh random 96-bit IV; the 128-bit GCM tag authenticates the
 *   ciphertext, so a wrong PIN is detected by a failed decryption (no separate verifier that
 *   could be attacked more cheaply than the ciphertext itself).
 * - Works offline; needs a secure context (https or localhost) for `crypto.subtle`.
 */

/** Lower bound accepted by `deriveKey` (brief §3 / OWASP guidance for PBKDF2-SHA-256). */
export const PBKDF2_MIN_ITERATIONS = 210_000;
/** Work factor used for new vaults; stored with the vault so it can be raised later. */
export const PBKDF2_ITERATIONS = 250_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

/** Binds ciphertexts to this purpose and format version (AES-GCM additional data). */
const AAD_TEXT = 'istiqama-auth-vault:v1';

export type Bytes = Uint8Array<ArrayBuffer>;

export interface Sealed {
  iv: Bytes;
  data: ArrayBuffer;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('insecure_context');
  return s;
}

function utf8(text: string): Bytes {
  const encoded = new TextEncoder().encode(text);
  // Copy into a plain ArrayBuffer-backed view (WebCrypto wants BufferSource, not SharedArrayBuffer).
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(new ArrayBuffer(length));
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** PIN + salt → non-extractable AES-256-GCM key. */
export async function deriveKey(pin: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  if (!Number.isInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS) {
    throw new Error('pbkdf2_iterations_too_low');
  }
  const material = await subtle().importKey('raw', utf8(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealText(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = randomBytes(IV_BYTES);
  const data = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(AAD_TEXT) },
    key,
    utf8(plaintext),
  );
  return { iv, data };
}

/** Rejects (OperationError) when the key is wrong or the ciphertext was modified. */
export async function openText(key: CryptoKey, sealed: Sealed): Promise<string> {
  const plain = await subtle().decrypt(
    { name: 'AES-GCM', iv: sealed.iv, additionalData: utf8(AAD_TEXT) },
    key,
    sealed.data,
  );
  return new TextDecoder().decode(plain);
}
