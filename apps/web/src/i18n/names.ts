import { locale, type Locale } from './state';

export interface NamedRow {
  name_ar?: string | null;
  name_en?: string | null;
  name_sw?: string | null;
  name_latin?: string | null;
}

type NameField = keyof NamedRow;

/** Preferred field first, then the closest alternatives (brief §8: fall back to whatever exists). */
const ORDER: Record<Locale, readonly NameField[]> = {
  ar: ['name_ar', 'name_en', 'name_latin', 'name_sw'],
  sw: ['name_sw', 'name_en', 'name_latin', 'name_ar'],
  en: ['name_en', 'name_latin', 'name_sw', 'name_ar'],
};

/** Display name of a place, option, person or project in the interface language. */
export function pickName(row: NamedRow | undefined | null): string {
  if (!row) return '';
  for (const field of ORDER[locale.value]) {
    const value = row[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}
