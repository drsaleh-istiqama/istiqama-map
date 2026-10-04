/**
 * The file side of a pack: `pmtiles extract` (the installed go-pmtiles CLI), header check and
 * SHA-256 of the result.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { checkLayout, HEADER_BYTES, parseHeader, type PmtilesHeader } from './header.ts';

/** Reads and validates the header of a local archive (throws InvalidArchiveError). */
export async function readArchiveHeader(file: string): Promise<{ header: PmtilesHeader; bytes: number }> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = new Uint8Array(HEADER_BYTES);
    await handle.read(buffer, 0, HEADER_BYTES, 0);
    const header = parseHeader(buffer);
    checkLayout(header, size);
    return { header, bytes: size };
  } finally {
    await handle.close();
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

export interface ExtractInput {
  tool: string;
  source: string;
  out: string;
  /** GeoJSON Polygon / MultiPolygon file of the area (or `bbox`). */
  regionFile?: string;
  bbox?: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  dryRun?: boolean;
}

/** Arguments of `pmtiles extract` (separate for the tests). */
export function extractArgs(input: ExtractInput): string[] {
  const args = ['extract', input.source, input.out];
  if (input.regionFile) args.push(`--region=${input.regionFile}`);
  else if (input.bbox) args.push(`--bbox=${input.bbox.join(',')}`);
  else throw new Error('extract needs a region file or a bbox');
  args.push(`--maxzoom=${input.maxZoom}`);
  if (input.minZoom > 0) args.push(`--minzoom=${input.minZoom}`);
  if (input.dryRun) args.push('--dry-run');
  return args;
}

/** Runs the CLI; resolves with its combined output, rejects on a non-zero exit. */
export function runExtract(input: ExtractInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.tool, extractArgs(input), { windowsHide: true });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      // The progress bar redraws with \r: keep the last state of every line only.
      const clean = output
        .split('\n')
        .map((line) => line.split('\r').pop() ?? '')
        .join('\n')
        .trim();
      if (code === 0) resolve(clean);
      else reject(new Error(`pmtiles extract failed (exit ${code}):\n${clean}`));
    });
  });
}

export async function fileSize(file: string): Promise<number> {
  return (await stat(file)).size;
}
