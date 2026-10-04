/**
 * Trigram similarity compatible with PostgreSQL `pg_trgm.similarity()`.
 *
 * pg_trgm lower-cases the text, splits it into words (maximal runs of alphanumeric
 * characters), pads every word with two blanks in front and one behind, and collects the
 * distinct three-character windows. similarity = |A ∩ B| / |A ∪ B|.
 *
 * Callers normally pass `norm()`-ed strings (as the server does), so tashkeel and Latin
 * accents never reach this function.
 */

/** Word characters: letters, decimal digits (any script) and letter numbers. */
const WORD_RE = /[\p{L}\p{Nd}\p{Nl}]+/gu;

/** The distinct trigrams of a text, as pg_trgm `show_trgm()` would list them. */
export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(WORD_RE)) {
    // Code points, not UTF-16 units: pg_trgm counts characters.
    const chars = Array.from('  ' + match[0] + ' ');
    for (let i = 0; i + 2 < chars.length; i++) {
      out.add(chars[i]! + chars[i + 1]! + chars[i + 2]!);
    }
  }
  return out;
}

/** Similarity of two trigram sets (0..1). Two empty sets give 0, as in PostgreSQL. */
export function trigramSetSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** pg_trgm `similarity(a, b)`: 0 (nothing in common) .. 1 (same trigram set). */
export function similarity(a: string, b: string): number {
  return trigramSetSimilarity(trigrams(a), trigrams(b));
}
