/** Printed donor report (brief §9.4) from `report_donor()`: the donor's projects, photos and status. */
import { fmt, pickName, t } from '../i18n';
import { enumLabel, StatusBadge, typeLabel, TypeIcon } from '../projects/labels';
import { TYPE_ORDER, STATUS_ORDER } from './Dashboard';
import { money } from './format';
import { Kv, PhotoImg, photoText, PSection } from './printParts';
import type { DonorReport } from './types';

export function PrintDonor({ report }: { report: DonorReport }) {
  const s = report.summary;
  const donorName = pickName(report.donor);
  return (
    <div class="pdonor" data-testid="print-donor">
      <div class="ptitle">
        <div class="ptitle__text">
          <p class="ptitle__kicker">{t('reports.printDonorReport')}</p>
          <h1 class="ptitle__name">
            <bdi>{donorName}</bdi>
          </h1>
          {report.donor.notes && <p class="ptitle__alt">{report.donor.notes}</p>}
        </div>
      </div>

      <PSection id="summary" title={t('reports.printSummary')}>
        <dl class="pkpis">
          <div class="pkpi">
            <dt>{t('reports.kpiProjects')}</dt>
            <dd>{fmt.number(s.projects)}</dd>
          </div>
          <div class="pkpi">
            <dt>{t('reports.kpiCapacity')}</dt>
            <dd>{fmt.number(s.capacity)}</dd>
          </div>
          {s.contributions.map((c) => (
            <div class="pkpi" key={c.currency} data-currency={c.currency}>
              <dt>{t('reports.contributions')}</dt>
              <dd>{money(c.amount, c.currency)}</dd>
            </div>
          ))}
        </dl>
        <Kv
          items={[
            {
              key: 'types',
              label: t('reports.byType'),
              value: TYPE_ORDER.filter((k) => (s.by_type[k] ?? 0) > 0)
                .map((k) => `${typeLabel(k)} ${fmt.number(s.by_type[k] ?? 0)}`)
                .join(t('reports.listSep')),
            },
            {
              key: 'status',
              label: t('reports.byStatus'),
              value: STATUS_ORDER.filter((k) => (s.by_status[k] ?? 0) > 0)
                .map((k) => `${enumLabel('project_status', k)} ${fmt.number(s.by_status[k] ?? 0)}`)
                .join(t('reports.listSep')),
            },
          ]}
        />
      </PSection>

      <PSection id="projects" title={t('reports.printDonorProjects')}>
        {report.projects.length === 0 ? (
          <p class="muted" data-testid="print-donor-empty">
            {t('reports.donorNoProjects')}
          </p>
        ) : (
          <ol class="pdproj-list">
            {report.projects.map((p) => {
              const cover = p.photos.find((ph) => ph.is_cover) ?? p.photos[0] ?? null;
              const more = p.photos.filter((ph) => ph !== cover).slice(0, 3);
              const place = [
                p.country ? pickName(p.country) : '',
                p.admin_area ? pickName(p.admin_area) : '',
                p.locality ? pickName(p.locality) : '',
              ]
                .filter(Boolean)
                .join(' › ');
              const name = pickName(p) || p.code || '';
              return (
                <li key={p.id} class="pdproj" data-testid="print-donor-project">
                  <div class="pdproj__photo">
                    {cover ? (
                      <PhotoImg photo={cover} kind="thumb" alt={photoText(cover) || name} />
                    ) : (
                      <span class="pphoto pphoto--empty">{t('reports.noPhotos')}</span>
                    )}
                  </div>
                  <div class="pdproj__body">
                    <h3 class="pdproj__name">
                      <TypeIcon type={p.type} size={20} />
                      <bdi>{name}</bdi>
                      {p.code && (
                        <span class="mono ltr muted" dir="ltr">
                          {p.code}
                        </span>
                      )}
                    </h3>
                    <p class="pdproj__line">
                      <StatusBadge status={p.status} />
                      <span>{typeLabel(p.type)}</span>
                      {place && <span>{place}</span>}
                    </p>
                    <p class="pdproj__line muted">
                      {p.capacity !== null && (
                        <span>{t('reports.capacityNote', { value: fmt.number(p.capacity) })}</span>
                      )}
                      {p.build_year !== null && (
                        <span>{t('reports.builtIn', { year: String(p.build_year) })}</span>
                      )}
                      <span>
                        {t('reports.openMaintenanceCount', { count: p.open_maintenance })}
                      </span>
                    </p>
                    {p.contributions.length > 0 && (
                      <p class="pdproj__line">
                        {t('reports.contributions')}:{' '}
                        {p.contributions
                          .map((c) =>
                            [money(c.amount, c.currency), c.year ? `(${c.year})` : '']
                              .filter(Boolean)
                              .join(' '),
                          )
                          .filter(Boolean)
                          .join(t('reports.listSep'))}
                      </p>
                    )}
                    {more.length > 0 && (
                      <ul class="pdproj__thumbs">
                        {more.map((ph) => (
                          <li key={ph.id}>
                            <PhotoImg photo={ph} kind="thumb" alt={photoText(ph) || name} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {report.truncated && (
          <p class="rnote" data-testid="print-truncated">
            {t('reports.truncated', {
              shown: fmt.number(report.projects.length),
              total: fmt.number(report.projects_total),
            })}
          </p>
        )}
      </PSection>
    </div>
  );
}
