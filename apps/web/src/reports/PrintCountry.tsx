/**
 * Printed country periodic report (brief §9.4) from `report_country()`: the dashboard sections
 * of the country plus one row per branch. Payroll appears only when the server returned it
 * (restricted access) AND the user chose to print it (`showPayroll`, off by default so that a
 * copy handed to a donor carries no salary figures by accident).
 */
import { fmt, pickName, t } from '../i18n';
import { DashboardView } from './Dashboard';
import { money, pct, usd } from './format';
import { PSection } from './printParts';
import type { CountryReport } from './types';

/** True when the server sent payroll figures with the country report. */
export function hasPayroll(report: CountryReport): boolean {
  return report.payroll !== undefined || report.branches.some((b) => b.payroll !== undefined);
}

export function PrintCountry({
  report,
  hideNames,
  fxPlaceholder,
  showPayroll,
}: {
  report: CountryReport;
  hideNames: boolean;
  fxPlaceholder: boolean;
  showPayroll: boolean;
}) {
  const name = pickName(report.scope) || report.scope.iso2 || '';
  const withPayroll = showPayroll && report.branches.some((b) => b.payroll);
  const { payroll, ...withoutPayroll } = report;
  const dashboard = showPayroll && payroll ? report : withoutPayroll;
  return (
    <div class="pcountry" data-testid="print-country">
      <div class="ptitle">
        <div class="ptitle__text">
          <p class="ptitle__kicker">{t('reports.printCountryReport')}</p>
          <h1 class="ptitle__name">
            <bdi>{name}</bdi>
          </h1>
          {report.last_refreshed_at && (
            <p class="ptitle__alt">
              {t('reports.freshness', { date: fmt.dateTime(report.last_refreshed_at) })}
            </p>
          )}
        </div>
      </div>

      <PSection id="dashboard" title={t('reports.printIndicators')}>
        <DashboardView
          data={dashboard}
          hideNames={hideNames}
          fxPlaceholder={fxPlaceholder}
          mode="print"
        />
      </PSection>

      <PSection id="branches" title={t('reports.printBranches')} class="psec--wide">
        <table class="ptable ptable--dense" data-testid="print-branches">
          <thead>
            <tr>
              <th scope="col">{t('reports.colBranch')}</th>
              <th scope="col">{t('reports.kpiProjects')}</th>
              <th scope="col">{t('reports.colApproved')}</th>
              <th scope="col">{t('reports.kpiCapacity')}</th>
              <th scope="col">{t('reports.colOpenMaintenance')}</th>
              <th scope="col">{t('reports.colUrgent')}</th>
              <th scope="col">{t('reports.kpiStaff')}</th>
              <th scope="col">{t('reports.colQuranNeed')}</th>
              <th scope="col">{t('reports.colHousingGaps')}</th>
              <th scope="col">{t('reports.colTransport')}</th>
              <th scope="col">{t('reports.colExpandable')}</th>
              <th scope="col">{t('reports.kpiCompleteness')}</th>
              {withPayroll && <th scope="col">{t('reports.colPayroll')}</th>}
            </tr>
          </thead>
          <tbody>
            {report.branches.map((b) => (
              <tr key={b.branch_id ?? 'none'} data-testid="print-branch-row">
                <th scope="row">
                  <bdi>{pickName(b) || b.code || t('reports.withoutBranch')}</bdi>
                </th>
                <td>{fmt.number(b.projects)}</td>
                <td>{fmt.number(b.approved)}</td>
                <td>{fmt.number(b.capacity)}</td>
                <td>{fmt.number(b.open_maintenance)}</td>
                <td>{fmt.number(b.urgent_maintenance)}</td>
                <td>{fmt.number(b.staff)}</td>
                <td>{fmt.number(b.quran_need)}</td>
                <td>{fmt.number(b.housing_gaps)}</td>
                <td>{fmt.number(b.transport_needed)}</td>
                <td>{fmt.number(b.expandable_sites)}</td>
                <td>
                  {pct(b.completeness_average)}
                  {b.incomplete > 0 && (
                    <span class="ptable__sub">
                      {t('reports.incompleteShort', { count: b.incomplete })}
                    </span>
                  )}
                </td>
                {withPayroll && (
                  <td data-testid="print-branch-payroll">
                    {b.payroll?.by_currency.map((l) => (
                      <span key={l.currency} class="ptable__line">
                        {money(l.monthly_total, l.currency)}
                      </span>
                    ))}
                    {b.payroll?.monthly_total_usd !== null &&
                      b.payroll?.monthly_total_usd !== undefined && (
                        <span class="ptable__sub">≈ {usd(b.payroll.monthly_total_usd)}</span>
                      )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </PSection>
    </div>
  );
}
