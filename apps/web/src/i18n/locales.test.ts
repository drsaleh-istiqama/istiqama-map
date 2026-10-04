/**
 * Same checks as `scripts/merge-locales.ts --check`, as a unit test (docs/contracts/web.md §1):
 * the three languages have exactly the same keys, no text is empty, placeholders agree, and the
 * shipped `locales/<lang>.json` files are what the fragments produce.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LANGS = ['ar', 'sw', 'en'] as const;
type Lang = (typeof LANGS)[number];

const localesDir = path.resolve(__dirname, '..', '..', 'locales');
const partsDir = path.join(localesDir, '_parts');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function mergeFragments(): { merged: Record<Lang, Record<string, string>>; problems: string[] } {
  const merged: Record<Lang, Record<string, string>> = { ar: {}, sw: {}, en: {} };
  const problems: string[] = [];
  for (const file of fs
    .readdirSync(partsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const match = /^([a-z0-9-]+)\.(ar|sw|en)\.json$/.exec(file);
    if (!match) {
      problems.push(`unexpected fragment name: ${file}`);
      continue;
    }
    const namespace = match[1] as string;
    const lang = match[2] as Lang;
    for (const [key, value] of Object.entries(readJson(path.join(partsDir, file)))) {
      if (typeof value !== 'string') problems.push(`${file}: "${key}" must be a string`);
      else merged[lang][`${namespace}.${key}`] = value;
    }
  }
  return { merged, problems };
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

describe('locale files', () => {
  const { merged, problems } = mergeFragments();
  const allKeys = [...new Set(LANGS.flatMap((lang) => Object.keys(merged[lang])))].sort();

  it('fragments are well-formed', () => {
    expect(problems).toEqual([]);
    expect(allKeys.length).toBeGreaterThan(0);
  });

  it('Arabic, Swahili and English have identical key sets', () => {
    const missing = allKeys.flatMap((key) =>
      LANGS.filter((lang) => !(key in merged[lang])).map((lang) => `${key} is missing in ${lang}`),
    );
    expect(missing).toEqual([]);
  });

  it('no translation is empty', () => {
    const empty = LANGS.flatMap((lang) =>
      Object.entries(merged[lang])
        .filter(([, text]) => text.trim() === '')
        .map(([key]) => `${lang}: ${key}`),
    );
    expect(empty).toEqual([]);
  });

  it('placeholders are the same in every language (plural forms may omit {count})', () => {
    const different: string[] = [];
    for (const key of allKeys) {
      const reference = placeholders(merged.ar[key] ?? '');
      const isPlural = PLURAL_SUFFIX.test(key);
      for (const lang of LANGS) {
        const own = placeholders(merged[lang][key] ?? '');
        const relevant = (list: string[]): string =>
          list.filter((p) => !(isPlural && p === 'count')).join(',');
        if (relevant(own) !== relevant(reference))
          different.push(`${key}: ar {${reference}} vs ${lang} {${own}}`);
      }
    }
    expect(different).toEqual([]);
  });

  it('the shell namespaces exist in all three languages', () => {
    for (const namespace of ['common', 'nav', 'settings', 'ui']) {
      for (const lang of LANGS) {
        expect(
          fs.existsSync(path.join(partsDir, `${namespace}.${lang}.json`)),
          `${namespace}.${lang}.json`,
        ).toBe(true);
      }
    }
  });

  it('shipped locales/<lang>.json are up to date (run: npm run locales -w apps/web)', () => {
    for (const lang of LANGS) {
      const sorted = Object.fromEntries(
        Object.entries(merged[lang]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      expect(readJson(path.join(localesDir, `${lang}.json`)), `${lang}.json`).toEqual(sorted);
    }
  });
});
