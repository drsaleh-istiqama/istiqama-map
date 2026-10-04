/**
 * Search tokens for the local (offline) index. A row stores the distinct normalised words
 * of its searchable texts in a multiEntry index (`*_tokens`); a query word matches a row
 * when some token STARTS WITH it (index range scan, no table read).
 *
 * Differences from the server `search` RPC, which matches substrings with trigram indexes:
 * the local index finds word prefixes only. To keep the most common Arabic case working,
 * a word with the definite article is indexed with and without it ("النور" → also "نور").
 */
import { norm } from '../lib/normalize';

const SPLIT_RE = /[^\p{L}\p{N}]+/u;
const ZERO_PADDED_RE = /^0+[0-9]+$/;
const MAX_TOKEN_LENGTH = 32;
const MAX_TOKENS = 48;

const ALEF_LAM = String.fromCodePoint(0x0627, 0x0644);

/** "النور" → "نور" (only when at least three letters remain); otherwise `null`. */
export function stripArabicArticle(word: string): string | null {
  return word.length >= 5 && word.startsWith(ALEF_LAM) ? word.slice(2) : null;
}

/** The normalised words of a text (no variants), in order of appearance. */
export function words(text: string | null | undefined): string[] {
  if (!text) return [];
  return norm(text)
    .split(SPLIT_RE)
    .filter((w) => w.length > 0);
}

/**
 * Tokens to store for the given texts: words of two or more characters, their
 * article-less form, and numbers without leading zeros (`000123` → also `123`, so a project
 * code can be found by its number).
 */
export function tokenize(...texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const raw of words(text)) {
      if (out.size >= MAX_TOKENS) break;
      const w = raw.length > MAX_TOKEN_LENGTH ? raw.slice(0, MAX_TOKEN_LENGTH) : raw;
      if (ZERO_PADDED_RE.test(w)) out.add(w.replace(/^0+(?=[0-9])/, ''));
      if (w.length < 2) continue;
      out.add(w);
      const bare = stripArabicArticle(w);
      if (bare) out.add(bare);
    }
  }
  return Array.from(out);
}

/**
 * Words of a search query, ready for prefix lookups: normalised, de-duplicated, article
 * stripped (the stored tokens contain both forms, so "النور" and "نور" find the same rows).
 * One-character words are ignored, so a query shorter than two characters yields no words
 * (same rule as the server).
 */
export function queryWords(q: string): string[] {
  const out = new Set<string>();
  for (const raw of words(q)) {
    const w = raw.length > MAX_TOKEN_LENGTH ? raw.slice(0, MAX_TOKEN_LENGTH) : raw;
    if (w.length < 2) continue;
    out.add(stripArabicArticle(w) ?? w);
  }
  return Array.from(out);
}

/** True when every query word is a prefix of at least one token. */
export function matchesAllWords(
  tokens: readonly string[] | undefined,
  qWords: readonly string[],
): boolean {
  if (!tokens || tokens.length === 0) return qWords.length === 0;
  for (const w of qWords) {
    let hit = false;
    for (const t of tokens) {
      if (t.startsWith(w)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return true;
}

/**
 * 0..1 — how well the tokens answer the query: 1 when every word is a whole token, lower
 * when words only start a token (the shorter the completion, the better).
 */
export function matchQuality(
  tokens: readonly string[] | undefined,
  qWords: readonly string[],
): number {
  if (!tokens || qWords.length === 0) return 0;
  let sum = 0;
  for (const w of qWords) {
    let best = 0;
    for (const t of tokens) {
      if (!t.startsWith(w)) continue;
      const q = t.length === w.length ? 1 : w.length / t.length;
      if (q > best) best = q;
      if (best === 1) break;
    }
    if (best === 0) return 0;
    sum += best;
  }
  return sum / qWords.length;
}
