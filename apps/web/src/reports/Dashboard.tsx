/**
 * The sections of a dashboard document (brief §9.1). Rendered by the reports page (screen)
 * and by the country print report (`mode="print"`: no links, no buttons).
 *
 * Privacy: only what the server returned is shown. `payroll` exists only for restricted
 * callers; collector names are dropped for viewers by the server — and, defensively, never
 * rendered here when `hideNames` is set.
 */
import { fmt, pickName, t } from '../i18n';
import { enumLabel, STATUS_COLORS, typeLabel } from '../projects/labels';
import { Badge, Link } from '../ui';
import { BarList, Gauge, Sparkline, StackBar, WeekChart, type Bar } from './charts';
import { money, pct, shortDay, usd } from './format';
import { IconFlame } from './icons';
import { openHeatMap, type HeatKind } from './paths';
import type { Dashboard as DashboardData, Payroll, RegionRow } from './types';
import './reports.css';

export const TYPE_ORDER = ['mosque', 'school', 'combined'] as const;
export const STATUS_ORDER = ['active', 'maintenance', 'building', 'inactive'] as const;
export const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'] as const;
export const RECORD_STATE_ORDER = ['draft', 'submitted', 'approved', 'returned'] as const;
export const ROLE_ORDER = [
  'imam',
  'teacher',
  'agent',
  'administrator',
  'manager',
  'other',
] as const;

/** Chart colours with ≥ 3:1 contrast on white (WCAG 1.4.11). */
export const TYPE_COLORS: Record<string, string> = {
  mosque: '#0f2545',
  school: '#7a5c12',
  combined: '#175cd3',
};
export const PRIORITY_COLORS: Record<string, string> = {
  urgent: '#b42318',
  high: '#b54708',
  medium: '#7a5c12',
  low: '#667085',
};
const RECORD_STATE_COLORS: Record<string, string> = {
  draft: '#667085',
  submitted: '#175cd3',
  approved: '#1f7a4d',
  returned: '#b54708',
};

/** Codes listed first in `order`, then any code the server added later. */
function ordered(counts: Record<string, number>, order: readonly string[]): string[] {
  return [...order, ...Object.keys(counts).filter((k) => !order.includes(k))];
}

export interface DashboardProps {
  data: DashboardData;
  /** Viewer: no person names anywhere (the server already omits them). */
  hideNames: boolean;
  /** `fx.placeholder` app setting: USD figures are approximate. */
  fxPlaceholder: boolean;
  mode?: 'screen' | 'print';
}

export function DashboardView({ data, hideNames, fxPlaceholder, mode = 'screen' }: DashboardProps) {
  const screen = mode === 'screen';
  return (
    <div class="rdash" data-testid="dashboard">
      <Kpis data={data} />
      <div class="rgrid">
        <ProjectsSection data={data} />
        <MaintenanceSection data={data} screen={screen} fxPlaceholder={fxPlaceholder} />
        <StaffSection data={data} />
        {data.payroll && <PayrollSection payroll={data.payroll} fxPlaceholder={fxPlaceholder} />}
        <NeedsSection data={data} screen={screen} />
        <CompletenessSection data={data} screen={screen} />
      </div>
      <ActivitySection data={data} hideNames={hideNames} />
      <RegionsSection data={data} />
    </div>
  );
}

function Kpis({ data }: { data: DashboardData }) {
  const items: Array<{ id: string; label: string; value: string }> = [
    { id: 'projects', label: t('reports.kpiProjects'), value: fmt.number(data.totals.projects) },
    { id: 'capacity', label: t('reports.kpiCapacity'), value: fmt.number(data.totals.capacity) },
    { id: 'areas', label: t('reports.kpiAreas'), value: fmt.number(data.totals.areas_covered) },
    {
      id: 'maintenance',
      label: t('reports.kpiOpenMaintenance'),
      value: fmt.number(data.maintenance.open_total),
    },
    { id: 'staff', label: t('reports.kpiStaff'), value: fmt.number(data.staff.assignments) },
    {
      id: 'completeness',
      label: t('reports.kpiCompleteness'),
      value: pct(data.completeness.average),
    },
  ];
  return (
    <dl class="rkpis">
      {items.map((k) => (
        <div key={k.id} class="rkpi" data-testid={`kpi-${k.id}`}>
          <dt class="rkpi__label">{k.label}</dt>
          <dd class="rkpi__value">{k.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProjectsSection({ data }: { data: DashboardData }) {
  const totals = data.totals;
  const typeBars: Bar[] = ordered(totals.by_type, TYPE_ORDER).map((code) => ({
    key: code,
    label: typeLabel(code),
    value: totals.by_type[code] ?? 0,
    color: TYPE_COLORS[code],
    note: t('reports.capacityNote', { value: fmt.number(totals.capacity_by_type[code] ?? 0) }),
  }));
  const statusParts = ordered(totals.by_status, STATUS_ORDER).map((code) => ({
    key: code,
    label: enumLabel('project_status', code),
    value: totals.by_status[code] ?? 0,
    color: STATUS_COLORS[code as keyof typeof STATUS_COLORS] ?? '#667085',
  }));
  const stateParts = ordered(totals.by_record_state, RECORD_STATE_ORDER).map((code) => ({
    key: code,
    label: enumLabel('record_state', code),
    value: totals.by_record_state[code] ?? 0,
    color: RECORD_STATE_COLORS[code] ?? '#667085',
  }));
  const statuses = ordered(totals.by_status, STATUS_ORDER);
  const cell = (type: string, status: string): number =>
    totals.by_type_status.find((c) => c.type === type && c.status === status)?.projects ?? 0;
  return (
    <section class="card rcard" aria-labelledby="rs-projects" data-testid="dash-projects">
      <h2 id="rs-projects" class="rcard__title">
        {t('reports.sectionProjects')}
      </h2>
      <h3 class="rcard__sub">{t('reports.byType')}</h3>
      <BarList bars={typeBars} label={t('reports.byType')} testId="dash-by-type" />
      <h3 class="rcard__sub">{t('reports.byStatus')}</h3>
      <StackBar parts={statusParts} label={t('reports.byStatus')} testId="dash-by-status" />
      <div class="rtable-wrap">
        <table class="rtable rtable--compact" data-testid="dash-type-status">
          <caption class="sr-only">{t('reports.typeByStatus')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('reports.colType')}</th>
              {statuses.map((s) => (
                <th key={s} scope="col">
                  {enumLabel('project_status', s)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered(totals.by_type, TYPE_ORDER).map((type) => (
              <tr key={type}>
                <th scope="row">{typeLabel(type)}</th>
                {statuses.map((s) => (
                  <td key={s}>{fmt.number(cell(type, s))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 class="rcard__sub">{t('reports.byRecordState')}</h3>
      <StackBar
        parts={stateParts}
        label={t('reports.byRecordState')}
        testId="dash-by-record-state"
      />
    </section>
  );
}

function MaintenanceSection({
  data,
  screen,
  fxPlaceholder,
}: {
  data: DashboardData;
  screen: boolean;
  fxPlaceholder: boolean;
}) {
  const m = data.maintenance;
  const bars: Bar[] = ordered(m.by_priority, PRIORITY_ORDER).map((code) => ({
    key: code,
    label: enumLabel('maintenance_priority', code),
    value: m.by_priority[code] ?? 0,
    color: PRIORITY_COLORS[code],
  }));
  const anyUsd = m.estimated_cost.some((c) => c.amount_usd !== null && c.currency !== 'USD');
  return (
    <section class="card rcard" aria-labelledby="rs-maint" data-testid="dash-maintenance">
      <h2 id="rs-maint" class="rcard__title">
        {t('reports.sectionMaintenance')}
      </h2>
      <p class="rcard__lead">{t('reports.openTotal', { count: m.open_total })}</p>
      <BarList bars={bars} label={t('reports.byPriority')} testId="dash-by-priority" />
      {m.estimated_cost.length > 0 && (
        <>
          <h3 class="rcard__sub">{t('reports.estimatedCost')}</h3>
          <ul class="rmoney" data-testid="dash-maintenance-cost">
            {m.estimated_cost.map((c) => (
              <li key={c.currency} data-currency={c.currency}>
                <span class="ltr-iso">{money(c.amount, c.currency)}</span>
                {c.currency !== 'USD' && c.amount_usd !== null && (
                  <span class="muted"> ≈ {usd(c.amount_usd)}</span>
                )}
              </li>
            ))}
          </ul>
          {anyUsd && fxPlaceholder && <FxNotice testId="dash-fx-notice-maintenance" />}
        </>
      )}
      {m.items.length > 0 && (
        <>
          <h3 class="rcard__sub">{t('reports.urgentItems')}</h3>
          <ol class="ritems" data-testid="dash-maintenance-items">
            {m.items.slice(0, screen ? 8 : 20).map((item) => {
              const name = pickName({
                name_ar: item.project_name_ar,
                name_latin: item.project_name_latin,
              });
              return (
                <li key={item.id} class="ritem" data-priority={item.priority}>
                  <Badge
                    tone={
                      item.priority === 'urgent'
                        ? 'danger'
                        : item.priority === 'high'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {enumLabel('maintenance_priority', item.priority)}
                  </Badge>
                  <span class="ritem__body">
                    {screen && item.project_id ? (
                      <Link href={`/projects/${item.project_id}`} class="ritem__name">
                        <bdi>{name || item.project_code}</bdi>
                      </Link>
                    ) : (
                      <bdi class="ritem__name">{name || item.project_code}</bdi>
                    )}{' '}
                    {item.project_code && (
                      <span class="mono ltr muted" dir="ltr">
                        {item.project_code}
                      </span>
                    )}
                    {item.description && <span class="ritem__text">{item.description}</span>}
                    <span class="ritem__meta muted">
                      {item.reported_on && fmt.date(item.reported_on)}
                      {item.estimated_cost !== null &&
                        ` · ${money(item.estimated_cost, item.currency)}`}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {screen && (
        <div class="ractions">
          <Link
            href="/maintenance"
            class="btn btn--secondary btn--sm"
            testId="dash-open-maintenance"
          >
            <span class="btn__label">{t('reports.openMaintenanceList')}</span>
          </Link>
          <HeatButton kind="maintenance" />
        </div>
      )}
    </section>
  );
}

function StaffSection({ data }: { data: DashboardData }) {
  const bars: Bar[] = ordered(data.staff.by_role, ROLE_ORDER).map((code) => ({
    key: code,
    label: enumLabel('staff_role', code),
    value: data.staff.by_role[code] ?? 0,
    color: '#1c3a66',
  }));
  return (
    <section class="card rcard" aria-labelledby="rs-staff" data-testid="dash-staff">
      <h2 id="rs-staff" class="rcard__title">
        {t('reports.sectionStaff')}
      </h2>
      <p class="rcard__lead">{t('reports.assignments', { count: data.staff.assignments })}</p>
      <BarList bars={bars} label={t('reports.byRole')} testId="dash-by-role" />
      <p class="rnote">{t('reports.staffNoNames')}</p>
    </section>
  );
}

export function FxNotice({ testId }: { testId?: string }) {
  return (
    <p class="rnote rnote--warn" role="note" data-testid={testId}>
      {t('reports.fxPlaceholder')}
    </p>
  );
}

function PayrollSection({ payroll, fxPlaceholder }: { payroll: Payroll; fxPlaceholder: boolean }) {
  return (
    <section
      class="card rcard rcard--restricted"
      aria-labelledby="rs-pay"
      data-testid="dash-payroll"
    >
      <h2 id="rs-pay" class="rcard__title">
        {t('reports.sectionPayroll')} <Badge tone="gold">{t('reports.restrictedBadge')}</Badge>
      </h2>
      <p class="rcard__lead">{t('reports.staffPaid', { count: payroll.staff_paid })}</p>
      <div class="rtable-wrap">
        <table class="rtable">
          <caption class="sr-only">{t('reports.sectionPayroll')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('reports.colCurrency')}</th>
              <th scope="col">{t('reports.colStaffPaid')}</th>
              <th scope="col">{t('reports.colMonthlyTotal')}</th>
              <th scope="col">{t('reports.colUsd')}</th>
            </tr>
          </thead>
          <tbody>
            {payroll.by_currency.map((line) => (
              <tr key={line.currency} data-testid="dash-payroll-row" data-currency={line.currency}>
                <th scope="row">
                  <span dir="ltr" class="ltr-iso">
                    {line.currency}
                  </span>
                </th>
                <td>{fmt.number(line.staff_paid)}</td>
                <td data-testid="dash-payroll-local">{money(line.monthly_total, line.currency)}</td>
                <td>
                  {line.monthly_total_usd === null ? (
                    <span class="muted">{t('reports.noRate')}</span>
                  ) : (
                    <>
                      {usd(line.monthly_total_usd)}
                      {line.rate_date && line.currency !== 'USD' && (
                        <span class="rtable__sub muted">
                          {t('reports.rateOn', { date: fmt.date(line.rate_date) })}
                        </span>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>
                {t('reports.totalUsd')}
              </th>
              <td data-testid="dash-payroll-usd">{usd(payroll.monthly_total_usd ?? 0)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="rnote">{t('reports.payrollNoSum')}</p>
      {payroll.missing_rates.length > 0 && (
        <p class="rnote rnote--warn" data-testid="dash-missing-rates">
          {t('reports.missingRates', { list: payroll.missing_rates.join(t('reports.listSep')) })}
        </p>
      )}
      {fxPlaceholder && <FxNotice testId="dash-fx-notice" />}
    </section>
  );
}

function HeatButton({ kind }: { kind: HeatKind }) {
  return (
    <button
      type="button"
      class="btn btn--ghost btn--sm"
      data-testid={`heat-link-${kind}`}
      onClick={() => openHeatMap(kind)}
    >
      <IconFlame size={18} />
      <span class="btn__label">{t(`reports.heat_${kind}`)}</span>
    </button>
  );
}

function NeedsSection({ data, screen }: { data: DashboardData; screen: boolean }) {
  const n = data.needs;
  const rows: Array<{ id: string; label: string; value: string; heat?: HeatKind }> = [
    {
      id: 'quran',
      label: t('reports.needQuran'),
      value: t('reports.needQuranValue', {
        need: fmt.number(n.quran_need),
        have: fmt.number(n.quran_count),
        projects: fmt.number(n.quran_need_projects),
      }),
      heat: 'quran_need',
    },
    {
      id: 'housing',
      label: t('reports.needHousing'),
      value: t('reports.needHousingValue', {
        total: fmt.number(n.housing_gaps),
        teachers: fmt.number(n.teacher_housing_gaps),
        imams: fmt.number(n.imam_housing_gaps),
      }),
      heat: 'housing',
    },
    { id: 'transport', label: t('reports.needTransport'), value: fmt.number(n.transport_needed) },
    { id: 'expandable', label: t('reports.needExpandable'), value: fmt.number(n.expandable_sites) },
  ];
  return (
    <section class="card rcard" aria-labelledby="rs-needs" data-testid="dash-needs">
      <h2 id="rs-needs" class="rcard__title">
        {t('reports.sectionNeeds')}
      </h2>
      <dl class="rkv">
        {rows.map((r) => (
          <div key={r.id} class="rkv__row" data-testid={`need-${r.id}`}>
            <dt>{r.label}</dt>
            <dd>
              <span>{r.value}</span>
              {screen && r.heat && <HeatButton kind={r.heat} />}
            </dd>
          </div>
        ))}
      </dl>
      <p class="rnote">{t('reports.housingRule')}</p>
    </section>
  );
}

function CompletenessSection({ data, screen }: { data: DashboardData; screen: boolean }) {
  const c = data.completeness;
  return (
    <section class="card rcard" aria-labelledby="rs-comp" data-testid="dash-completeness">
      <h2 id="rs-comp" class="rcard__title">
        {t('reports.sectionCompleteness')}
      </h2>
      <p class="rcard__lead" data-testid="dash-completeness-average">
        {t('reports.averageCompleteness', { value: pct(c.average) })}
      </p>
      <Gauge value={c.average} label={t('reports.sectionCompleteness')} />
      <dl class="rkv">
        <div class="rkv__row">
          <dt>{t('reports.incompleteRecords')}</dt>
          <dd data-testid="dash-incomplete">{fmt.number(c.incomplete)}</dd>
        </div>
        <div class="rkv__row">
          <dt>{t('reports.belowHalf')}</dt>
          <dd>{fmt.number(c.below_half)}</dd>
        </div>
        <div class="rkv__row">
          <dt>{t('reports.completeRecords')}</dt>
          <dd>{fmt.number(c.complete)}</dd>
        </div>
      </dl>
      {screen && (
        <div class="ractions">
          <Link href="/incomplete" class="btn btn--secondary btn--sm" testId="dash-open-incomplete">
            <span class="btn__label">{t('reports.openIncomplete')}</span>
          </Link>
        </div>
      )}
    </section>
  );
}

function ActivitySection({ data, hideNames }: { data: DashboardData; hideNames: boolean }) {
  const a = data.entry_activity;
  const weeks =
    a.totals.length > 0
      ? a.totals
      : a.weeks.map((w) => ({ week_start: w, created: 0, updated: 0 }));
  const collectors = hideNames ? undefined : a.collectors;
  return (
    <section class="card rcard" aria-labelledby="rs-act" data-testid="dash-activity">
      <h2 id="rs-act" class="rcard__title">
        {t('reports.sectionActivity')}
      </h2>
      <p class="rcard__lead">{t('reports.collectorCount', { count: a.collector_count })}</p>
      <WeekChart weeks={weeks} label={t('reports.sectionActivity')} testId="dash-weeks" />
      {collectors && collectors.length > 0 ? (
        <div class="rtable-wrap">
          <table class="rtable" data-testid="dash-collectors">
            <caption class="sr-only">{t('reports.collectorsTitle')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('reports.colCollector')}</th>
                <th scope="col">{t('reports.activityCreated')}</th>
                <th scope="col">{t('reports.activityUpdated')}</th>
                <th scope="col">{t('reports.colTrend')}</th>
              </tr>
            </thead>
            <tbody>
              {collectors.map((c) => (
                <tr key={c.user_id} data-testid="dash-collector-row">
                  <th scope="row">
                    <bdi>{c.full_name ?? t('reports.unnamedUser')}</bdi>
                  </th>
                  <td>{fmt.number(c.created)}</td>
                  <td>{fmt.number(c.updated)}</td>
                  <td>
                    <Sparkline weeks={c.weeks} all={weeks.map((w) => w.week_start)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        hideNames && (
          <p class="rnote" data-testid="dash-collectors-hidden">
            {t('reports.collectorsHidden')}
          </p>
        )
      )}
      {weeks.length > 0 && (
        <p class="rnote">
          {t('reports.activityRange', {
            from: shortDay(weeks[0]!.week_start),
            to: shortDay(weeks[weeks.length - 1]!.week_start),
          })}
        </p>
      )}
    </section>
  );
}

function RegionTable({
  rows,
  title,
  testId,
}: {
  rows: RegionRow[];
  title: string;
  testId: string;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3 class="rcard__sub">{title}</h3>
      <div class="rtable-wrap">
        <table class="rtable" data-testid={testId}>
          <caption class="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{t('reports.colName')}</th>
              <th scope="col">{t('reports.kpiProjects')}</th>
              <th scope="col">{t('reports.kpiCapacity')}</th>
              <th scope="col">{typeLabel('mosque')}</th>
              <th scope="col">{typeLabel('school')}</th>
              <th scope="col">{typeLabel('combined')}</th>
              <th scope="col">{t('reports.colInMaintenance')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id ?? 'none'} data-testid="region-row" data-id={r.id ?? ''}>
                <th scope="row">
                  <bdi>{pickName(r) || r.code || t('reports.unassigned')}</bdi>
                </th>
                <td>{fmt.number(r.projects)}</td>
                <td>{fmt.number(r.capacity)}</td>
                <td>{fmt.number(r.mosque)}</td>
                <td>{fmt.number(r.school)}</td>
                <td>{fmt.number(r.combined)}</td>
                <td>{fmt.number(r.maintenance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RegionsSection({ data }: { data: DashboardData }) {
  const t0 = data.totals;
  if (!t0.by_country?.length && !t0.by_branch?.length && t0.by_area.length === 0) return null;
  return (
    <section class="card rcard" aria-labelledby="rs-regions" data-testid="dash-regions">
      <h2 id="rs-regions" class="rcard__title">
        {t('reports.sectionRegions')}
      </h2>
      <RegionTable
        rows={t0.by_country ?? []}
        title={t('reports.byCountry')}
        testId="dash-by-country"
      />
      <RegionTable
        rows={t0.by_branch ?? []}
        title={t('reports.byBranch')}
        testId="dash-by-branch"
      />
      <RegionTable rows={t0.by_area} title={t('reports.byArea')} testId="dash-by-area" />
    </section>
  );
}
