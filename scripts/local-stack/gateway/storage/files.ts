/** File-system helpers for request bodies. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';

export interface ReceiveResult {
  written: number;
  /** The client went away before the request body ended; the received bytes were kept. */
  aborted: boolean;
  /** More bytes arrived than allowed; nothing beyond the limit was written. */
  overflow: boolean;
  /** Hex MD5 of the written bytes (only when `md5` was requested). */
  md5?: string;
}

/**
 * Stream a request body into a file without ever writing more than `maxBytes`.
 * The request is never destroyed, so the caller can still answer (413, 400…) afterwards.
 */
export function streamToFile(
  req: IncomingMessage,
  file: string,
  opts: { append?: boolean; maxBytes: number; md5?: boolean },
): Promise<ReceiveResult> {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file, { flags: opts.append ? 'a' : 'w' });
    const hash = opts.md5 ? crypto.createHash('md5') : null;
    let written = 0;
    let finished = false;
    const finish = (aborted: boolean, overflow: boolean): void => {
      if (finished) return;
      finished = true;
      ws.end(() =>
        resolve({ written, aborted, overflow, ...(hash ? { md5: hash.digest('hex') } : {}) }),
      );
    };
    ws.on('error', (e) => {
      if (!finished) {
        finished = true;
        reject(e);
      }
    });
    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      if (written + chunk.length > opts.maxBytes) {
        finish(false, true);
        return;
      }
      written += chunk.length;
      hash?.update(chunk);
      if (!ws.write(chunk)) {
        req.pause();
        ws.once('drain', () => req.resume());
      }
    });
    req.on('end', () => finish(false, false));
    req.on('aborted', () => finish(true, false));
    req.on('error', () => finish(true, false));
    req.on('close', () => finish(!req.complete, false));
  });
}

/** MD5 of a file, or a cheap size+mtime tag for very large files (PMTiles archives). */
export async function fileEtag(file: string, size: number): Promise<string> {
  if (size > 64 * 1024 * 1024) {
    const st = await fs.promises.stat(file);
    return `${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}`;
  }
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
