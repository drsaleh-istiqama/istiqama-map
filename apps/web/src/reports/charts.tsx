/**
 * Lightweight charts in plain CSS (no chart library — brief §1 budget). Every chart is also
 * readable as text: bar lists are lists with their numbers, the weekly chart carries a
 * visually hidden data table. Bars follow the writing direction (they grow from the start
 * edge; the weeks run from the start edge in RTL and LTR alike).
 */
import { fmt, t } from '../i18n';
import { shortDay } from './format';
import type { WeekCount } from './types';

export interface Bar {
  key: string;
  label: string;
  value: number;
  /** CSS colour of the bar (contract palette). */
  color?: string;
  /** Secondary text after the number (e.g. capacity). */
  note?: string;
}

export interface BarListProps {
  bars: Bar[];
  testId?: string;
  /** Accessible name of the list. */
  label: string;
  /** Scale: the largest value by default (bars of different lists can share one). */
  max?: number;
}

export function BarList({ bars, testId, label, max }: BarListProps) {
  const top = Math.max(max ?? 0, ...bars.map((b) => b.value), 1);
  return (
    <ul class="rbars" aria-label={label} data-testid={testId}>
      {bars.map((bar) => (
        <li key={bar.key} class="rbars__row" data-key={bar.key} data-value={bar.value}>
          <span class="rbars__label">{bar.label}</span>
          <span class="rbars__track" aria-hidden="true">
            <span
              class="rbars__fill"
              style={{
                inlineSize: `${Math.max(bar.value > 0 ? 2 : 0, (bar.value / top) * 100)}%`,
                ...(bar.color ? { background: bar.color } : {}),
              }}
            />
          </span>
          <span class="rbars__value">
            {fmt.number(bar.value)}
            {bar.note && <span class="rbars__note"> {bar.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface StackSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** One horizontal bar split into parts (e.g. projects by status), with a legend. */
export function StackBar({
  parts,
  label,
  testId,
}: {
  parts: StackSegment[];
  label: string;
  testId?: string;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <figure class="rstack" data-testid={testId}>
      <div class="rstack__bar" role="img" aria-label={label}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.key}
              class="rstack__part"
              style={{ flexGrow: p.value, background: p.color }}
              title={`${p.label}: ${fmt.number(p.value)}`}
            />
          ))}
        {total === 0 && <span class="rstack__part rstack__part--empty" />}
      </div>
      <figcaption>
        <ul class="rlegend">
          {parts.map((p) => (
            <li key={p.key} data-key={p.key}>
              <span class="rlegend__swatch" style={{ background: p.color }} aria-hidden="true" />
              <span>{p.label}</span> <strong>{fmt.number(p.value)}</strong>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

export interface WeekChartProps {
  weeks: WeekCount[];
  label: string;
  testId?: string;
}

/** 12 weekly columns: created (navy) + updated (gold) stacked. */
export function WeekChart({ weeks, label, testId }: WeekChartProps) {
  const top = Math.max(1, ...weeks.map((w) => w.created + w.updated));
  return (
    <figure class="rweeks" data-testid={testId}>
      <div class="rweeks__plot" aria-hidden="true">
        {weeks.map((w) => {
          const total = w.created + w.updated;
          return (
            <div
              key={w.week_start}
              class="rweeks__col"
              title={`${shortDay(w.week_start)} — ${t('reports.activityCreated')}: ${fmt.number(w.created)}, ${t('reports.activityUpdated')}: ${fmt.number(w.updated)}`}
            >
              <span class="rweeks__total">{total > 0 ? fmt.number(total) : ''}</span>
              <div class="rweeks__stack">
                <span class="rweeks__upd" style={{ blockSize: `${(w.updated / top) * 100}%` }} />
                <span class="rweeks__new" style={{ blockSize: `${(w.created / top) * 100}%` }} />
              </div>
              <span class="rweeks__day">{shortDay(w.week_start)}</span>
            </div>
          );
        })}
      </div>
      <figcaption>
        <ul class="rlegend">
          <li>
            <span class="rlegend__swatch rlegend__swatch--new" aria-hidden="true" />
            {t('reports.activityCreated')}
          </li>
          <li>
            <span class="rlegend__swatch rlegend__swatch--upd" aria-hidden="true" />
            {t('reports.activityUpdated')}
          </li>
        </ul>
      </figcaption>
      <table class="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">{t('reports.activityWeek')}</th>
            <th scope="col">{t('reports.activityCreated')}</th>
            <th scope="col">{t('reports.activityUpdated')}</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.week_start}>
              <th scope="row">{shortDay(w.week_start)}</th>
              <td>{fmt.number(w.created)}</td>
              <td>{fmt.number(w.updated)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Tiny 12-week activity strip of one collector (decorative; the totals are in the row). */
export function Sparkline({ weeks, all }: { weeks: WeekCount[]; all: string[] }) {
  const byWeek = new Map(weeks.map((w) => [w.week_start, w.created + w.updated]));
  const values = all.map((w) => byWeek.get(w) ?? 0);
  const top = Math.max(1, ...values);
  return (
    <span class="rspark" aria-hidden="true">
      {values.map((v, i) => (
        <span
          key={all[i]}
          class="rspark__bar"
          style={{ blockSize: `${Math.max(v > 0 ? 12 : 4, (v / top) * 100)}%` }}
        />
      ))}
    </span>
  );
}

/** Completeness gauge (0..100). */
export function Gauge({
  value,
  label,
  testId,
}: {
  value: number | null;
  label: string;
  testId?: string;
}) {
  const v = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div
      class="rgauge"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : v}
      aria-valuetext={value === null ? '—' : fmt.percent(v)}
      data-testid={testId}
    >
      <span class="rgauge__fill" style={{ inlineSize: `${v}%` }} />
    </div>
  );
}
