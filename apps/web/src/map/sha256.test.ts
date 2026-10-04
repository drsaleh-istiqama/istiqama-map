import { describe, expect, it } from 'vitest';
import { Sha256, sha256Hex } from './sha256';
import { bytesOf } from './testing/pmtilesFixture';

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('incremental SHA-256', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    const enc = new TextEncoder();
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(enc.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('gives the WebCrypto digest whatever the slice sizes', async () => {
    const data = bytesOf(200_003, 42);
    const expected = hex(await crypto.subtle.digest('SHA-256', data));
    for (const sizes of [[1], [63, 1, 64, 65], [4096], [100_000, 100_003]]) {
      const hash = new Sha256();
      let offset = 0;
      let i = 0;
      while (offset < data.length) {
        const size = sizes[i++ % sizes.length]!;
        hash.update(data.subarray(offset, offset + size));
        offset += size;
      }
      expect(hash.hex()).toBe(expected);
    }
  });

  it('refuses to be reused after the digest', () => {
    const hash = new Sha256();
    hash.update(new Uint8Array([1]));
    hash.hex();
    expect(() => hash.update(new Uint8Array([2]))).toThrow();
  });
});
