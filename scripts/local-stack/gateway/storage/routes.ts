/**
 * /storage/v1 — the subset of the Supabase Storage API that the application uses.
 *
 * Authorisation works exactly like the real service: every metadata statement on
 * storage.objects runs in a transaction under the caller's database role with the caller's
 * JWT claims, so the RLS policies of supabase/migrations decide. The service role bypasses
 * RLS. Files live under STORAGE_DIR/<bucket>/<name>.
 *
 * Error bodies are `{ statusCode, error, message }`. As on Supabase the HTTP status is 400
 * for most failures while `statusCode` carries the semantic code ("403", "404", "409").
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  isConnectionError,
  sqlState,
  withCaller,
  type Caller,
  type RequestInfo,
  type Tx,
} from '../db.ts';
import {
  HttpError,
  PayloadTooLargeError,
  decodeSegment,
  header,
  readBody,
  readJson,
  safeHeaders,
  sendEmpty,
  sendJson,
} from '../http.ts';
import { bearerToken, roleOf, signObjectUrl, verifyJwt } from '../jwt.ts';
import { log } from '../log.ts';
import type { Ctx } from '../types.ts';
import { fileEtag, streamToFile } from './files.ts';
import { multipartBoundary, parseMultipart } from './multipart.ts';
import { UnsafePathError, isValidBucketId, isValidObjectName, objectFsPath } from './paths.ts';
import { parseRange } from './range.ts';
import {
  TUS_EXTENSIONS,
  TUS_VERSION,
  TusStore,
  checkPatch,
  isExpired,
  parseUploadMetadata,
  type TusUpload,
} from './tus.ts';

export class StorageError extends Error {
  constructor(
    public httpStatus: number,
    public statusCode: string,
    public error: string,
    message: string,
  ) {
    super(message);
  }
}

const E = {
  noAuth: () =>
    new StorageError(400, '400', 'Error', "headers must have required property 'authorization'"),
  invalidJwt: (msg: string) => new StorageError(400, '403', 'Unauthorized', msg),
  bucketNotFound: () => new StorageError(400, '404', 'Bucket not found', 'Bucket not found'),
  objectNotFound: () => new StorageError(400, '404', 'not_found', 'Object not found'),
  invalidKey: (key: string) => new StorageError(400, '400', 'InvalidKey', `Invalid key: ${key}`),
  accessDenied: (msg = 'new row violates row-level security policy') =>
    new StorageError(400, '403', 'Unauthorized', msg),
  duplicate: () => new StorageError(400, '409', 'Duplicate', 'The resource already exists'),
  tooLarge: () =>
    new StorageError(
      413,
      '413',
      'Payload too large',
      'The object exceeded the maximum allowed size',
    ),
  invalidMime: (mime: string) =>
    new StorageError(400, '415', 'invalid_mime_type', `mime type ${mime} is not supported`),
  rateLimited: () => new StorageError(429, '429', 'TooManyRequests', 'Too many uploads, slow down'),
  badRequest: (msg: string) => new StorageError(400, '400', 'InvalidRequest', msg),
  invalidSignature: (msg: string) => new StorageError(400, '400', 'InvalidJWT', msg),
  notEmulated: (what: string) =>
    new StorageError(404, '404', 'not_found', `${what} is not emulated by the local gateway`),
  internal: (msg: string, status = 500) =>
    new StorageError(status, String(status), 'Internal', msg),
};

function mapDbError(e: unknown): unknown {
  if (e instanceof StorageError) return e;
  const code = sqlState(e);
  const message = e instanceof Error ? e.message : String(e);
  if (code === '42501')
    return E.accessDenied(
      /row-level security/i.test(message) ? 'new row violates row-level security policy' : message,
    );
  if (code === '23505') return E.duplicate();
  if (code === '23503') return E.bucketNotFound();
  if (code === 'PT429') return E.rateLimited();
  if (code === 'PT403' || code === 'PT401') return E.accessDenied(message);
  if (isConnectionError(e)) return E.internal('Database is not reachable', 503);
  return e;
}

export function sendStorageError(res: ServerResponse, e: StorageError): void {
  sendJson(
    res,
    e.httpStatus,
    { statusCode: e.statusCode, error: e.error, message: e.message },
    e.httpStatus === 429 ? { 'retry-after': 10 } : {},
  );
}

// ---------------------------------------------------------------------------
// Callers, buckets, object rows
// ---------------------------------------------------------------------------
function resolveCaller(ctx: Ctx, req: IncomingMessage): Caller {
  const token = bearerToken(req.headers.authorization) ?? header(req, 'apikey');
  if (!token) throw E.noAuth();
  const v = verifyJwt(token, ctx.cfg.jwtSecret);
  if (!v.ok)
    throw E.invalidJwt(
      v.reason === 'expired' ? '"exp" claim timestamp check failed' : 'Invalid Compact JWS',
    );
  const role = roleOf(v.claims);
  if (!role) throw E.invalidJwt('Invalid role claim');
  const sub = typeof v.claims.sub === 'string' && v.claims.sub ? v.claims.sub : null;
  return { role, claims: v.claims, userId: role === 'authenticated' ? sub : null };
}

function info(req: IncomingMessage, operation: string): RequestInfo {
  return {
    method: req.method ?? 'GET',
    path: (req.url ?? '').split('?')[0]!,
    headers: safeHeaders(req),
    operation,
  };
}

interface BucketRow {
  id: string;
  name: string;
  public: boolean | null;
  file_size_limit: string | number | null;
  allowed_mime_types: string[] | null;
}

const bucketCache = new Map<string, { at: number; row: BucketRow | null }>();

/** Bucket settings are read with the service connection (as the real Storage API does). */
async function getBucket(ctx: Ctx, id: string): Promise<BucketRow> {
  if (!isValidBucketId(id)) throw E.bucketNotFound();
  const hit = bucketCache.get(id);
  const now = Date.now();
  if (hit && now - hit.at < 5000) {
    if (!hit.row) throw E.bucketNotFound();
    return hit.row;
  }
  const res = await ctx.db.query<BucketRow>(
    'select id, name, public, file_size_limit, allowed_mime_types from storage.buckets where id = $1',
    [id],
  );
  const row = res.rows[0] ?? null;
  if (bucketCache.size > 200) bucketCache.clear();
  bucketCache.set(id, { at: now, row });
  if (!row) throw E.bucketNotFound();
  return row;
}

interface ObjectRow {
  id: string;
  bucket_id: string;
  name: string;
  owner: string | null;
  metadata: Record<string, unknown> | null;
  user_metadata: Record<string, unknown> | null;
  created_at: Date | null;
  updated_at: Date | null;
  last_accessed_at: Date | null;
  version: string | null;
}

const OBJ_COLS =
  'id, bucket_id, name, owner, metadata, user_metadata, created_at, updated_at, last_accessed_at, version';

function checkName(name: string): void {
  if (!isValidObjectName(name)) throw E.invalidKey(name);
}

function fsPath(ctx: Ctx, bucket: string, name: string): string {
  try {
    return objectFsPath(ctx.cfg.storageDir, bucket, name);
  } catch (e) {
    if (e instanceof UnsafePathError) throw E.invalidKey(name);
    throw e;
  }
}

function sizeLimit(ctx: Ctx, bucket: BucketRow): number {
  let limit = ctx.cfg.fileSizeLimit;
  const own = bucket.file_size_limit === null ? null : Number(bucket.file_size_limit);
  if (own !== null && own > 0) limit = Math.min(limit, own);
  if (bucket.id === 'photos') limit = Math.min(limit, ctx.cfg.photoSizeLimit);
  return limit;
}

function checkMime(bucket: BucketRow, mime: string): void {
  const allowed = bucket.allowed_mime_types;
  if (!allowed || allowed.length === 0) return;
  const base = mime.split(';')[0]!.trim().toLowerCase();
  const ok = allowed.some((a) => {
    const p = a.toLowerCase();
    return p === base || (p.endsWith('/*') && base.startsWith(p.slice(0, -1)));
  });
  if (!ok) throw E.invalidMime(base);
}

function checkUploadRate(ctx: Ctx, caller: Caller): void {
  if (caller.role === 'service_role') return;
  const key = `upload:${caller.userId ?? caller.role}`;
  if (!ctx.limiter.take(key, ctx.cfg.uploadRatePerMinute, 60_000)) throw E.rateLimited();
}

const INSERT_SQL = `
  insert into storage.objects (bucket_id, name, owner, owner_id, metadata, user_metadata, version)
  values ($1, $2, $3::uuid, ($3::uuid)::text, $4::jsonb, $5::jsonb, $6)`;
const UPSERT_SQL = `${INSERT_SQL}
  on conflict (bucket_id, name) do update
    set metadata = excluded.metadata, user_metadata = excluded.user_metadata, version = excluded.version,
        owner = excluded.owner, owner_id = excluded.owner_id, last_accessed_at = now()`;

/** Dry run of the metadata insert under the caller's role (rolled back): may this caller write here? */
async function assertCanUpload(
  ctx: Ctx,
  caller: Caller,
  ri: RequestInfo,
  bucket: string,
  name: string,
  upsert: boolean,
): Promise<void> {
  try {
    await withCaller(
      ctx.db,
      caller,
      ri,
      (tx) =>
        tx.query(`${upsert ? UPSERT_SQL : INSERT_SQL} returning id`, [
          bucket,
          name,
          caller.userId,
          null,
          null,
          null,
        ]),
      { rollback: true },
    );
  } catch (e) {
    throw mapDbError(e);
  }
}

interface FileMeta {
  size: number;
  etag: string;
  contentType: string;
  cacheControl: string;
  userMetadata: Record<string, unknown> | null;
}

async function moveIntoPlace(tmp: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, dest);
      return;
    } catch (e) {
      // Windows: the destination may be briefly open by a reader.
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

/** Write the metadata row as the caller and move the received file into place (one transaction). */
async function commitObject(
  ctx: Ctx,
  caller: Caller,
  ri: RequestInfo,
  bucket: string,
  name: string,
  upsert: boolean,
  tmp: string,
  meta: FileMeta,
): Promise<string> {
  const dest = fsPath(ctx, bucket, name);
  const metadata = {
    eTag: `"${meta.etag}"`,
    size: meta.size,
    mimetype: meta.contentType,
    cacheControl: meta.cacheControl,
    lastModified: new Date().toISOString(),
    contentLength: meta.size,
    httpStatusCode: 200,
  };
  try {
    return await withCaller(ctx.db, caller, ri, async (tx) => {
      const res = await tx.query<{ id: string }>(
        `${upsert ? UPSERT_SQL : INSERT_SQL} returning id`,
        [
          bucket,
          name,
          caller.userId,
          JSON.stringify(metadata),
          meta.userMetadata ? JSON.stringify(meta.userMetadata) : null,
          crypto.randomUUID(),
        ],
      );
      await moveIntoPlace(tmp, dest);
      return res.rows[0]!.id;
    });
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw mapDbError(e);
  }
}

async function tmpFile(ctx: Ctx): Promise<string> {
  const dir = path.join(ctx.cfg.storageDir, '.tmp');
  await fsp.mkdir(dir, { recursive: true });
  return path.join(dir, crypto.randomUUID());
}

/** Stream a raw request body to a temp file with a size cap; returns size and MD5. */
async function receiveRaw(
  req: IncomingMessage,
  tmp: string,
  limit: number,
): Promise<{ size: number; etag: string }> {
  const declared = Number(header(req, 'content-length'));
  if (Number.isFinite(declared) && declared > limit) throw E.tooLarge();
  const r = await streamToFile(req, tmp, { maxBytes: limit, md5: true });
  if (r.overflow || r.aborted) {
    await fsp.rm(tmp, { force: true });
    if (r.overflow) throw E.tooLarge();
    throw new HttpError(400, 'request aborted');
  }
  return { size: r.written, etag: r.md5! };
}

function parseUserMetadata(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upload (POST = create, PUT = replace) — multipart/form-data or raw body
// ---------------------------------------------------------------------------
async function handleUpload(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  bucketId: string,
  name: string,
  replace: boolean,
): Promise<void> {
  const caller = resolveCaller(ctx, req);
  const bucket = await getBucket(ctx, bucketId);
  checkName(name);
  const upsert = replace || header(req, 'x-upsert') === 'true';
  checkUploadRate(ctx, caller);
  const ri = info(req, replace ? 'object.update' : 'object.upload');
  await assertCanUpload(ctx, caller, ri, bucket.id, name, upsert);

  const limit = sizeLimit(ctx, bucket);
  const boundary = multipartBoundary(header(req, 'content-type'));
  const tmp = await tmpFile(ctx);
  let meta: FileMeta;
  if (boundary) {
    let buf: Buffer;
    try {
      buf = await readBody(req, limit + 256 * 1024);
    } catch (e) {
      if (e instanceof PayloadTooLargeError) throw E.tooLarge();
      throw e;
    }
    const parts = parseMultipart(buf, boundary);
    const file =
      parts.find((p) => p.filename !== undefined) ??
      parts.find((p) => p.name === '' || p.name === 'file');
    if (!file) throw E.badRequest('The multipart body contains no file');
    if (file.data.length > limit) throw E.tooLarge();
    const field = (n: string): string | undefined =>
      parts.find((p) => p !== file && p.name === n)?.data.toString('utf8');
    const cacheSeconds = field('cacheControl');
    await fsp.writeFile(tmp, file.data);
    meta = {
      size: file.data.length,
      etag: crypto.createHash('md5').update(file.data).digest('hex'),
      contentType: file.contentType ?? field('contentType') ?? 'application/octet-stream',
      cacheControl: cacheSeconds ? `max-age=${cacheSeconds}` : 'no-cache',
      userMetadata: parseUserMetadata(field('metadata')),
    };
  } else {
    const received = await receiveRaw(req, tmp, limit);
    const xMeta = header(req, 'x-metadata');
    meta = {
      ...received,
      contentType: header(req, 'content-type') ?? 'application/octet-stream',
      cacheControl: header(req, 'cache-control') ?? 'no-cache',
      userMetadata: xMeta ? parseUserMetadata(Buffer.from(xMeta, 'base64').toString('utf8')) : null,
    };
  }
  try {
    checkMime(bucket, meta.contentType);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  const id = await commitObject(ctx, caller, ri, bucket.id, name, upsert, tmp, meta);
  sendJson(res, 200, { Id: id, Key: `${bucket.id}/${name}` });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------
async function findObject(
  ctx: Ctx,
  bucket: string,
  name: string,
  caller: Caller | null,
  ri: RequestInfo,
): Promise<ObjectRow> {
  const sql = `select ${OBJ_COLS} from storage.objects where bucket_id = $1 and name = $2`;
  let row: ObjectRow | undefined;
  try {
    if (caller)
      row = (await withCaller(ctx.db, caller, ri, (tx) => tx.query<ObjectRow>(sql, [bucket, name])))
        .rows[0];
    else row = (await ctx.db.query<ObjectRow>(sql, [bucket, name])).rows[0];
  } catch (e) {
    throw mapDbError(e);
  }
  if (!row) throw E.objectNotFound();
  return row;
}

async function serveObject(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  row: ObjectRow,
  query: URLSearchParams,
): Promise<void> {
  const file = fsPath(ctx, row.bucket_id, row.name);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw E.objectNotFound();
  }
  const md = row.metadata ?? {};
  const etag =
    typeof md.eTag === 'string'
      ? md.eTag
      : `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers: Record<string, string | number> = {
    'content-type': typeof md.mimetype === 'string' ? md.mimetype : 'application/octet-stream',
    'cache-control': typeof md.cacheControl === 'string' ? md.cacheControl : 'no-cache',
    etag,
    'last-modified': (row.updated_at ?? stat.mtime).toUTCString(),
    'accept-ranges': 'bytes',
  };
  const download = query.get('download');
  if (download !== null) {
    const fileName = download || row.name.split('/').pop() || 'download';
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  }

  const inm = header(req, 'if-none-match');
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    res.writeHead(304, {
      etag,
      'cache-control': String(headers['cache-control']),
      'last-modified': String(headers['last-modified']),
    });
    res.end();
    return;
  }

  const range = parseRange(header(req, 'range'), stat.size);
  if (range.kind === 'unsatisfiable') {
    res.writeHead(416, {
      'content-range': `bytes */${stat.size}`,
      'accept-ranges': 'bytes',
      'content-length': 0,
    });
    res.end();
    return;
  }
  const start = range.kind === 'range' ? range.start : 0;
  const end = range.kind === 'range' ? range.end : stat.size - 1;
  headers['content-length'] = stat.size === 0 ? 0 : end - start + 1;
  if (range.kind === 'range') headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range.kind === 'range' ? 206 : 200, headers);
  if (req.method === 'HEAD' || stat.size === 0) {
    res.end();
    return;
  }
  try {
    await pipeline(fs.createReadStream(file, { start, end }), res);
  } catch {
    // client went away mid-download; nothing to report
    res.destroy();
  }
}

// ---------------------------------------------------------------------------
// Signed URLs, list, delete, move, copy, info
// ---------------------------------------------------------------------------
async function handleSign(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  bucketId: string,
  name: string,
): Promise<void> {
  const caller = resolveCaller(ctx, req);
  await getBucket(ctx, bucketId);
  checkName(name);
  const b = await readJson(req);
  const expiresIn = Number(b.expiresIn);
  if (!Number.isFinite(expiresIn) || expiresIn < 1)
    throw E.badRequest('body must have required property expiresIn');
  await findObject(ctx, bucketId, name, caller, info(req, 'object.sign'));
  const token = signObjectUrl(`${bucketId}/${name}`, Math.floor(expiresIn), ctx.cfg.jwtSecret);
  sendJson(res, 200, { signedURL: `/object/sign/${bucketId}/${name}?token=${token}` });
}

async function handleSignMany(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  bucketId: string,
): Promise<void> {
  const caller = resolveCaller(ctx, req);
  await getBucket(ctx, bucketId);
  const b = await readJson(req);
  const expiresIn = Number(b.expiresIn);
  const paths = Array.isArray(b.paths)
    ? b.paths.filter((p): p is string => typeof p === 'string')
    : null;
  if (!Number.isFinite(expiresIn) || expiresIn < 1 || !paths)
    throw E.badRequest('body must have required properties expiresIn and paths');
  let visible: Set<string>;
  try {
    const rows = await withCaller(ctx.db, caller, info(req, 'object.sign_many'), (tx) =>
      tx.query<{ name: string }>(
        'select name from storage.objects where bucket_id = $1 and name = any($2::text[])',
        [bucketId, paths],
      ),
    );
    visible = new Set(rows.rows.map((r) => r.name));
  } catch (e) {
    throw mapDbError(e);
  }
  sendJson(
    res,
    200,
    paths.map((p) =>
      visible.has(p)
        ? {
            error: null,
            path: p,
            signedURL: `/object/sign/${bucketId}/${p}?token=${signObjectUrl(`${bucketId}/${p}`, Math.floor(expiresIn), ctx.cfg.jwtSecret)}`,
          }
        : {
            error: 'Either the object does not exist or you do not have access to it',
            path: p,
            signedURL: null,
          },
    ),
  );
}

async function handleSignedDownload(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  bucketId: string,
  name: string,
  query: URLSearchParams,
): Promise<void> {
  const token = query.get('token');
  if (!token) throw E.badRequest("querystring must have required property 'token'");
  const v = verifyJwt(token, ctx.cfg.jwtSecret);
  if (!v.ok)
    throw E.invalidSignature(
      v.reason === 'expired' ? '"exp" claim timestamp check failed' : 'Invalid JWT',
    );
  if (v.claims.url !== `${bucketId}/${name}`)
    throw E.invalidSignature('The signed URL does not match the requested object');
  checkName(name);
  const row = await findObject(ctx, bucketId, name, null, info(req, 'object.get_signed'));
  await serveObject(ctx, req, res, row, query);
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const SORT_COLUMNS = new Set(['name', 'updated_at', 'created_at', 'last_accessed_at']);

async function handleList(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  bucketId: string,
): Promise<void> {
  const caller = resolveCaller(ctx, req);
  await getBucket(ctx, bucketId);
  const b = await readJson(req);
  let prefix = typeof b.prefix === 'string' ? b.prefix : '';
  if (prefix.length > 0 && !prefix.endsWith('/')) prefix += '/';
  const search = typeof b.search === 'string' ? b.search : '';
  const limit = Math.min(1000, Math.max(1, Number(b.limit) || 100));
  const offset = Math.max(0, Number(b.offset) || 0);
  const sortBy =
    typeof b.sortBy === 'object' && b.sortBy !== null ? (b.sortBy as Record<string, unknown>) : {};
  const column =
    typeof sortBy.column === 'string' && SORT_COLUMNS.has(sortBy.column) ? sortBy.column : 'name';
  const order = sortBy.order === 'desc' ? 'desc' : 'asc';
  const level = prefix === '' ? 1 : prefix.split('/').length;
  const sql = `
    with matched as (
      select o.id, o.path_tokens, o.updated_at, o.created_at, o.last_accessed_at, o.metadata
      from storage.objects o
      where o.bucket_id = $1 and o.name like $2 escape '\\'
    )
    select * from (
      select distinct on (path_tokens[$3]) path_tokens[$3] as name, null::uuid as id, null::timestamptz as updated_at,
             null::timestamptz as created_at, null::timestamptz as last_accessed_at, null::jsonb as metadata, 0 as kind
      from matched where array_length(path_tokens, 1) > $3
      union all
      select path_tokens[$3], id, updated_at, created_at, last_accessed_at, metadata, 1
      from matched where array_length(path_tokens, 1) = $3
    ) items
    order by kind, ${column} ${order} nulls last, name
    limit $4 offset $5`;
  try {
    const rows = await withCaller(ctx.db, caller, info(req, 'object.list'), (tx) =>
      tx.query(sql, [bucketId, `${escapeLike(prefix + search)}%`, level, limit, offset]),
    );
    sendJson(
      res,
      200,
      rows.rows.map((r: Record<string, unknown>) => ({
        name: r.name,
        id: r.id,
        updated_at: r.updated_at,
        created_at: r.created_at,
        last_accessed_at: r.last_accessed_at,
        metadata: r.metadata,
      })),
    );
  } catch (e) {
    throw mapDbError(e);
  }
}

async function deleteObjects(
  ctx: Ctx,
  req: IncomingMessage,
  caller: Caller,
  bucketId: string,
  names: string[],
): Promise<ObjectRow[]> {
  for (const n of names) checkName(n);
  let rows: ObjectRow[];
  try {
    rows = (
      await withCaller(ctx.db, caller, info(req, 'object.delete'), (tx) =>
        tx.query<ObjectRow>(
          `delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning ${OBJ_COLS}`,
          [bucketId, names],
        ),
      )
    ).rows;
  } catch (e) {
    throw mapDbError(e);
  }
  for (const r of rows) await fsp.rm(fsPath(ctx, r.bucket_id, r.name), { force: true });
  return rows;
}

async function handleMoveOrCopy(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  copy: boolean,
): Promise<void> {
  const caller = resolveCaller(ctx, req);
  const b = await readJson(req);
  const srcBucket = typeof b.bucketId === 'string' ? b.bucketId : '';
  const srcKey = typeof b.sourceKey === 'string' ? b.sourceKey : '';
  const dstBucket =
    typeof b.destinationBucket === 'string' && b.destinationBucket
      ? b.destinationBucket
      : srcBucket;
  const dstKey = typeof b.destinationKey === 'string' ? b.destinationKey : '';
  await getBucket(ctx, srcBucket);
  await getBucket(ctx, dstBucket);
  checkName(srcKey);
  checkName(dstKey);
  const ri = info(req, copy ? 'object.copy' : 'object.move');
  const src = fsPath(ctx, srcBucket, srcKey);
  const dst = fsPath(ctx, dstBucket, dstKey);
  try {
    if (copy) {
      const row = await findObject(ctx, srcBucket, srcKey, caller, ri);
      const tmp = await tmpFile(ctx);
      await fsp.copyFile(src, tmp);
      const id = await withCaller(ctx.db, caller, ri, async (tx) => {
        const r = await tx.query<{ id: string }>(
          `${header(req, 'x-upsert') === 'true' ? UPSERT_SQL : INSERT_SQL} returning id`,
          [
            dstBucket,
            dstKey,
            caller.userId,
            JSON.stringify(row.metadata ?? {}),
            row.user_metadata ? JSON.stringify(row.user_metadata) : null,
            crypto.randomUUID(),
          ],
        );
        await moveIntoPlace(tmp, dst);
        return r.rows[0]!.id;
      });
      sendJson(res, 200, { Id: id, Key: `${dstBucket}/${dstKey}` });
    } else {
      await withCaller(ctx.db, caller, ri, async (tx) => {
        const r = await tx.query(
          'update storage.objects set bucket_id = $3, name = $4 where bucket_id = $1 and name = $2 returning id',
          [srcBucket, srcKey, dstBucket, dstKey],
        );
        if (!r.rowCount) throw E.objectNotFound();
        await moveIntoPlace(src, dst);
      });
      sendJson(res, 200, { message: 'Successfully moved' });
    }
  } catch (e) {
    throw mapDbError(e);
  }
}

async function handleInfo(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  bucketId: string,
  name: string,
): Promise<void> {
  const caller = resolveCaller(ctx, req);
  await getBucket(ctx, bucketId);
  checkName(name);
  const row = await findObject(ctx, bucketId, name, caller, info(req, 'object.info'));
  const md = row.metadata ?? {};
  sendJson(res, 200, {
    id: row.id,
    name: row.name,
    version: row.version,
    bucket_id: row.bucket_id,
    size: md.size ?? null,
    content_type: md.mimetype ?? null,
    cache_control: md.cacheControl ?? null,
    etag: md.eTag ?? null,
    metadata: row.user_metadata ?? {},
    last_modified: md.lastModified ?? row.updated_at,
    created_at: row.created_at,
  });
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------
const BUCKET_COLS =
  'id, name, owner, public, file_size_limit, allowed_mime_types, created_at, updated_at';

async function handleBuckets(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
): Promise<void> {
  const caller = resolveCaller(ctx, req);
  const method = req.method ?? 'GET';
  const id = parts[1] === undefined ? undefined : (decodeSegment(parts[1]) ?? '');
  const run = <T>(op: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withCaller(ctx.db, caller, info(req, op), fn).catch((e: unknown) =>
      Promise.reject(mapDbError(e)),
    );
  bucketCache.clear();

  if (id === undefined && method === 'GET') {
    const rows = await run('bucket.list', (tx) =>
      tx.query(`select ${BUCKET_COLS} from storage.buckets order by name`),
    );
    return sendJson(res, 200, rows.rows);
  }
  if (id === undefined && method === 'POST') {
    const b = await readJson(req);
    const bucketId = typeof b.id === 'string' ? b.id : typeof b.name === 'string' ? b.name : '';
    if (!isValidBucketId(bucketId)) throw E.badRequest('Bucket name invalid');
    await run('bucket.create', (tx) =>
      tx.query(
        'insert into storage.buckets (id, name, owner, owner_id, public, file_size_limit, allowed_mime_types) values ($1, $2, $3::uuid, ($3::uuid)::text, $4, $5, $6)',
        [
          bucketId,
          typeof b.name === 'string' ? b.name : bucketId,
          caller.userId,
          b.public === true,
          b.file_size_limit ?? null,
          Array.isArray(b.allowed_mime_types) ? b.allowed_mime_types : null,
        ],
      ),
    );
    return sendJson(res, 200, { name: bucketId });
  }
  if (id !== undefined && parts[2] === undefined && method === 'GET') {
    const rows = await run('bucket.get', (tx) =>
      tx.query(`select ${BUCKET_COLS} from storage.buckets where id = $1`, [id]),
    );
    if (!rows.rows[0]) throw E.bucketNotFound();
    return sendJson(res, 200, rows.rows[0]);
  }
  if (id !== undefined && parts[2] === undefined && method === 'PUT') {
    const b = await readJson(req);
    const r = await run('bucket.update', (tx) =>
      tx.query(
        'update storage.buckets set public = coalesce($2, public), file_size_limit = $3, allowed_mime_types = $4, updated_at = now() where id = $1',
        [
          id,
          typeof b.public === 'boolean' ? b.public : null,
          b.file_size_limit ?? null,
          Array.isArray(b.allowed_mime_types) ? b.allowed_mime_types : null,
        ],
      ),
    );
    if (!r.rowCount) throw E.bucketNotFound();
    return sendJson(res, 200, { message: 'Successfully updated' });
  }
  if (id !== undefined && parts[2] === 'empty' && method === 'POST') {
    await getBucket(ctx, id);
    const rows = await run('bucket.empty', (tx) =>
      tx.query<ObjectRow>(
        `delete from storage.objects where bucket_id = $1 returning ${OBJ_COLS}`,
        [id],
      ),
    );
    for (const r of rows.rows) await fsp.rm(fsPath(ctx, r.bucket_id, r.name), { force: true });
    return sendJson(res, 200, { message: 'Successfully emptied' });
  }
  if (id !== undefined && parts[2] === undefined && method === 'DELETE') {
    const count = await ctx.db.query<{ n: string }>(
      'select count(*) as n from storage.objects where bucket_id = $1',
      [id],
    );
    if (Number(count.rows[0]!.n) > 0)
      throw new StorageError(
        400,
        '409',
        'InvalidRequest',
        'The bucket you tried to delete is not empty',
      );
    const r = await run('bucket.delete', (tx) =>
      tx.query('delete from storage.buckets where id = $1', [id]),
    );
    if (!r.rowCount) throw E.bucketNotFound();
    return sendJson(res, 200, { message: 'Successfully deleted' });
  }
  throw E.notEmulated(`${method} /storage/v1/${parts.join('/')}`);
}

// ---------------------------------------------------------------------------
// TUS resumable uploads
// ---------------------------------------------------------------------------
let tusStore: TusStore | null = null;
export function tus(ctx: Ctx): TusStore {
  tusStore ??= new TusStore(ctx.cfg.storageDir);
  return tusStore;
}

class TusError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string | number> = {},
  ) {
    super(message);
  }
}

function sendTus(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number> = {},
  bodyText = '',
): void {
  const body = Buffer.from(bodyText);
  res.writeHead(status, {
    'tus-resumable': TUS_VERSION,
    'cache-control': 'no-store',
    ...(body.length ? { 'content-type': 'text/plain; charset=utf-8' } : {}),
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

function tusCaller(ctx: Ctx, req: IncomingMessage): Caller {
  try {
    return resolveCaller(ctx, req);
  } catch (e) {
    if (e instanceof StorageError)
      throw new TusError(e.statusCode === '403' ? 403 : 400, e.message);
    throw e;
  }
}

function tusFromStorage(e: unknown): unknown {
  const mapped = mapDbError(e);
  if (mapped instanceof StorageError) {
    const status = Number(mapped.statusCode) || mapped.httpStatus;
    return new TusError(status, mapped.message, status === 429 ? { 'retry-after': 10 } : {});
  }
  return mapped;
}

function sameOwner(upload: TusUpload, caller: Caller): boolean {
  return (
    caller.role === 'service_role' ||
    (caller.role === upload.ownerRole && caller.userId === upload.ownerId)
  );
}

async function finishTus(
  ctx: Ctx,
  req: IncomingMessage,
  caller: Caller,
  upload: TusUpload,
): Promise<void> {
  const store = tus(ctx);
  const bin = store.binPath(upload.id);
  const etag = await fileEtag(bin, upload.length);
  let id: string;
  try {
    id = await commitObject(
      ctx,
      caller,
      info(req, 'object.upload_resumable'),
      upload.bucket,
      upload.name,
      upload.upsert,
      bin,
      {
        size: upload.length,
        etag,
        contentType: upload.contentType,
        cacheControl: upload.cacheControl,
        userMetadata: upload.userMetadata,
      },
    );
  } catch (e) {
    // commitObject removed the data file; the upload cannot be resumed any more.
    await store.remove(upload.id);
    throw tusFromStorage(e);
  }
  await store.complete(upload, id);
}

async function handleTus(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
): Promise<void> {
  const method = req.method ?? 'GET';
  const store = tus(ctx);
  // parts: ['upload', 'resumable', id?]
  const id = parts[2];
  try {
    if (method === 'OPTIONS') {
      return sendTus(res, 204, {
        'tus-version': TUS_VERSION,
        'tus-extension': TUS_EXTENSIONS,
        'tus-max-size': ctx.cfg.fileSizeLimit,
      });
    }
    if (header(req, 'tus-resumable') !== TUS_VERSION)
      throw new TusError(412, 'Unsupported or missing Tus-Resumable header', {
        'tus-version': TUS_VERSION,
      });
    const caller = tusCaller(ctx, req);

    if (id === undefined) {
      if (method !== 'POST') throw new TusError(405, 'Method not allowed');
      const lengthHeader = header(req, 'upload-length');
      if (!lengthHeader || !/^\d+$/.test(lengthHeader))
        throw new TusError(
          400,
          'Upload-Length header is required (deferred length is not supported)',
        );
      const length = Number(lengthHeader);
      const md = parseUploadMetadata(header(req, 'upload-metadata'));
      const bucketId = md.bucketName ?? '';
      const name = md.objectName ?? '';
      let bucket: BucketRow;
      try {
        bucket = await getBucket(ctx, bucketId);
        checkName(name);
        if (length > sizeLimit(ctx, bucket)) throw new TusError(413, 'Maximum size exceeded');
        checkMime(bucket, md.contentType || 'application/octet-stream');
        checkUploadRate(ctx, caller);
        const upsert = header(req, 'x-upsert') === 'true';
        await assertCanUpload(
          ctx,
          caller,
          info(req, 'object.upload_resumable'),
          bucket.id,
          name,
          upsert,
        );
        const upload = await store.create({
          bucket: bucket.id,
          name,
          length,
          contentType: md.contentType || 'application/octet-stream',
          cacheControl: md.cacheControl
            ? /^\d+$/.test(md.cacheControl)
              ? `max-age=${md.cacheControl}`
              : md.cacheControl
            : 'no-cache',
          userMetadata: parseUserMetadata(md.metadata),
          upsert,
          ownerId: caller.userId,
          ownerRole: caller.role,
        });
        const base = `http://${header(req, 'host') ?? `127.0.0.1:${ctx.cfg.port}`}/storage/v1/upload/resumable/${upload.id}`;
        const headers: Record<string, string | number> = {
          location: base,
          'upload-expires': new Date(upload.expiresAt).toUTCString(),
        };
        // creation-with-upload: the first bytes may travel with the POST
        if ((header(req, 'content-type') ?? '').startsWith('application/offset+octet-stream')) {
          const r = await store.append(upload.id, req, length);
          if (r.overflow) {
            await store.remove(upload.id);
            throw new TusError(413, 'The request body exceeds the declared Upload-Length');
          }
          headers['upload-offset'] = r.written;
          if (r.written === length) await finishTus(ctx, req, caller, upload);
        } else if (length === 0) {
          await finishTus(ctx, req, caller, upload);
        }
        return sendTus(res, 201, headers);
      } catch (e) {
        throw tusFromStorage(e);
      }
    }

    const upload = await store.get(id);
    if (!upload || isExpired(upload, Date.now())) {
      if (upload) await store.remove(upload.id);
      throw new TusError(404, 'Upload not found');
    }
    if (!sameOwner(upload, caller)) throw new TusError(403, 'This upload belongs to another user');

    if (method === 'HEAD') {
      return sendTus(res, 200, {
        'upload-offset': await store.offset(upload),
        'upload-length': upload.length,
        'upload-expires': new Date(upload.expiresAt).toUTCString(),
      });
    }
    if (method === 'DELETE') {
      await store.remove(upload.id);
      return sendTus(res, 204);
    }
    if (method === 'PATCH') {
      if (!store.lock(upload.id)) throw new TusError(423, 'Upload is locked by another request');
      try {
        const offset = await store.offset(upload);
        const check = checkPatch(
          { length: upload.length, completed: !!upload.completedAt },
          offset,
          {
            contentType: header(req, 'content-type'),
            uploadOffset: header(req, 'upload-offset'),
            contentLength: header(req, 'content-length'),
          },
        );
        if (!check.ok)
          throw new TusError(
            check.status,
            check.message,
            check.status === 409 ? { 'upload-offset': offset } : {},
          );
        if (upload.completedAt) return sendTus(res, 204, { 'upload-offset': upload.length });
        const r = await store.append(upload.id, req, upload.length - offset);
        if (r.overflow)
          throw new TusError(413, 'The request body exceeds the declared Upload-Length');
        const next = offset + r.written;
        if (r.aborted) {
          // connection lost mid-chunk: the bytes are kept, the client resumes with HEAD
          res.destroy();
          return;
        }
        if (next === upload.length) await finishTus(ctx, req, caller, upload);
        return sendTus(res, 204, {
          'upload-offset': next,
          'upload-expires': new Date(upload.expiresAt).toUTCString(),
        });
      } finally {
        store.unlock(upload.id);
      }
    }
    throw new TusError(405, 'Method not allowed');
  } catch (e) {
    if (e instanceof TusError) return sendTus(res, e.status, e.headers, e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
/** Split "/a/b%20c/d" into decoded segments; null when an escape is malformed. */
function segments(p: string): string[] | null {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (s === '') continue;
    const d = decodeSegment(s);
    if (d === null) return null;
    out.push(d);
  }
  return out;
}

export async function handleStorage(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  subPath: string,
  queryString: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const query = new URLSearchParams(queryString);
  try {
    const parts = segments(subPath);
    if (!parts) throw E.badRequest('Malformed URL');
    const root = parts[0];

    if (root === 'upload' && parts[1] === 'resumable') return await handleTus(ctx, req, res, parts);
    if (root === 'bucket') return await handleBuckets(ctx, req, res, parts);
    if (root === 'status' || root === 'health') return sendJson(res, 200, { message: 'ok' });
    if (root === 'version') return sendJson(res, 200, { version: 'local-gateway' });
    if (root !== 'object') throw E.notEmulated(`${method} /storage/v1/${parts.join('/')}`);

    const kind = parts[1];
    const rest = (from: number): { bucket: string; name: string } => ({
      bucket: parts[from] ?? '',
      name: parts.slice(from + 1).join('/'),
    });
    const readMethod = method === 'GET' || method === 'HEAD';

    if (kind === 'list' && method === 'POST')
      return await handleList(ctx, req, res, parts[2] ?? '');
    if (kind === 'move' && method === 'POST' && parts.length === 2)
      return await handleMoveOrCopy(ctx, req, res, false);
    if (kind === 'copy' && method === 'POST' && parts.length === 2)
      return await handleMoveOrCopy(ctx, req, res, true);
    if (kind === 'sign') {
      const { bucket, name } = rest(2);
      if (method === 'POST' && name === '') return await handleSignMany(ctx, req, res, bucket);
      if (method === 'POST') return await handleSign(ctx, req, res, bucket, name);
      if (readMethod) return await handleSignedDownload(ctx, req, res, bucket, name, query);
    }
    if (kind === 'public' && readMethod) {
      const { bucket, name } = rest(2);
      const b = await getBucket(ctx, bucket);
      if (!b.public) throw E.bucketNotFound();
      checkName(name);
      const row = await findObject(ctx, bucket, name, null, info(req, 'object.get_public'));
      return await serveObject(ctx, req, res, row, query);
    }
    if (kind === 'info' && readMethod) {
      // /object/info/<bucket>/<name>; the "authenticated" infix is accepted too
      const from = parts[2] === 'authenticated' ? 3 : 2;
      const { bucket, name } = rest(from);
      return await handleInfo(ctx, req, res, bucket, name);
    }
    if (kind === 'upload' && parts[2] === 'sign') throw E.notEmulated('Signed upload URLs');

    // /object/authenticated/<bucket>/<name> and /object/<bucket>/<name>
    const { bucket, name } = rest(kind === 'authenticated' ? 2 : 1);
    if (readMethod) {
      const caller = resolveCaller(ctx, req);
      await getBucket(ctx, bucket);
      checkName(name);
      const row = await findObject(
        ctx,
        bucket,
        name,
        caller,
        info(req, 'object.get_authenticated'),
      );
      return await serveObject(ctx, req, res, row, query);
    }
    if (kind !== 'authenticated') {
      if (method === 'POST') return await handleUpload(ctx, req, res, bucket, name, false);
      if (method === 'PUT') return await handleUpload(ctx, req, res, bucket, name, true);
      if (method === 'DELETE') {
        const caller = resolveCaller(ctx, req);
        await getBucket(ctx, bucket);
        if (name === '') {
          const b = await readJson(req);
          const prefixes = Array.isArray(b.prefixes)
            ? b.prefixes.filter((p): p is string => typeof p === 'string')
            : null;
          if (!prefixes) throw E.badRequest('body must have required property prefixes');
          const rows = await deleteObjects(ctx, req, caller, bucket, prefixes);
          return sendJson(
            res,
            200,
            rows.map((r) => ({ ...r, owner_id: r.owner, path_tokens: r.name.split('/') })),
          );
        }
        const rows = await deleteObjects(ctx, req, caller, bucket, [name]);
        if (!rows.length) throw E.objectNotFound();
        return sendJson(res, 200, { message: 'Successfully deleted' });
      }
    }
    throw E.notEmulated(`${method} /storage/v1/${parts.join('/')}`);
  } catch (e) {
    const mapped = mapDbError(e);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (mapped instanceof StorageError) {
      if (method === 'HEAD') return sendEmpty(res, mapped.httpStatus);
      return sendStorageError(res, mapped);
    }
    if (mapped instanceof PayloadTooLargeError) return sendStorageError(res, E.tooLarge());
    if (mapped instanceof HttpError)
      return sendStorageError(
        res,
        new StorageError(mapped.status, String(mapped.status), 'InvalidRequest', mapped.message),
      );
    log('error', 'storage_error', {
      route: `${method} /storage/v1`,
      error: mapped instanceof Error ? mapped.message : String(mapped),
    });
    return sendStorageError(res, E.internal('Internal Server Error'));
  }
}

/** Housekeeping: expired TUS uploads and stale temp files. */
export async function sweepStorage(ctx: Ctx): Promise<void> {
  const removed = await tus(ctx).sweep();
  const tmpDir = path.join(ctx.cfg.storageDir, '.tmp');
  let stale = 0;
  try {
    for (const f of await fsp.readdir(tmpDir)) {
      const file = path.join(tmpDir, f);
      const st = await fsp.stat(file);
      if (Date.now() - st.mtimeMs > 3600_000) {
        await fsp.rm(file, { force: true });
        stale++;
      }
    }
  } catch {
    /* no temp directory yet */
  }
  if (removed || stale)
    log('info', 'storage_sweep', { expired_uploads: removed, stale_temp_files: stale });
}
