/**
 * A PMTiles `Source` that reads byte ranges from a pack stored on the device (OPFS file or
 * IndexedDB chunks), so the pmtiles decoder — and through it MapLibre — works offline exactly
 * as it does over HTTP Range requests.
 */
import type { RangeResponse, Source } from 'pmtiles';
import type { PackFile } from './packStore';

export class LocalPackSource implements Source {
  constructor(
    private readonly key: string,
    private readonly file: PackFile,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    signal?.throwIfAborted();
    const data = await this.file.read(offset, length);
    signal?.throwIfAborted();
    // Installed packs are immutable: no etag / expiry needed.
    return { data };
  }
}

const MAGIC = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]; // "PMTiles"

/** True when the bytes start with a PMTiles v3 header. */
export function isPmtilesV3(bytes: ArrayBuffer | Uint8Array): boolean {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8) return false;
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return false;
  return b[7] === 3;
}

/** Key under which a pack is known to the PMTiles caches (`pack:<code>:<sha prefix>`). */
export function packSourceKey(code: string, sha256: string | null | undefined): string {
  return `pack:${code}:${(sha256 ?? 'nosha').slice(0, 12)}`;
}
