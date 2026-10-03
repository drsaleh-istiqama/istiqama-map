/**
 * Arabic / Swahili names and short codes for boundaries (names.json), and the derivation of
 * short codes for level-1 areas that names.json does not know.
 *
 * geoBoundaries only carries one (mostly English) name per shape. names.json maps the
 * well-known areas of each country to name_ar / name_sw and to the 2-3 character short_code
 * used inside project codes (TZ-PN-000123). Unknown areas keep name_en only; the web app
 * falls back to the name that exists (brief section 8).
 */
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPT_DIR } from './cli.ts';

export interface NameEntry {
  /** Administrative level the entry applies to (default 1). */
  level?: number;
  /** ISO 3166-2 code; matched against the shapeISO of the source. */
  iso?: string;
  /** Source names (any spelling variant) that identify the area. */
  match: string[];
  name_ar?: string;
  name_sw?: string;
  /** Replaces the source name when the source spelling is poor. */
  name_en?: string;
  /** Level 1 only: 2-3 characters [A-Z0-9], unique per country. */
  short_code?: string;
}

interface NamesFile {
  countries: Record<string, NameEntry[]>;
}

/** Comparison key for place names: no case, diacritics, punctuation or spaces. */
export function nameKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

export class NameIndex {
  private readonly byIso = new Map<string, NameEntry>();
  private readonly byName = new Map<string, NameEntry>();

  constructor(file: string = path.join(SCRIPT_DIR, 'names.json')) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as NamesFile;
    for (const [iso2, entries] of Object.entries(parsed.countries ?? {})) {
      for (const entry of entries) {
        const level = entry.level ?? 1;
        if (entry.iso) this.byIso.set(`${iso2}|${level}|${entry.iso.toUpperCase()}`, entry);
        for (const name of entry.match ?? []) {
          this.byName.set(`${iso2}|${level}|${nameKey(name)}`, entry);
        }
      }
    }
  }

  find(iso2: string, level: number, nameEn: string, iso: string | null): NameEntry | null {
    if (iso !== null) {
      const hit = this.byIso.get(`${iso2}|${level}|${iso.toUpperCase()}`);
      if (hit) return hit;
    }
    return this.byName.get(`${iso2}|${level}|${nameKey(nameEn)}`) ?? null;
  }
}

// --- short codes ---------------------------------------------------------------------------

const SHORT_CODE = /^[A-Z0-9]{2,3}$/;
/** Words that say nothing about the place itself. */
const FILLER_WORDS = new Set([
  'REGION',
  'PROVINCE',
  'COUNTY',
  'DISTRICT',
  'GOVERNORATE',
  'STATE',
  'CITY',
  'OF',
  'THE',
  'AND',
  'DE',
  'DO',
  'DA',
  'ES',
  'AL',
  'AD',
  'AN',
  'AR',
  'AS',
  'ASH',
  'AZ',
  'WILAYAT',
  'MKOA',
  'WA',
]);
const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

/** Candidate short codes for a name, best first. */
export function shortCodeCandidates(nameEn: string, iso: string | null): string[] {
  const out: string[] = [];
  const add = (code: string): void => {
    if (SHORT_CODE.test(code) && !out.includes(code)) out.push(code);
  };

  // 1. The subdivision part of the ISO 3166-2 code ("BI-GI" -> "GI", "KE-28" -> "28").
  if (iso !== null) add(iso.slice(iso.indexOf('-') + 1).toUpperCase());

  const ascii = nameEn
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  const allWords = ascii.split(' ').filter((w) => w !== '');
  const words = allWords.filter((w) => !FILLER_WORDS.has(w));
  const significant = words.length > 0 ? words : allWords;
  const first = significant[0] ?? '';
  const second = significant[1] ?? '';

  // 2. Initials of the first two words ("North Pemba" -> "NP").
  if (second !== '') add(first.charAt(0) + second.charAt(0));
  // 3. First two letters ("Tanga" -> "TA").
  add(first.slice(0, 2));
  // 4. First letter + a later consonant, then any later letter ("TN", "TG", ...).
  const rest = (first.slice(1) + second).split('');
  for (const ch of rest) if (!VOWELS.has(ch)) add(first.charAt(0) + ch);
  for (const ch of rest) add(first.charAt(0) + ch);
  // 5. Three characters.
  add(first.slice(0, 3));
  if (second !== '') add(first.slice(0, 2) + second.charAt(0));
  for (const ch of rest.slice(1)) add(first.slice(0, 2) + ch);
  // 6. First letter + digit, as a last resort.
  if (first !== '') for (let d = 1; d <= 9; d++) add(first.charAt(0) + String(d));
  return out;
}

export interface ShortCodeInput {
  code: string;
  nameEn: string;
  iso: string | null;
  /** short_code from names.json, when the area is known there. */
  preferred: string | null;
}

/**
 * Assigns a unique short code to every level-1 area of one country.
 * Codes already stored in the database are kept; names.json comes next; the rest is derived.
 */
export function assignShortCodes(
  areas: ShortCodeInput[],
  existing: Map<string, string>,
): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  const ordered = [...areas].sort(
    (a, b) => a.nameEn.localeCompare(b.nameEn, 'en') || a.code.localeCompare(b.code, 'en'),
  );

  for (const area of ordered) {
    const current = existing.get(area.code);
    if (current !== undefined && SHORT_CODE.test(current) && !used.has(current)) {
      result.set(area.code, current);
      used.add(current);
    }
  }
  // Codes of areas that are in the database but not in this file stay reserved.
  for (const current of existing.values()) used.add(current);

  for (const area of ordered) {
    if (result.has(area.code) || area.preferred === null) continue;
    const preferred = area.preferred.toUpperCase();
    if (SHORT_CODE.test(preferred) && !used.has(preferred)) {
      result.set(area.code, preferred);
      used.add(preferred);
    }
  }
  for (const area of ordered) {
    if (result.has(area.code)) continue;
    let chosen = shortCodeCandidates(area.nameEn, area.iso).find((c) => !used.has(c));
    for (let n = 0; chosen === undefined && n < 36 * 36; n++) {
      const candidate = n.toString(36).toUpperCase().padStart(2, '0');
      if (!used.has(candidate)) chosen = candidate;
    }
    if (chosen !== undefined) {
      result.set(area.code, chosen);
      used.add(chosen);
    }
  }
  return result;
}
