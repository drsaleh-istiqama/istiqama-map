/**
 * TUS 1.0.0 resumable uploads (creation, creation-with-upload, termination, expiration) —
 * protocol helpers and the on-disk upload store.
 *
 * State lives in STORAGE_DIR/.tus/<id>.json (+ <id>.bin for the received bytes), so an
 * upload survives a gateway restart: the offset IS the size of the .bin file. A finished
 * upload keeps a small tombstone until it expires, so a client that lost the final response
 * sees `Upload-Offset == Upload-Length` instead of a 404.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { streamToFile } from './files.ts';

export const TUS_VERSION = '1.0.0';
export const TUS_EXTENSIONS = 'creation,creation-with-upload,termination,expiration';
export const TUS_EXPIRY_MS = 24 * 3600 * 1000;

/** `Upload-Metadata: key base64,key2 base64,flag` → decoded map. Malformed pairs are skipped. */
export function parseUploadMetadata(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(',')) {
    const [key, value] = pair.trim().split(/\s+/, 2);
    if (!key) continue;
    if (value === undefined) {
      out[key] = '';
      continue;
    }
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) continue;
    out[key] = Buffer.from(value, 'base64').toString('utf8');
  }
  return out;
}

export interface TusUpload {
  id: string;
  bucket: string;
  name: string;
  length: number;
  contentType: string;
  cacheControl: string;
  userMetadata: Record<string, unknown> | null;
  upsert: boolean;
  /** `sub` of the creator (null for the service role). Later requests must come from the same caller. */
  ownerId: string | null;
  ownerRole: string;
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
  objectId?: string;
}

export type PatchCheck = { ok: true } | { ok: false; status: number; message: string };

/** Protocol checks for PATCH (tus.io core protocol §PATCH). */
export function checkPatch(
  upload: { length: number; completed: boolean },
  currentOffset: number,
  headers: { contentType?: string; uploadOffset?: string; contentLength?: string },
): PatchCheck {
  if (
    !headers.contentType ||
    headers.contentType.split(';')[0]!.trim().toLowerCase() !== 'application/offset+octet-stream'
  ) {
    return {
      ok: false,
      status: 415,
      message: 'Content-Type must be application/offset+octet-stream',
    };
  }
  if (headers.uploadOffset === undefined || !/^\d+$/.test(headers.uploadOffset)) {
    return { ok: false, status: 400, message: 'Upload-Offset header is missing or invalid' };
  }
  const offset = Number(headers.uploadOffset);
  if (offset !== currentOffset) {
    return {
      ok: false,
      status: 409,
      message: `Upload-Offset conflict: expected ${currentOffset}, got ${offset}`,
    };
  }
  if (headers.contentLength !== undefined && /^\d+$/.test(headers.contentLength)) {
    if (offset + Number(headers.contentLength) > upload.length) {
      return {
        ok: false,
        status: 413,
        message: 'The request body exceeds the declared Upload-Length',
      };
    }
  }
  return { ok: true };
}

export function isExpired(upload: Pick<TusUpload, 'expiresAt'>, now: number): boolean {
  return upload.expiresAt <= now;
}

export interface AppendResult {
  written: number;
  /** The client went away before the request body ended; the received bytes were kept. */
  aborted: boolean;
  /** More bytes arrived than the upload may still take; nothing beyond the limit was written. */
  overflow: boolean;
}

export class TusStore {
  private dir: string;
  private locks = new Set<string>();

  constructor(storageDir: string) {
    this.dir = path.join(storageDir, '.tus');
  }

  private json(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  binPath(id: string): string {
    return path.join(this.dir, `${id}.bin`);
  }

  static isValidId(id: string): boolean {
    return /^[a-f0-9]{32}$/.test(id);
  }

  async create(
    input: Omit<TusUpload, 'id' | 'createdAt' | 'expiresAt'>,
    now = Date.now(),
  ): Promise<TusUpload> {
    await fsp.mkdir(this.dir, { recursive: true });
    const upload: TusUpload = {
      ...input,
      id: crypto.randomBytes(16).toString('hex'),
      createdAt: now,
      expiresAt: now + TUS_EXPIRY_MS,
    };
    await fsp.writeFile(this.binPath(upload.id), '');
    await this.save(upload);
    return upload;
  }

  async save(upload: TusUpload): Promise<void> {
    const tmp = `${this.json(upload.id)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(upload));
    await fsp.rename(tmp, this.json(upload.id));
  }

  async get(id: string): Promise<TusUpload | null> {
    if (!TusStore.isValidId(id)) return null;
    try {
      return JSON.parse(await fsp.readFile(this.json(id), 'utf8')) as TusUpload;
    } catch {
      return null;
    }
  }

  async offset(upload: TusUpload): Promise<number> {
    if (upload.completedAt) return upload.length;
    try {
      return (await fsp.stat(this.binPath(upload.id))).size;
    } catch {
      return 0;
    }
  }

  /** One writer per upload; a concurrent PATCH gets 423 Locked. */
  lock(id: string): boolean {
    if (this.locks.has(id)) return false;
    this.locks.add(id);
    return true;
  }

  unlock(id: string): void {
    this.locks.delete(id);
  }

  /** Append the request body to the upload, never writing more than `maxBytes`. */
  append(id: string, req: IncomingMessage, maxBytes: number): Promise<AppendResult> {
    return streamToFile(req, this.binPath(id), { append: true, maxBytes });
  }

  /** Mark as finished and drop the data file reference (the caller has moved it into place). */
  async complete(upload: TusUpload, objectId: string, now = Date.now()): Promise<void> {
    upload.completedAt = now;
    upload.objectId = objectId;
    await this.save(upload);
  }

  async remove(id: string): Promise<void> {
    await fsp.rm(this.json(id), { force: true });
    await fsp.rm(this.binPath(id), { force: true });
  }

  /** Delete expired uploads and tombstones. Returns the number removed. */
  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      const upload = await this.get(id);
      if (!upload || isExpired(upload, now)) {
        await this.remove(id);
        removed++;
      }
    }
    return removed;
  }
}
