/**
 * Printed project card (brief §9.4) from `report_project()`: photos, status, location
 * snapshot, land / facilities / community, staff (salaries only when the server sent them AND
 * the user chose to print them), maintenance history and donors.
 */
import { fmt, pickName, t } from '../i18n';
import { enumLabel, RecordStateBadge, StatusBadge, typeLabel, TypeIcon } from '../projects/labels';
import { OPTION_LIST_KEYS } from '../db';
import { AreaMap } from './AreaMap';
import { money, pct } from './format';
import { Kv, PhotoImg, photoText, PSection, yesNo, type KvItem } from './printParts';
import type { ProjectReport } from './types';

function numText(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? fmt.number(v) : '';
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function hasSalaries(report: ProjectReport): boolean {
  return report.capabilities.restricted && (report.staff ?? []).some((s) => 'monthly_amount' in s);
}

export function PrintProject({
  report,
  showSalaries,
}: {
  report: ProjectReport;
  showSalaries: boolean;
}) {
  const p = report.project;
  const name = pickName(p) || p.code || '';
  const cover = report.photos.find((ph) => ph.is_cover) ?? report.photos[0] ?? null;
  const gallery = report.photos.filter((ph) => ph !== cover).slice(0, 9);
  const areaPath = report.admin_areas
    .map((a) => pickName(a))
    .filter(Boolean)
    .join(' › ');
  const salaries = showSalaries && hasSalaries(report);

  const facts: KvItem[] = [
    { key: 'type', label: t('reports.colType'), value: typeLabel(p.type) },
    {
      key: 'country',
      label: t('reports.factCountry'),
      value: report.country ? pickName(report.country) : '',
    },
    { key: 'area', label: t('reports.factArea'), value: areaPath },
    {
      key: 'locality',
      label: t('reports.factLocality'),
      value: report.locality ? pickName(report.locality) : '',
    },
    {
      key: 'branch',
      label: t('reports.factBranch'),
      value: report.branch ? pickName(report.branch) : '',
    },
    { key: 'capacity', label: t('reports.kpiCapacity'), value: numText(p.capacity) },
    { key: 'builder', label: t('reports.factBuilder'), value: textOf(p.builder) },
    {
      key: 'build',
      label: t('reports.factBuildYear'),
      value:
        typeof p.build_date === 'string'
          ? fmt.date(p.build_date)
          : typeof p.build_year === 'number'
            ? String(p.build_year)
            : '',
    },
    {
      key: 'source',
      label: t('reports.factLocationSource'),
      value: enumLabel('location_source', textOf(p.location_source)),
    },
    {
      key: 'accuracy',
      label: t('reports.factAccuracy'),
      value:
        typeof p.gps_accuracy_m === 'number'
          ? t('reports.meters', { value: fmt.number(p.gps_accuracy_m) })
          : '',
    },
    {
      key: 'completeness',
      label: t('reports.kpiCompleteness'),
      value: typeof p.completeness === 'number' ? pct(p.completeness) : '',
    },
    {
      key: 'entered',
      label: t('reports.factEnteredBy'),
      value: report.entered_by?.full_name ? <bdi>{report.entered_by.full_name}</bdi> : '',
    },
    {
      key: 'review',
      label: t('reports.factReviewNote'),
      value: textOf(p.review_note),
    },
  ];

  const land = report.land;
  const landItems: KvItem[] = land
    ? [
        {
          key: 'ownership',
          label: t('reports.landOwnership'),
          value: enumLabel('land_ownership', textOf(land.ownership)),
        },
        { key: 'owner', label: t('reports.landOwner'), value: textOf(land.owner_name) },
        {
          key: 'area',
          label: t('reports.landArea'),
          value:
            typeof land.area_m2 === 'number'
              ? t('reports.squareMeters', { value: fmt.number(land.area_m2) })
              : '',
        },
        {
          key: 'utilization',
          label: t('reports.landUtilization'),
          value: typeof land.utilization_pct === 'number' ? pct(land.utilization_pct) : '',
        },
        { key: 'expandable', label: t('reports.landExpandable'), value: yesNo(land.expandable) },
        { key: 'notes', label: t('reports.notes'), value: textOf(land.notes) },
      ]
    : [];

  const f = report.facilities;
  const facilityItems: KvItem[] = f
    ? [
        {
          key: 'teacher_housing',
          label: t('reports.facTeacherHousing'),
          value: yesNo(f.teacher_housing),
        },
        { key: 'imam_housing', label: t('reports.facImamHousing'), value: yesNo(f.imam_housing) },
        {
          key: 'guest_housing',
          label: t('reports.facGuestHousing'),
          value: yesNo(f.guest_housing),
        },
        { key: 'library', label: t('reports.facLibrary'), value: yesNo(f.library) },
        { key: 'quran_count', label: t('reports.facQuranCount'), value: numText(f.quran_count) },
        { key: 'quran_need', label: t('reports.facQuranNeed'), value: numText(f.quran_need) },
        { key: 'hall', label: t('reports.facHall'), value: yesNo(f.hall) },
        {
          key: 'hall_capacity',
          label: t('reports.facHallCapacity'),
          value: numText(f.hall_capacity),
        },
        {
          key: 'transport',
          label: t('reports.facTransport'),
          value: enumLabel('student_transport', textOf(f.student_transport)),
        },
        {
          key: 'origin',
          label: t('reports.facOrigin'),
          value: enumLabel('students_origin', textOf(f.students_origin)),
        },
      ]
    : [];

  const c = report.community;
  const communityItems: KvItem[] = c
    ? [
        { key: 'branch_name', label: t('reports.comBranchName'), value: textOf(c.branch_name) },
        { key: 'population', label: t('reports.comPopulation'), value: numText(c.population) },
        {
          key: 'muslim_pct',
          label: t('reports.comMuslimPct'),
          value: typeof c.muslim_pct === 'number' ? pct(c.muslim_pct) : '',
        },
        ...OPTION_LIST_KEYS.map((list) => {
          const entry = c.lists?.[list];
          const names = (entry?.options ?? []).map((o) => pickName(o)).filter(Boolean);
          if (entry?.other) names.push(entry.other);
          return {
            key: list,
            label: t(`reports.list_${list}`),
            value: names.join(t('reports.listSep')),
          };
        }),
      ]
    : [];

  return (
    <div class="pproject" data-testid="print-project">
      <div class="ptitle">
        <TypeIcon type={p.type} size={36} labelled />
        <div class="ptitle__text">
          <h1 class="ptitle__name">
            <bdi>{name}</bdi>
          </h1>
          {p.name_latin && p.name_ar && name !== p.name_latin && (
            <p class="ptitle__alt" dir="ltr">
              {p.name_latin}
            </p>
          )}
          <p class="ptitle__meta">
            {p.code && (
              <span class="mono ltr" dir="ltr" data-testid="print-code">
                {p.code}
              </span>
            )}
            <StatusBadge status={p.status} testId="print-status" />
            <RecordStateBadge state={p.record_state} />
          </p>
        </div>
      </div>

      <div class="pgrid">
        <div class="pcover" data-testid="print-cover">
          {cover ? (
            <figure>
              <PhotoImg
                photo={cover}
                kind="full"
                class="pcover__img"
                alt={photoText(cover) || name}
              />
              {photoText(cover) && <figcaption>{photoText(cover)}</figcaption>}
            </figure>
          ) : (
            <div class="pcover__none muted">{t('reports.noPhotos')}</div>
          )}
        </div>
        <AreaMap
          countryId={report.country?.id ?? null}
          areas={report.admin_areas}
          lon={p.lon}
          lat={p.lat}
        />
      </div>

      {gallery.length > 0 && (
        <ul class="pgallery" data-testid="print-gallery" aria-label={t('reports.gallery')}>
          {gallery.map((ph) => (
            <li key={ph.id}>
              <figure>
                <PhotoImg photo={ph} kind="thumb" alt={photoText(ph) || name} />
                {photoText(ph) && <figcaption>{photoText(ph)}</figcaption>}
              </figure>
            </li>
          ))}
        </ul>
      )}

      <PSection id="facts" title={t('reports.printFacts')}>
        <Kv items={facts} testId="print-facts" />
      </PSection>

      {land && (
        <PSection id="land" title={t('reports.printLand')}>
          <Kv items={landItems} />
        </PSection>
      )}
      {f && (
        <PSection id="facilities" title={t('reports.printFacilities')}>
          <Kv items={facilityItems} />
        </PSection>
      )}
      {c && (
        <PSection id="community" title={t('reports.printCommunity')}>
          <Kv items={communityItems} />
        </PSection>
      )}

      <PSection id="staff" title={t('reports.printStaff')}>
        {report.staff === undefined ? (
          <p data-testid="print-staff-count">
            {t('reports.staffCountOnly', { count: report.staff_count })}
          </p>
        ) : report.staff.length === 0 ? (
          <p class="muted">{t('reports.noStaff')}</p>
        ) : (
          <table class="ptable" data-testid="print-staff">
            <thead>
              <tr>
                <th scope="col">{t('reports.colName')}</th>
                <th scope="col">{t('reports.colRole')}</th>
                <th scope="col">{t('reports.colSince')}</th>
                {salaries && <th scope="col">{t('reports.colSalary')}</th>}
              </tr>
            </thead>
            <tbody>
              {report.staff.map((s) => (
                <tr key={s.project_staff_id} data-testid="print-staff-row">
                  <td>
                    {s.person_visible ? (
                      <bdi>{pickName(s) || t('reports.unnamedUser')}</bdi>
                    ) : (
                      <span class="muted">{t('reports.hiddenPerson')}</span>
                    )}
                  </td>
                  <td>{enumLabel('staff_role', s.role)}</td>
                  <td>{s.start_date ? fmt.date(s.start_date) : ''}</td>
                  {salaries && (
                    <td data-testid="print-salary">
                      {money(s.monthly_amount ?? null, s.currency ?? null)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PSection>

      <PSection id="maintenance" title={t('reports.printMaintenance')}>
        {report.maintenance.length === 0 ? (
          <p class="muted">{t('reports.noMaintenance')}</p>
        ) : (
          <table class="ptable" data-testid="print-maintenance">
            <thead>
              <tr>
                <th scope="col">{t('reports.colDate')}</th>
                <th scope="col">{t('reports.colDescription')}</th>
                <th scope="col">{t('reports.colPriority')}</th>
                <th scope="col">{t('reports.colState')}</th>
                <th scope="col">{t('reports.colCost')}</th>
              </tr>
            </thead>
            <tbody>
              {report.maintenance.map((m) => (
                <tr key={m.id} data-testid="print-maintenance-row">
                  <td>{m.reported_on ? fmt.date(m.reported_on) : ''}</td>
                  <td>{m.description}</td>
                  <td>{enumLabel('maintenance_priority', m.priority)}</td>
                  <td>
                    {enumLabel('maintenance_state', m.state)}
                    {m.resolved_on && <span class="ptable__sub">{fmt.date(m.resolved_on)}</span>}
                  </td>
                  <td>{money(m.estimated_cost, m.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </PSection>

      {report.donors.length > 0 && (
        <PSection id="donors" title={t('reports.printDonors')}>
          <table class="ptable" data-testid="print-donors">
            <thead>
              <tr>
                <th scope="col">{t('reports.colDonor')}</th>
                <th scope="col">{t('reports.colAmount')}</th>
                <th scope="col">{t('reports.colYear')}</th>
              </tr>
            </thead>
            <tbody>
              {report.donors.map((d) => (
                <tr key={d.id}>
                  <td>
                    <bdi>{pickName(d)}</bdi>
                  </td>
                  <td>{money(d.amount, d.currency)}</td>
                  <td>{d.year ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PSection>
      )}
    </div>
  );
}
