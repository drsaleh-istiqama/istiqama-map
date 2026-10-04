/**
 * Publishing archives to the bucket `tiles` through the Storage API with the service-role key
 * (a file copied into the storage folder would not be an object: docs/contracts/local-gateway.md
 * §8.7). Works the same against the local gateway and Supabase.
 */
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { ROOT } from './cli.ts';

export interface StorageConfig {
  url: string;
  serviceKey: string;
  bucket: string;
}

export function storageConfig(bucket = 'tiles'): StorageConfig {
  dotenv.config({ path: [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')], quiet: true });
  const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !serviceKey)
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (environment or .env.local)',
    );
  return { url, serviceKey, bucket };
}

/** Public URL of an object (the bucket is public: PMTiles are read without credentials). */
export function publicUrl(cfg: StorageConfig, objectName: string): string {
  return `${cfg.url}/storage/v1/object/public/${cfg.bucket}/${encodePath(objectName)}`;
}

export function encodePath(objectName: string): string {
  return objectName.split('/').map(encodeURIComponent).join('/');
}

/**
 * Largest object the server accepts (TUS `Tus-Max-Size`, which mirrors the global
 * `[storage] file_size_limit`); null when the server does not say.
 */
export async function maxObjectBytes(cfg: StorageConfig): Promise<number | null> {
  try {
    const res = await fetch(`${cfg.url}/storage/v1/upload/resumable`, {
      method: 'OPTIONS',
      headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}` },
    });
    const value = Number(res.headers.get('tus-max-size'));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Uploads (or replaces) a file; the body is streamed from disk. */
export async function uploadFile(
  cfg: StorageConfig,
  file: string,
  objectName: string,
  contentType = 'application/vnd.pmtiles',
): Promise<void> {
  const body = await openAsBlob(file, { type: contentType });
  const res = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${encodePath(objectName)}`, {
    method: 'POST',
    headers: {
      apikey: cfg.serviceKey,
      authorization: `Bearer ${cfg.serviceKey}`,
      'content-type': contentType,
      'cache-control': '3600',
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UploadError(`upload of ${objectName} failed: HTTP ${res.status} ${text}`, res.status);
  }
}

/** Reads back the first bytes and the size through the PUBLIC URL (what the app does). */
export async function verifyPublic(
  cfg: StorageConfig,
  objectName: string,
  expectedBytes: number,
): Promise<{ status: number; size: number | null; head: Uint8Array }> {
  const res = await fetch(publicUrl(cfg, objectName), { headers: { range: 'bytes=0-126' } });
  const head = new Uint8Array(await res.arrayBuffer());
  const range = res.headers.get('content-range');
  const size = range ? Number(range.split('/')[1]) : Number(res.headers.get('content-length'));
  if (res.status !== 206)
    throw new UploadError(`range request answered ${res.status}, expected 206`, res.status);
  if (size !== expectedBytes)
    throw new UploadError(`object has ${size} bytes, expected ${expectedBytes}`, res.status);
  return { status: res.status, size, head };
}
