import { INTL_LOCALE, locale } from './state';

/** `Intl` objects are expensive to build on low-end phones: one instance per (locale, shape). */
const cache = new Map<string, unknown>();

function cached<T>(shape: string, make: (tag: string) => T): T {
  // Reading the signal subscribes the calling component, so formatted text follows the language.
  const tag = INTL_LOCALE[locale.value];
  const key = `${tag}|${shape}`;
  let hit = cache.get(key) as T | undefined;
  if (hit === undefined) {
    hit = make(tag);
    cache.set(key, hit);
  }
  return hit;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toDate(d: string | Date): Date | null {
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A bare `YYYY-MM-DD` (SQL `date`) has no time zone: format it as that calendar day everywhere. */
function zoneFor(d: string | Date): 'UTC' | undefined {
  return typeof d === 'string' && DATE_ONLY.test(d) ? 'UTC' : undefined;
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_557_600],
  ['month', 2_629_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

export const fmt = {
  number(n: number): string {
    return cached('number', (tag) => new Intl.NumberFormat(tag)).format(n);
  },

  /** `n` is a percentage on the 0..100 scale, as stored in the database (`utilization_pct`, `completeness`…). */
  percent(n: number): string {
    return cached(
      'percent',
      (tag) => new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 1 }),
    ).format(n / 100);
  },

  date(d: string | Date): string {
    const date = toDate(d);
    if (!date) return '';
    const timeZone = zoneFor(d);
    // Month by name: "3 أكتوبر 2026", "3 Okt 2026", "3 Oct 2026" — no day/month ambiguity.
    return cached(
      `date|${timeZone ?? ''}`,
      (tag) =>
        new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone }),
    ).format(date);
  },

  dateTime(d: string | Date): string {
    const date = toDate(d);
    if (!date) return '';
    return cached(
      'dateTime',
      (tag) =>
        new Intl.DateTimeFormat(tag, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
    ).format(date);
  },

  /** "5 minutes ago", "in 2 days", "now" — relative to the current time. */
  relative(d: string | Date): string {
    const date = toDate(d);
    if (!date) return '';
    const rtf = cached('relative', (tag) => new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }));
    const seconds = (date.getTime() - Date.now()) / 1000;
    const abs = Math.abs(seconds);
    for (const [unit, size] of RELATIVE_UNITS) {
      if (abs >= size) return rtf.format(Math.round(seconds / size), unit);
    }
    // Under a minute: "now" up to 45 s, then round to one minute.
    return abs < 45 ? rtf.format(0, 'second') : rtf.format(seconds < 0 ? -1 : 1, 'minute');
  },

  /** Amount with its ISO currency code (never a bare symbol: eight currencies are in use). */
  currency(amount: number, currency: string): string {
    try {
      return cached(
        `currency|${currency}`,
        (tag) =>
          new Intl.NumberFormat(tag, { style: 'currency', currency, currencyDisplay: 'code' }),
      ).format(amount);
    } catch {
      return `${fmt.number(amount)} ${currency}`;
    }
  },

  /** Storage sizes in binary steps (1 MB = 1024 kB), with the unit name in the active language. */
  bytes(n: number): string {
    let value = Math.max(0, n);
    let index = 0;
    while (value >= 1024 && index < BYTE_UNITS.length - 1) {
      value /= 1024;
      index++;
    }
    const unit = BYTE_UNITS[index] ?? 'byte';
    const digits = index > 0 && value < 10 ? 1 : 0;
    return cached(
      `bytes|${unit}|${digits}`,
      (tag) =>
        new Intl.NumberFormat(tag, {
          style: 'unit',
          unit,
          unitDisplay: 'short',
          maximumFractionDigits: digits,
        }),
    ).format(value);
  },
};
