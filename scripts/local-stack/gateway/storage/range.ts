/**
 * HTTP Range header (RFC 9110 §14) for single byte ranges — what PMTiles readers, browsers
 * and download managers send. Multi-range requests and unknown units are ignored (the full
 * representation is served), as the RFC allows.
 */
export type RangeResult =
  { kind: 'none' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' };

export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!m) return { kind: 'none' };
  const spec = m[1]!.trim();
  if (spec.includes(',')) return { kind: 'none' };
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!r || (r[1] === '' && r[2] === '')) return { kind: 'none' };

  if (r[1] === '') {
    // suffix range: the last N bytes
    const n = Number(r[2]);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(r[1]);
  if (!Number.isSafeInteger(start)) return { kind: 'none' };
  if (start >= size) return { kind: 'unsatisfiable' };
  if (r[2] === '') return { kind: 'range', start, end: size - 1 };
  const end = Number(r[2]);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'none' };
  return { kind: 'range', start, end: Math.min(end, size - 1) };
}
