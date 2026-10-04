import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from './state';

/** Flat dictionary as shipped in `locales/<lang>.json`: `"namespace.key": "text with {placeholders}"`. */
export type Messages = Record<string, string>;
export type Params = Record<string, string | number>;

const dictionaries: Partial<Record<Locale, Messages>> = {};
const pluralRules = new Map<Locale, Intl.PluralRules>();
const warned = new Set<string>();

/** Registers (or extends) the dictionary of a language. */
export function defineMessages(
  lang: Locale,
  messages: Messages,
  mode: 'merge' | 'replace' = 'merge',
): void {
  dictionaries[lang] =
    mode === 'replace' ? { ...messages } : { ...dictionaries[lang], ...messages };
}

export function hasMessages(lang: Locale): boolean {
  return dictionaries[lang] !== undefined;
}

function rules(lang: Locale): Intl.PluralRules {
  let r = pluralRules.get(lang);
  if (!r) {
    r = new Intl.PluralRules(INTL_LOCALE[lang]);
    pluralRules.set(lang, r);
  }
  return r;
}

/**
 * Keys tried for a message, most specific first.
 * Plural convention: `key_zero`, `key_one`, `key_two`, `key_few`, `key_many`, `key_other`
 * (CLDR categories from `Intl.PluralRules`; Arabic uses all six). `key_zero` is also used
 * for an exact 0 in languages whose rules have no "zero" category, so "No pending items"
 * can be written in English and Swahili too.
 */
export function candidateKeys(lang: Locale, key: string, count: unknown): string[] {
  if (typeof count !== 'number' || !Number.isFinite(count)) return [key];
  const keys = [`${key}_${rules(lang).select(count)}`, `${key}_other`, key];
  if (count === 0) keys.unshift(`${key}_zero`);
  return [...new Set(keys)];
}

/** The raw template for a key: current language first, then the default language (Arabic). */
export function findTemplate(lang: Locale, key: string, count?: unknown): string | undefined {
  const languages = lang === DEFAULT_LOCALE ? [lang] : [lang, DEFAULT_LOCALE];
  for (const l of languages) {
    const dict = dictionaries[l];
    if (!dict) continue;
    for (const candidate of candidateKeys(l, key, count)) {
      const text = dict[candidate];
      if (typeof text === 'string' && text !== '') return text;
    }
  }
  return undefined;
}

/** Replaces `{name}` placeholders. Unknown placeholders are left untouched. */
export function interpolate(
  template: string,
  params: Params | undefined,
  formatNumber: (n: number) => string,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    // Only `count` is formatted as a quantity; other numbers (years, codes, coordinates) stay verbatim.
    return typeof value === 'number' && name === 'count' ? formatNumber(value) : String(value);
  });
}

export function translate(
  lang: Locale,
  key: string,
  params: Params | undefined,
  formatNumber: (n: number) => string,
): string {
  const template = findTemplate(lang, key, params?.count);
  if (template === undefined) {
    // Missing key: show the key itself so the gap is visible, and say so once in development.
    if (import.meta.env?.DEV && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing translation: ${key}`);
    }
    return key;
  }
  return interpolate(template, params, formatNumber);
}

/** Test helper: forget "already warned" keys. */
export function resetMissingWarnings(): void {
  warned.clear();
}
