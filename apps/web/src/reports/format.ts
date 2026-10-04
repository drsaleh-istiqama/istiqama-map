/**
 * Small formatting helpers of the reports module on top of `fmt` (src/i18n): every number
 * and date goes through `Intl` in the interface language.
 */
import { fmt, INTL_LOCALE, locale } from '../i18n';

const dayMonth = new Map<string, Intl.DateTimeFormat>();

/** "13 Jul" / "١٣ يوليو" — a week start (`YYYY-MM-DD`, UTC calendar day). */
export function shortDay(isoDate: string): string {
  const tag = INTL_LOCALE[locale.value];
  let f = dayMonth.get(tag);
  if (!f) {
    f = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    dayMonth.set(tag, f);
  }
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDate : f.format(d);
}

/** Amount in its own currency, or an empty string when unknown. */
export function money(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '';
  return currency ? fmt.currency(amount, currency) : fmt.number(amount);
}

export function usd(amount: number | null | undefined): string {
  return money(amount, 'USD');
}

/** Percentage (0..100 scale) or a dash when unknown. */
export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : fmt.percent(value);
}
