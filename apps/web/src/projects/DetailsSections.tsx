import type { ComponentChildren } from 'preact';
import { me } from '../auth';
import { OPTION_LIST_KEYS, type ProjectBundle, type Row } from '../db';
import { fmt, pickName, t } from '../i18n';
import { enumLabel } from './labels';
import type { Actor } from './permissions';
import type { ProjectDetails } from './queries';

type Value = ComponentChildren | null | undefined | false;

const present = (v: Value): boolean => v !== null && v !== undefined && v !== false && v !== '';

/** Label / value pairs; empty values are left out. */
export function KeyValues({ items, testId }: { items: Array<[string, Value]>; testId?: string }) {
  const shown = items.filter(([, v]) => present(v));
  if (shown.length === 0) return <p class="psection__empty">{t('projects.noData')}</p>;
  return (
    <dl class="pkv" data-testid={testId}>
      {shown.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({
  id,
  title,
  testId,
  children,
}: {
  id: string;
  title: string;
  testId?: string;
  children: ComponentChildren;
}) {
  return (
    <section class="psection" aria-labelledby={`sec-${id}`} data-testid={testId}>
      <h2 id={`sec-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------------------

export const yesNo = (v: boolean | null | undefined): string | null =>
  v === true || v === false ? enumLabel('boolean', String(v)) : null;
export const num = (v: number | null | undefined): string | null =>
  typeof v === 'number' && Number.isFinite(v) ? fmt.number(v) : null;
export const pct = (v: number | null | undefined): string | null =>
  typeof v === 'number' && Number.isFinite(v) ? fmt.percent(v) : null;
const text = (v: string | null | undefined): string | null => (v && v.trim() !== '' ? v : null);
const auto = (v: string | null | undefined): Value => (text(v) ? <bdi dir="auto">{v}</bdi> : null);
const ltr = (v: string | null | undefined): Value =>
  text(v) ? (
    <span class="ltr" dir="ltr">
      {v}
    </span>
  ) : null;

/** Amount in its own currency (never summed across currencies). */
export const money = (
  amount: number | null | undefined,
  currency: string | null | undefined,
): string | null =>
  typeof amount === 'number' && Number.isFinite(amount)
    ? currency
      ? fmt.currency(amount, currency)
      : fmt.number(amount)
    : null;

// ---------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------

export function BasicSection({ details }: { details: ProjectDetails }) {
  const p = details.bundle.project;
  return (
    <Section id="basic" title={t('projects.sectionBasic')} testId="details-basic">
      <KeyValues
        items={[
          [t('projects.fieldType'), enumLabel('project_type', p.type)],
          [t('projects.fieldStatus'), enumLabel('project_status', p.status)],
          [t('projects.fieldNameAr'), auto(p.name_ar)],
          [t('projects.fieldNameLatin'), auto(p.name_latin)],
          [t('projects.fieldCode'), ltr(p.code)],
          [t('projects.fieldCapacity'), num(p.capacity)],
          [t('projects.fieldBuilder'), auto(p.builder)],
          [
            t('projects.fieldBuildYear'),
            p.build_date ? fmt.date(p.build_date) : p.build_year ? String(p.build_year) : null,
          ],
          [t('projects.fieldCountry'), details.country ? pickName(details.country) : null],
          ...details.areas.map((a): [string, Value] => [
            t(`projects.fieldAreaLevel${a.level}`),
            pickName(a) || a.code,
          ]),
          [
            t('projects.fieldLocality'),
            details.locality
              ? `${pickName(details.locality)}${details.locality.status === 'proposed' ? ` (${t('projects.localityProposed')})` : ''}`
              : null,
          ],
          [t('projects.fieldBranch'), details.branch ? pickName(details.branch) : null],
        ]}
      />
    </Section>
  );
}

export function LandSection({ bundle, actor }: { bundle: ProjectBundle; actor: Actor }) {
  const land = bundle.land;
  return (
    <Section id="land" title={t('projects.sectionLand')} testId="details-land">
      {!land ? (
        <p class="psection__empty">{t('projects.noData')}</p>
      ) : (
        <KeyValues
          items={[
            [t('projects.landOwnership'), enumLabel('land_ownership', land.ownership)],
            // owner_name is people data (schema.md): never shown to a role without people access.
            [t('projects.landOwner'), actor.seePeople ? auto(land.owner_name) : null],
            [
              t('projects.landArea'),
              land.area_m2 !== null
                ? t('projects.squareMeters', { value: fmt.number(land.area_m2) })
                : null,
            ],
            [t('projects.landUtilization'), pct(land.utilization_pct)],
            [t('projects.landExpandable'), yesNo(land.expandable)],
            [t('projects.landNotes'), auto(land.notes)],
          ]}
        />
      )}
    </Section>
  );
}

export function FacilitiesSection({ bundle }: { bundle: ProjectBundle }) {
  const f = bundle.facilities;
  return (
    <Section id="facilities" title={t('projects.sectionFacilities')} testId="details-facilities">
      {!f ? (
        <p class="psection__empty">{t('projects.noData')}</p>
      ) : (
        <KeyValues
          items={[
            [t('projects.facTeacherHousing'), yesNo(f.teacher_housing)],
            [t('projects.facImamHousing'), yesNo(f.imam_housing)],
            [t('projects.facGuestHousing'), yesNo(f.guest_housing)],
            [t('projects.facLibrary'), yesNo(f.library)],
            [t('projects.facQuranCount'), num(f.quran_count)],
            [t('projects.facQuranNeed'), num(f.quran_need)],
            [t('projects.facHall'), yesNo(f.hall)],
            [t('projects.facHallCapacity'), num(f.hall_capacity)],
            [t('projects.facTransport'), enumLabel('student_transport', f.student_transport)],
            [t('projects.facStudentsOrigin'), enumLabel('students_origin', f.students_origin)],
          ]}
        />
      )}
    </Section>
  );
}

/** Salary in force: amount in its currency + the USD equivalent from `fx_rates`. */
function Salary({ comp, rate }: { comp: Row<'staff_compensation'>; rate?: Row<'fx_rates'> }) {
  const usd =
    comp.currency === 'USD'
      ? null
      : rate
        ? fmt.currency(comp.monthly_amount * rate.usd_per_unit, 'USD')
        : undefined;
  return (
    <span data-testid="staff-salary">
      {t('projects.salaryMonthly', { value: fmt.currency(comp.monthly_amount, comp.currency) })}
      {usd && <span class="muted"> · {t('projects.salaryUsd', { value: usd })}</span>}
      {usd === undefined && <span class="muted"> · {t('projects.noFxRate')}</span>}
    </span>
  );
}

export function StaffSection({ details, actor }: { details: ProjectDetails; actor: Actor }) {
  const staff = details.bundle.staff.filter((s) => !s.deleted_at);
  return (
    <Section id="staff" title={t('projects.sectionStaff')} testId="details-staff">
      {!actor.seePeople ? (
        <p class="psection__empty" data-testid="staff-hidden">
          {t('projects.staffHidden')}
        </p>
      ) : staff.length === 0 ? (
        <p class="psection__empty">{t('projects.noStaff')}</p>
      ) : (
        <ul class="prows">
          {staff.map((s) => {
            const person = s.person;
            const name = person ? pickName(person) : '';
            const ended = s.end_date !== null;
            return (
              <li key={s.id} class="prow" data-testid="staff-entry">
                <div class="prow__head">
                  <bdi class="prow__title" data-testid="staff-name">
                    {name || t('projects.hiddenPerson')}
                  </bdi>
                  <span class="badge badge--gold">{enumLabel('staff_role', s.role)}</span>
                  {ended && <span class="badge">{t('projects.staffEnded')}</span>}
                </div>
                <div class="prow__meta">
                  {[
                    s.start_date ? t('projects.staffFrom', { date: fmt.date(s.start_date) }) : null,
                    s.end_date ? t('projects.staffTo', { date: fmt.date(s.end_date) }) : null,
                    person?.birth_year
                      ? t('projects.staffBirthYear', { year: String(person.birth_year) })
                      : null,
                    text(person?.education_level),
                    text(person?.graduated_from),
                  ]
                    .filter((x): x is string => typeof x === 'string' && x !== '')
                    .join(' · ')}
                </div>
                {person?.phone_e164 && (
                  <a
                    class="prow__meta ltr"
                    dir="ltr"
                    href={`tel:${person.phone_e164}`}
                    data-testid="staff-phone"
                  >
                    {person.phone_e164}
                  </a>
                )}
                {actor.seeRestricted && s.compensation && (
                  <Salary comp={s.compensation} rate={details.fx.get(s.compensation.id)} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export function CommunitySection({ details }: { details: ProjectDetails }) {
  const c = details.bundle.community as
    (Row<'community_profiles'> & Record<string, unknown>) | undefined;
  return (
    <Section id="community" title={t('projects.sectionCommunity')} testId="details-community">
      {!c ? (
        <p class="psection__empty">{t('projects.noData')}</p>
      ) : (
        <KeyValues
          items={[
            [t('projects.communityBranchName'), auto(c.branch_name)],
            [t('projects.communityPopulation'), num(c.population)],
            [t('projects.communityMuslimPct'), pct(c.muslim_pct)],
            ...OPTION_LIST_KEYS.map((key): [string, Value] => {
              const ids = Array.isArray(c[key]) ? (c[key] as string[]) : [];
              const names = ids.map((id) => {
                const option = details.options.get(id);
                return option ? pickName(option) : '';
              });
              const other = c[`${key}_other`];
              if (typeof other === 'string' && other.trim() !== '') names.push(other);
              const shown = names.filter((n) => n !== '');
              return [
                t(`projects.community_${key}`),
                shown.length > 0 ? (
                  <ul class="ptags">
                    {shown.map((n, i) => (
                      <li key={`${i}-${n}`}>
                        <bdi>{n}</bdi>
                      </li>
                    ))}
                  </ul>
                ) : null,
              ];
            }),
          ]}
        />
      )}
    </Section>
  );
}

/** RESTRICTED: rendered only for users with restricted access. */
export function SensitiveSection({ bundle }: { bundle: ProjectBundle }) {
  const s = bundle.sensitive;
  return (
    <Section id="sensitive" title={t('projects.sectionSensitive')} testId="details-sensitive">
      <p class="pnote">{t('projects.sensitiveNote')}</p>
      {!s ? (
        <p class="psection__empty">{t('projects.noData')}</p>
      ) : (
        <KeyValues
          items={[
            [t('projects.sensIbadiFamilies'), num(s.ibadi_families)],
            [t('projects.sensOmaniFamilies'), num(s.omani_families)],
            [t('projects.sensOmaniStudents'), pct(s.omani_student_pct)],
            [t('projects.sensIbadiStudents'), pct(s.ibadi_student_pct)],
            [t('projects.sensOmaniTeachers'), pct(s.omani_teacher_pct)],
            [t('projects.sensIbadiTeachers'), pct(s.ibadi_teacher_pct)],
            [
              t('projects.sensGuestCapacity'),
              enumLabel('guest_financial_capacity', s.guest_financial_capacity),
            ],
          ]}
        />
      )}
    </Section>
  );
}

export function DonorsSection({ bundle }: { bundle: ProjectBundle }) {
  const donors = bundle.donors.filter((d) => !d.deleted_at);
  return (
    <Section id="donors" title={t('projects.sectionDonors')} testId="details-donors">
      {donors.length === 0 ? (
        <p class="psection__empty">{t('projects.noDonors')}</p>
      ) : (
        <ul class="prows">
          {donors.map((d) => (
            <li key={d.id} class="prow" data-testid="donor-entry">
              <bdi class="prow__title">
                {d.donor ? pickName(d.donor) : t('projects.unknownDonor')}
              </bdi>
              <span class="prow__meta">
                {[money(d.amount, d.currency), d.year ? String(d.year) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** `geo:` URI (opens the phone's maps app) and a Google Maps directions link (v2 parity 2.16). */
export function directionLinks(lat: number, lon: number): { geo: string; google: string } {
  const at = `${lat},${lon}`;
  return {
    geo: `geo:${at}?q=${at}`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(at)}`,
  };
}

export function LocationSection({ project }: { project: Row<'projects'> }) {
  const has = typeof project.lat === 'number' && typeof project.lon === 'number';
  const links = has ? directionLinks(project.lat as number, project.lon as number) : null;
  return (
    <Section id="location" title={t('projects.sectionLocation')} testId="details-location">
      {!has || !links ? (
        <p class="psection__empty">{t('projects.noLocation')}</p>
      ) : (
        <>
          <KeyValues
            items={[
              [
                t('projects.fieldCoordinates'),
                <span class="ltr mono" dir="ltr" data-testid="details-coordinates">
                  {`${(project.lat as number).toFixed(6)}, ${(project.lon as number).toFixed(6)}`}
                </span>,
              ],
              [
                t('projects.fieldAccuracy'),
                typeof project.gps_accuracy_m === 'number'
                  ? t('projects.meters', { value: fmt.number(Math.round(project.gps_accuracy_m)) })
                  : null,
              ],
              [
                t('projects.fieldLocationSource'),
                enumLabel('location_source', project.location_source),
              ],
            ]}
          />
          <div class="pdetails__actions" style={{ marginBlockStart: 'var(--sp-3)' }}>
            <a class="btn btn--secondary" href={links.geo} data-testid="details-directions-geo">
              <span class="btn__label">{t('projects.directionsApp')}</span>
            </a>
            <a
              class="btn btn--secondary"
              href={links.google}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="details-directions-google"
            >
              <span class="btn__label">{t('projects.directionsGoogle')}</span>
            </a>
          </div>
        </>
      )}
    </Section>
  );
}

/** Who entered / changed the record. Names of other users are not on the device. */
function who(userId: string | null, actor: Actor): string | null {
  if (!userId) return null;
  if (userId === actor.userId) return me.value?.profile?.full_name || t('projects.you');
  return t('projects.otherUser');
}

export function MetaSection({ project, actor }: { project: Row<'projects'>; actor: Actor }) {
  return (
    <Section id="meta" title={t('projects.sectionMeta')} testId="details-meta">
      <KeyValues
        items={[
          [t('projects.enteredBy'), who(project.created_by, actor)],
          [t('projects.enteredAt'), fmt.dateTime(project.created_at)],
          [t('projects.updatedBy'), who(project.updated_by, actor)],
          [t('projects.updatedAt'), fmt.dateTime(project.updated_at)],
          [
            t('projects.reviewedAt'),
            project.reviewed_at ? fmt.dateTime(project.reviewed_at) : null,
          ],
        ]}
      />
    </Section>
  );
}
