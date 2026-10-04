/**
 * i18n public API (docs/contracts/web.md §3.2).
 *
 * Arabic (the default language) is bundled with the shell so the first paint has text;
 * Swahili and English are separate chunks loaded on demand and precached by the service
 * worker. `t()` and `fmt.*` read the `locale` signal, so every component that calls them
 * re-renders when the language changes.
 */
import arMessages from '../../locales/ar.json';
import { getPref, setPref } from '../lib/prefs';
import { fmt } from './format';
import { defineMessages, findTemplate, translate, type Messages, type Params } from './messages';
import { DEFAULT_LOCALE, directionOf, isLocale, locale, LOCALE_PREF, type Locale } from './state';

export { fmt } from './format';
export { pickName, type NamedRow } from './names';
export {
  ARABIC_INTL_LOCALE,
  DEFAULT_LOCALE,
  INTL_LOCALE,
  isLocale,
  LOCALES,
  locale,
  type Locale,
} from './state';
export type { Messages, Params } from './messages';

defineMessages(DEFAULT_LOCALE, arMessages as Messages);

const loaders: Record<Exclude<Locale, 'ar'>, () => Promise<{ default: Messages }>> = {
  sw: () => import('../../locales/sw.json'),
  en: () => import('../../locales/en.json'),
};

function applyToDocument(l: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = l;
  document.documentElement.dir = directionOf(l);
}

/** Languages whose shipped dictionary is in memory. */
const loadedLocales = new Set<Locale>([DEFAULT_LOCALE]);
let latestRequest = 0;

async function activate(l: Locale, persist: boolean): Promise<void> {
  const request = ++latestRequest;
  if (l !== 'ar' && !loadedLocales.has(l)) {
    const loaded = await loaders[l]();
    defineMessages(l, loaded.default);
    loadedLocales.add(l);
  }
  // A newer call won the race while the dictionary was loading.
  if (request !== latestRequest) return;
  locale.value = l;
  applyToDocument(l);
  if (persist) setPref(LOCALE_PREF, l);
}

/**
 * Switches the interface language: loads the dictionary, sets `<html lang dir>` and remembers
 * the choice on this device. Rejects (and changes nothing) when the dictionary cannot be loaded.
 */
export function setLocale(l: Locale): Promise<void> {
  return activate(l, true);
}

/** The language explicitly chosen on this device, or null when the user never chose one. */
export function savedLocale(): Locale | null {
  const saved = getPref<unknown>(LOCALE_PREF, null);
  return isLocale(saved) ? saved : null;
}

/** Call once before the first render: restores the saved language (Arabic when none or on failure). */
export async function initI18n(): Promise<void> {
  try {
    await activate(savedLocale() ?? DEFAULT_LOCALE, false);
  } catch {
    applyToDocument(locale.value);
  }
}

/**
 * Translates `namespace.key`. `{name}` placeholders are filled from `params`; a numeric
 * `params.count` selects the plural form (`key_one`, `key_few`, `key_other`, …).
 * A key missing in the active language falls back to Arabic, then to the key itself.
 */
export function t(key: string, params?: Params): string {
  return translate(locale.value, key, params, fmt.number);
}

/** True when `key` (or one of its plural forms for `count`) can be translated. Never warns. */
export function hasTranslation(key: string, count?: number): boolean {
  return findTemplate(locale.value, key, count) !== undefined;
}

export function dir(): 'rtl' | 'ltr' {
  return directionOf(locale.value);
}
