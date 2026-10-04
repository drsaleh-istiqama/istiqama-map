import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prefStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../lib/prefs', () => ({
  getPref: <T>(key: string, fallback: T): T =>
    prefStore.has(key) ? (prefStore.get(key) as T) : fallback,
  setPref: (key: string, value: unknown): void => {
    if (value === null || value === undefined) prefStore.delete(key);
    else prefStore.set(key, value);
  },
}));

import {
  ARABIC_INTL_LOCALE,
  dir,
  fmt,
  hasTranslation,
  initI18n,
  locale,
  pickName,
  savedLocale,
  setLocale,
  t,
} from './index';
import { candidateKeys, defineMessages, interpolate, resetMissingWarnings } from './messages';

const TEST_AR = {
  'test.hello': 'مرحبًا {name}',
  'test.onlyArabic': 'نص عربي فقط',
  'test.items_zero': 'لا عناصر',
  'test.items_one': 'عنصر واحد',
  'test.items_two': 'عنصران',
  'test.items_few': '{count} عناصر',
  'test.items_many': '{count} عنصرًا',
  'test.items_other': '{count} عنصر',
  'test.partial_other': '{count} (أخرى)',
  'test.year': 'سنة {year}',
};
const TEST_EN = {
  'test.hello': 'Hello {name}',
  'test.items_zero': 'No items',
  'test.items_one': '{count} item',
  'test.items_other': '{count} items',
  'test.year': 'Year {year}',
};

beforeEach(async () => {
  prefStore.clear();
  resetMissingWarnings();
  defineMessages('ar', TEST_AR);
  defineMessages('en', TEST_EN);
  await setLocale('ar');
  prefStore.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('t()', () => {
  it('returns shipped Arabic text by default (Arabic is bundled)', () => {
    expect(locale.value).toBe('ar');
    expect(t('nav.maintenance')).toBe('الصيانة');
    expect(t('common.appName')).toBe('خارطة مشاريع الاستقامة');
  });

  it('interpolates {placeholders} and leaves unknown ones untouched', () => {
    expect(t('test.hello', { name: 'سالم' })).toBe('مرحبًا سالم');
    expect(t('test.hello')).toBe('مرحبًا {name}');
    expect(interpolate('{a}-{b}-{a}', { a: 1, b: 'x' }, String)).toBe('1-x-1');
  });

  it('formats only `count` as a quantity; other numbers stay verbatim', () => {
    expect(t('test.year', { year: 2026 })).toBe('سنة 2026');
    expect(t('test.items', { count: 100000 })).toBe('100,000 عنصر');
  });

  it('selects all six Arabic plural categories', () => {
    expect(t('test.items', { count: 0 })).toBe('لا عناصر');
    expect(t('test.items', { count: 1 })).toBe('عنصر واحد');
    expect(t('test.items', { count: 2 })).toBe('عنصران');
    expect(t('test.items', { count: 3 })).toBe('3 عناصر');
    expect(t('test.items', { count: 10 })).toBe('10 عناصر');
    expect(t('test.items', { count: 11 })).toBe('11 عنصرًا');
    expect(t('test.items', { count: 99 })).toBe('99 عنصرًا');
    expect(t('test.items', { count: 100 })).toBe('100 عنصر');
  });

  it('falls back to the _other form when a category is not translated', () => {
    expect(t('test.partial', { count: 2 })).toBe('2 (أخرى)');
    expect(candidateKeys('ar', 'k', 2)).toEqual(['k_two', 'k_other', 'k']);
  });

  it('uses English plural rules in English, and key_zero for an exact zero', async () => {
    await setLocale('en');
    expect(t('test.items', { count: 1 })).toBe('1 item');
    expect(t('test.items', { count: 2 })).toBe('2 items');
    expect(t('test.items', { count: 0 })).toBe('No items');
    expect(candidateKeys('en', 'k', 0)).toEqual(['k_zero', 'k_other', 'k']);
  });

  it('falls back to Arabic when the active language lacks a key', async () => {
    await setLocale('en');
    expect(t('test.onlyArabic')).toBe('نص عربي فقط');
  });

  it('returns the key itself and warns once in development when nothing matches', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(t('test.doesNotExist')).toBe('test.doesNotExist');
    expect(t('test.doesNotExist')).toBe('test.doesNotExist');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('test.doesNotExist');
  });

  it('hasTranslation() answers without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(hasTranslation('test.hello')).toBe(true);
    expect(hasTranslation('test.items', 5)).toBe(true);
    expect(hasTranslation('sync.error_not_a_real_key')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('setLocale()', () => {
  it('loads the lazy dictionaries, sets <html lang dir> and persists the choice', async () => {
    await setLocale('sw');
    expect(locale.value).toBe('sw');
    expect(document.documentElement.lang).toBe('sw');
    expect(document.documentElement.dir).toBe('ltr');
    expect(dir()).toBe('ltr');
    expect(prefStore.get('locale')).toBe('sw');
    expect(t('nav.maintenance')).toBe('Matengenezo');

    await setLocale('en');
    expect(t('nav.maintenance')).toBe('Maintenance');
    expect(document.documentElement.dir).toBe('ltr');

    await setLocale('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(dir()).toBe('rtl');
  });

  it('initI18n() restores the saved language and defaults to Arabic', async () => {
    expect(savedLocale()).toBeNull();
    prefStore.set('locale', 'en');
    await initI18n();
    expect(locale.value).toBe('en');
    expect(savedLocale()).toBe('en');

    prefStore.set('locale', 'xx');
    await initI18n();
    expect(locale.value).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });
});

describe('pickName()', () => {
  const place = { name_ar: 'بيمبا', name_en: 'Pemba', name_sw: 'Pemba (sw)' };

  it('prefers the field of the interface language', async () => {
    expect(pickName(place)).toBe('بيمبا');
    await setLocale('sw');
    expect(pickName(place)).toBe('Pemba (sw)');
    await setLocale('en');
    expect(pickName(place)).toBe('Pemba');
  });

  it('falls back to the other names when the preferred one is missing or blank', async () => {
    expect(pickName({ name_ar: '  ', name_en: 'Tanga' })).toBe('Tanga');
    expect(pickName({ name_latin: 'Masjid Nuur' })).toBe('Masjid Nuur');
    await setLocale('en');
    expect(pickName({ name_ar: 'مسجد النور', name_latin: 'Masjid Nuur' })).toBe('Masjid Nuur');
    expect(pickName({ name_ar: 'مسجد النور' })).toBe('مسجد النور');
    await setLocale('sw');
    expect(pickName({ name_en: 'Kenya', name_ar: 'كينيا' })).toBe('Kenya');
  });

  it('returns an empty string for nothing', () => {
    expect(pickName(undefined)).toBe('');
    expect(pickName({})).toBe('');
    expect(pickName({ name_ar: null })).toBe('');
  });
});

describe('fmt', () => {
  it('keeps Latin digits in Arabic (one constant decides)', () => {
    expect(ARABIC_INTL_LOCALE).toBe('ar-u-nu-latn');
    expect(fmt.number(1234567.5)).toBe('1,234,567.5');
    expect(fmt.number(1234567.5)).not.toMatch(/[٠-٩]/);
  });

  it('formats percentages given on the 0..100 scale', async () => {
    await setLocale('en');
    expect(fmt.percent(60)).toBe('60%');
    expect(fmt.percent(12.34)).toBe('12.3%');
  });

  it('formats dates through Intl in the interface language', async () => {
    await setLocale('en');
    expect(fmt.date('2026-10-03')).toBe('3 Oct 2026');
    expect(fmt.dateTime('2026-10-03T10:00:00Z')).toContain('2026');
    await setLocale('ar');
    expect(fmt.date('2026-10-03')).toBe('3 أكتوبر 2026');
    expect(fmt.date('2026-10-03')).not.toMatch(/[٠-٩]/);
    await setLocale('sw');
    expect(fmt.date('2026-10-03')).toBe('3 Okt 2026');
  });

  it('treats a bare SQL date as that calendar day in every time zone', async () => {
    await setLocale('en');
    expect(fmt.date('2026-01-01')).toBe('1 Jan 2026');
  });

  it('returns an empty string for an invalid date instead of throwing', () => {
    expect(fmt.date('not a date')).toBe('');
    expect(fmt.dateTime('')).toBe('');
    expect(fmt.relative('nope')).toBe('');
  });

  it('formats relative times', async () => {
    await setLocale('en');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    try {
      expect(fmt.relative(new Date('2026-10-03T11:59:50Z'))).toBe('now');
      expect(fmt.relative(new Date('2026-10-03T11:55:00Z'))).toBe('5 minutes ago');
      expect(fmt.relative(new Date('2026-10-03T09:00:00Z'))).toBe('3 hours ago');
      expect(fmt.relative(new Date('2026-10-02T12:00:00Z'))).toBe('yesterday');
      expect(fmt.relative(new Date('2026-10-05T12:00:00Z'))).toBe('in 2 days');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows currencies by ISO code, never mixing symbols', async () => {
    await setLocale('en');
    expect(fmt.currency(1500, 'TZS')).toMatch(/TZS/);
    expect(fmt.currency(1500, 'USD')).toMatch(/USD/);
    expect(fmt.currency(1500, 'USD')).toMatch(/1,500/);
    expect(fmt.currency(5, 'not-a-code')).toBe('5 not-a-code');
  });

  it('formats byte sizes in binary steps', async () => {
    await setLocale('en');
    expect(fmt.bytes(0)).toMatch(/^0\s?byte/);
    expect(fmt.bytes(1536)).toBe('1.5 kB');
    expect(fmt.bytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(fmt.bytes(3.2 * 1024 ** 3)).toBe('3.2 GB');
  });
});
