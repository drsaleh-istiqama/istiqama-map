import { signal, type Signal } from '@preact/signals';

export type Locale = 'ar' | 'sw' | 'en';

export const LOCALES: readonly Locale[] = ['ar', 'sw', 'en'];
/** Arabic is the default language (brief §8) and the only one bundled with the shell. */
export const DEFAULT_LOCALE: Locale = 'ar';
/** Key used with `lib/prefs` to remember the language chosen on this device. */
export const LOCALE_PREF = 'locale';

/**
 * Digits policy for Arabic — the ONE place to change it. `nu-latn` keeps Western digits so
 * that project codes, coordinates and phone numbers read the same in every language.
 * Switch to plain 'ar' (or 'ar-u-nu-arab') if the designers ask for Arabic-Indic digits.
 */
export const ARABIC_INTL_LOCALE = 'ar-u-nu-latn';

/** BCP 47 tags handed to `Intl`. English uses day-month-year order, as East Africa and Oman do. */
export const INTL_LOCALE: Record<Locale, string> = {
  ar: ARABIC_INTL_LOCALE,
  sw: 'sw',
  en: 'en-GB',
};

export function isLocale(value: unknown): value is Locale {
  return value === 'ar' || value === 'sw' || value === 'en';
}

/** Active language. Changed only by `setLocale()` once the dictionary is loaded. */
export const locale: Signal<Locale> = signal<Locale>(DEFAULT_LOCALE);

export function directionOf(l: Locale): 'rtl' | 'ltr' {
  return l === 'ar' ? 'rtl' : 'ltr';
}
