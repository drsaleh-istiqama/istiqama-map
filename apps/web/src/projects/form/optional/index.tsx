/**
 * The folded optional sections of the form (brief §7.1, V2_PARITY §2–§4). A separate lazy
 * chunk: it is fetched when the first section is opened (or prefetched when the phone is
 * idle), so the first screen of the form stays light.
 */
import { useEffect, useState } from 'preact/hooks';
import { pickName, t } from '../../../i18n';
import {
  CURRENCIES,
  GUEST_FINANCIAL_CAPACITIES,
  LAND_OWNERSHIPS,
  OPTION_LIST_KEYS,
  STAFF_ROLES,
  STUDENTS_ORIGINS,
  STUDENT_TRANSPORTS,
  newRow,
  type OptionListKey,
  type ProjectBundle,
  type Row,
} from '../../../db';
import { Button, Chips, confirm } from '../../../ui';
import { useForm } from '../context';
import { DateInput, EnumSelect, F, NumberInput, TextArea, TextInput, TriState } from '../controls';
import { isLive, today } from '../model';
import { getDonor, listOptions, searchDonors, type DonorChoice } from '../queries';
import { PersonField } from './person';

/** True when the text contains Arabic letters (U+0600..U+06FF). */
const hasArabic = (text: string): boolean =>
  [...text].some((ch) => ch.charCodeAt(0) >= 0x600 && ch.charCodeAt(0) <= 0x6ff);

// ---------------------------------------------------------------------------------------
// Basic details: capacity, builder, build year (+ optional full date)
// ---------------------------------------------------------------------------------------

export function BasicsSection() {
  const { draft, api } = useForm();
  const p = draft.working.project;
  const [fullDate, setFullDate] = useState(!!p.build_date);
  return (
    <div class="pf-fields">
      <F k="capacity" label={t('form.capacity')} hint={t('form.capacityHint')}>
        <NumberInput
          value={p.capacity}
          testId="form-capacity"
          onValue={(v) => api.setProject({ capacity: v })}
        />
      </F>
      <F k="builder" label={t('form.builder')}>
        <TextInput
          value={p.builder}
          dir="auto"
          testId="form-builder"
          onValue={(v) => api.setProject({ builder: v === '' ? null : v })}
        />
      </F>
      <F k="build_year" label={t('form.buildYear')}>
        <NumberInput
          value={p.build_year}
          testId="form-build-year"
          onValue={(v) => api.setProject({ build_year: v })}
        />
      </F>
      {fullDate ? (
        <F k="build_date" label={t('form.buildDate')}>
          <DateInput
            value={p.build_date}
            testId="form-build-date"
            onValue={(v) =>
              api.setProject({
                build_date: v,
                ...(v && (p.build_year === null || p.build_year === undefined)
                  ? { build_year: Number(v.slice(0, 4)) }
                  : {}),
              })
            }
          />
        </F>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          testId="form-build-date-add"
          onClick={() => setFullDate(true)}
        >
          {t('form.buildDateAdd')}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Donors
// ---------------------------------------------------------------------------------------

type DonorEntry = ProjectBundle['donors'][number];

function DonorPicker({ entry }: { entry: DonorEntry }) {
  const { draft, api } = useForm();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<DonorChoice[]>([]);
  const [name, setName] = useState<string | null>(entry.donor ? pickName(entry.donor) : null);
  const [changing, setChanging] = useState(!entry.donor_id);
  const key = `donors.${entry.id}.donor`;

  useEffect(() => {
    let alive = true;
    if (entry.donor) setName(pickName(entry.donor));
    else if (entry.donor_id)
      void getDonor(entry.donor_id).then((d) => alive && setName(d ? pickName(d) : null));
    return () => {
      alive = false;
    };
  }, [entry.donor_id]);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (q.trim().length < 2) setHits([]);
      else void searchDonors(q).then((h) => alive && setHits(h));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  const choose = (id: string, label: string): void => {
    const previous =
      entry.donor && draft.extras.newDonorIds.includes(entry.donor.id) ? entry.donor.id : null;
    api.update((d) => ({
      ...d,
      working: {
        ...d.working,
        donors: d.working.donors.map((x) => {
          if (x.id !== entry.id) return x;
          const { donor: _drop, ...rest } = x;
          return { ...rest, donor_id: id };
        }),
      },
      extras: { ...d.extras, newDonorIds: d.extras.newDonorIds.filter((n) => n !== previous) },
    }));
    setName(label);
    setChanging(false);
    api.clearError(key);
  };

  const createNew = (): void => {
    const text = q.trim();
    if (!text) return;
    const donor = newRow('donors', hasArabic(text) ? { name_ar: text } : { name_latin: text });
    const previous =
      entry.donor && draft.extras.newDonorIds.includes(entry.donor.id) ? entry.donor.id : null;
    api.update((d) => ({
      ...d,
      working: {
        ...d.working,
        donors: d.working.donors.map((x) =>
          x.id === entry.id ? { ...x, donor_id: donor.id, donor } : x,
        ),
      },
      extras: {
        ...d.extras,
        newDonorIds: [...d.extras.newDonorIds.filter((n) => n !== previous), donor.id],
      },
    }));
    setName(text);
    setChanging(false);
    api.clearError(key);
  };

  if (!changing && entry.donor_id) {
    return (
      <div class="pf-picked" data-testid="form-donor-picked">
        <span>
          {name ?? t('form.donorUnknown')}
          {entry.donor && draft.extras.newDonorIds.includes(entry.donor.id) && (
            <span class="pf-tag">{t('form.newTag')}</span>
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          testId="form-donor-change"
          onClick={() => setChanging(true)}
        >
          {t('form.change')}
        </Button>
      </div>
    );
  }
  return (
    <F k={key} label={t('form.donor')} required>
      <div class="pf-search">
        <input
          type="search"
          class="control"
          value={q}
          placeholder={t('form.donorSearch')}
          aria-label={t('form.donorSearch')}
          data-testid="form-donor-search"
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        {(hits.length > 0 || q.trim().length >= 2) && (
          <ul class="pf-search__list">
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  class="pf-search__hit"
                  data-testid={`form-donor-pick-${h.id}`}
                  onClick={() => choose(h.id, pickName(h))}
                >
                  {pickName(h)}
                </button>
              </li>
            ))}
            {q.trim().length >= 2 && (
              <li>
                <button
                  type="button"
                  class="pf-search__hit pf-search__new"
                  data-testid="form-donor-new"
                  onClick={createNew}
                >
                  {t('form.donorNew', { name: q.trim() })}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </F>
  );
}

export function DonorsSection() {
  const { draft, api, env } = useForm();
  const entries = draft.working.donors.filter(isLive);
  const add = (): void =>
    api.addRow(
      'donors',
      newRow('project_donors', {
        project_id: draft.projectId,
        currency: env.currency,
      } as Partial<Row<'project_donors'>>) as DonorEntry,
    );
  return (
    <div class="pf-fields">
      {entries.length === 0 && <p class="muted">{t('form.donorsEmpty')}</p>}
      {entries.map((entry, i) => (
        <div class="pf-entry" key={entry.id} data-testid="form-donor-entry">
          <p class="pf-entry__title">{t('form.donorN', { n: i + 1 })}</p>
          <DonorPicker entry={entry} />
          <div class="pf-grid3">
            <F k={`donors.${entry.id}.amount`} label={t('form.amount')}>
              <NumberInput
                decimal
                value={entry.amount}
                testId="form-donor-amount"
                onValue={(v) => api.patchRow('donors', entry.id, { amount: v })}
              />
            </F>
            <F k={`donors.${entry.id}.currency`} label={t('form.currency')}>
              <EnumSelect
                enumKey="currency"
                codes={CURRENCIES}
                value={entry.currency}
                testId="form-donor-currency"
                onValue={(v) => api.patchRow('donors', entry.id, { currency: v })}
              />
            </F>
            <F k={`donors.${entry.id}.year`} label={t('form.year')}>
              <NumberInput
                value={entry.year}
                testId="form-donor-year"
                onValue={(v) => api.patchRow('donors', entry.id, { year: v })}
              />
            </F>
          </div>
          <RemoveButton
            label={t('form.donorRemove')}
            testId="form-donor-remove"
            onConfirm={() => api.removeRow('donors', entry.id)}
          />
        </div>
      ))}
      <Button size="sm" testId="form-donor-add" onClick={add}>
        {t('form.donorAdd')}
      </Button>
    </div>
  );
}

function RemoveButton({
  label,
  testId,
  onConfirm,
}: {
  label: string;
  testId: string;
  onConfirm: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      testId={testId}
      onClick={async () => {
        if (
          await confirm({
            title: label,
            message: t('form.removeBody'),
            confirmLabel: t('common.delete'),
            danger: true,
          })
        )
          onConfirm();
      }}
    >
      {label}
    </Button>
  );
}

// ---------------------------------------------------------------------------------------
// Staff (persons are chosen explicitly — never merged automatically)
// ---------------------------------------------------------------------------------------

type StaffEntry = ProjectBundle['staff'][number];

function SalaryFields({ entry }: { entry: StaffEntry }) {
  const { draft, api, env } = useForm();
  const comp = entry.compensation;
  const stored = draft.original?.staff.find((x) => x.id === entry.id)?.compensation;
  const set = (patch: Partial<Row<'staff_compensation'>>): void => {
    const base =
      comp ??
      newRow('staff_compensation', {
        project_staff_id: entry.id,
        currency: env.currency,
        effective_from: today(),
      } as Partial<Row<'staff_compensation'>>);
    const next = { ...base, ...patch };
    // Clearing the amount of a salary typed in this form forgets it (nothing to send).
    const forget =
      (next.monthly_amount === null || next.monthly_amount === undefined) && next.id !== stored?.id;
    api.patchRow('staff', entry.id, {
      compensation: forget ? undefined : next,
    } as Partial<StaffEntry>);
  };
  return (
    <div class="pf-restricted" data-testid="form-staff-salary">
      <p class="pf-note pf-note--restricted">
        {env.access.restrictedRead ? t('form.salaryNoteReader') : t('form.salaryNoteBlind')}
      </p>
      <div class="pf-grid3">
        <F k={`staff.${entry.id}.salary`} label={t('form.salary')}>
          <NumberInput
            decimal
            value={comp?.monthly_amount ?? null}
            testId="form-staff-salary-amount"
            onValue={(v) => set({ monthly_amount: v as number })}
          />
        </F>
        <F k={`staff.${entry.id}.salary_currency`} label={t('form.currency')}>
          <EnumSelect
            enumKey="currency"
            codes={CURRENCIES}
            value={comp?.currency ?? env.currency}
            testId="form-staff-salary-currency"
            onValue={(v) => v && set({ currency: v as Row<'staff_compensation'>['currency'] })}
          />
        </F>
        <F k={`staff.${entry.id}.salary_from`} label={t('form.salaryFrom')}>
          <DateInput
            value={comp?.effective_from ?? today()}
            testId="form-staff-salary-from"
            onValue={(v) => set({ effective_from: v ?? today() })}
          />
        </F>
      </div>
    </div>
  );
}

export function StaffSection() {
  const { draft, api, env } = useForm();
  const entries = draft.working.staff.filter(isLive);
  const add = (): void =>
    api.addRow(
      'staff',
      newRow('project_staff', { project_id: draft.projectId } as Partial<
        Row<'project_staff'>
      >) as StaffEntry,
    );
  return (
    <div class="pf-fields">
      {entries.length === 0 && <p class="muted">{t('form.staffEmpty')}</p>}
      {entries.map((entry, i) => (
        <div class="pf-entry" key={entry.id} data-testid="form-staff-entry">
          <p class="pf-entry__title">{t('form.staffN', { n: i + 1 })}</p>
          <PersonField entry={entry} />
          <div class="pf-grid3">
            <F k={`staff.${entry.id}.role`} label={t('form.role')} required>
              <EnumSelect
                enumKey="staff_role"
                codes={STAFF_ROLES}
                value={entry.role}
                testId="form-staff-role"
                onValue={(v) => {
                  api.patchRow('staff', entry.id, { role: v as StaffEntry['role'] });
                  api.clearError(`staff.${entry.id}.role`);
                }}
              />
            </F>
            <F k={`staff.${entry.id}.start_date`} label={t('form.startDate')}>
              <DateInput
                value={entry.start_date}
                testId="form-staff-start"
                onValue={(v) => api.patchRow('staff', entry.id, { start_date: v })}
              />
            </F>
            <F k={`staff.${entry.id}.end_date`} label={t('form.endDate')}>
              <DateInput
                value={entry.end_date}
                testId="form-staff-end"
                onValue={(v) => api.patchRow('staff', entry.id, { end_date: v })}
              />
            </F>
          </div>
          {env.access.restrictedWrite && <SalaryFields entry={entry} />}
          <RemoveButton
            label={t('form.staffRemove')}
            testId="form-staff-remove"
            onConfirm={() => api.removeRow('staff', entry.id)}
          />
        </div>
      ))}
      <Button size="sm" testId="form-staff-add" onClick={add}>
        {t('form.staffAdd')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Land, facilities
// ---------------------------------------------------------------------------------------

export function LandSection() {
  const { draft, api } = useForm();
  const land = draft.working.land;
  const set = (patch: Partial<Row<'project_land'>>): void => api.setSection('land', patch);
  return (
    <div class="pf-fields pf-grid2">
      <F k="land.ownership" label={t('form.landOwnership')}>
        <EnumSelect
          enumKey="land_ownership"
          codes={LAND_OWNERSHIPS}
          value={land?.ownership}
          testId="form-land-ownership"
          onValue={(v) => set({ ownership: v as Row<'project_land'>['ownership'] })}
        />
      </F>
      <F k="land.owner_name" label={t('form.landOwner')}>
        <TextInput
          value={land?.owner_name}
          dir="auto"
          testId="form-land-owner"
          onValue={(v) => set({ owner_name: v === '' ? null : v })}
        />
      </F>
      <F k="land.area_m2" label={t('form.landArea')}>
        <NumberInput
          decimal
          value={land?.area_m2}
          testId="form-land-area"
          onValue={(v) => set({ area_m2: v })}
        />
      </F>
      <F k="land.utilization_pct" label={t('form.landUtilization')}>
        <NumberInput
          decimal
          value={land?.utilization_pct}
          testId="form-land-utilization"
          onValue={(v) => set({ utilization_pct: v })}
        />
      </F>
      <F k="land.expandable" label={t('form.landExpandable')}>
        <TriState
          value={land?.expandable}
          testId="form-land-expandable"
          onValue={(v) => set({ expandable: v })}
        />
      </F>
      <F k="land.notes" label={t('form.notes')} class="pf-span2">
        <TextArea
          value={land?.notes}
          testId="form-land-notes"
          onValue={(v) => set({ notes: v === '' ? null : v })}
        />
      </F>
    </div>
  );
}

export function FacilitiesSection() {
  const { draft, api } = useForm();
  const f = draft.working.facilities;
  const set = (patch: Partial<Row<'project_facilities'>>): void =>
    api.setSection('facilities', patch);
  return (
    <div class="pf-fields pf-grid2">
      <F k="facilities.teacher_housing" label={t('form.teacherHousing')}>
        <TriState
          value={f?.teacher_housing}
          testId="form-fac-teacher-housing"
          onValue={(v) => set({ teacher_housing: v })}
        />
      </F>
      <F k="facilities.imam_housing" label={t('form.imamHousing')}>
        <TriState
          value={f?.imam_housing}
          testId="form-fac-imam-housing"
          onValue={(v) => set({ imam_housing: v })}
        />
      </F>
      <F k="facilities.guest_housing" label={t('form.guestHousing')}>
        <TriState
          value={f?.guest_housing}
          testId="form-fac-guest-housing"
          onValue={(v) => set({ guest_housing: v })}
        />
      </F>
      <F k="facilities.library" label={t('form.library')}>
        <TriState
          value={f?.library}
          testId="form-fac-library"
          onValue={(v) => set({ library: v })}
        />
      </F>
      <F k="facilities.quran_count" label={t('form.quranCount')}>
        <NumberInput
          value={f?.quran_count}
          testId="form-fac-quran-count"
          onValue={(v) => set({ quran_count: v })}
        />
      </F>
      <F k="facilities.quran_need" label={t('form.quranNeed')}>
        <NumberInput
          value={f?.quran_need}
          testId="form-fac-quran-need"
          onValue={(v) => set({ quran_need: v })}
        />
      </F>
      <F k="facilities.hall" label={t('form.hall')}>
        <TriState value={f?.hall} testId="form-fac-hall" onValue={(v) => set({ hall: v })} />
      </F>
      <F k="facilities.hall_capacity" label={t('form.hallCapacity')}>
        <NumberInput
          value={f?.hall_capacity}
          testId="form-fac-hall-capacity"
          onValue={(v) => set({ hall_capacity: v })}
        />
      </F>
      <F k="facilities.student_transport" label={t('form.studentTransport')}>
        <EnumSelect
          enumKey="student_transport"
          codes={STUDENT_TRANSPORTS}
          value={f?.student_transport}
          testId="form-fac-transport"
          onValue={(v) =>
            set({ student_transport: v as Row<'project_facilities'>['student_transport'] })
          }
        />
      </F>
      <F k="facilities.students_origin" label={t('form.studentsOrigin')}>
        <EnumSelect
          enumKey="students_origin"
          codes={STUDENTS_ORIGINS}
          value={f?.students_origin}
          testId="form-fac-origin"
          onValue={(v) =>
            set({ students_origin: v as Row<'project_facilities'>['students_origin'] })
          }
        />
      </F>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Community profile (public) and sensitive community data (restricted)
// ---------------------------------------------------------------------------------------

type Community = Row<'community_profiles'>;

function OptionList({ listKey }: { listKey: OptionListKey }) {
  const { draft, api } = useForm();
  const c = draft.working.community;
  const [rows, setRows] = useState<Row<'option_values'>[]>([]);
  useEffect(() => {
    let alive = true;
    void listOptions(listKey).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [listKey]);
  const value = (c?.[listKey] as string[] | undefined) ?? [];
  const otherKey = `${listKey}_other` as keyof Community;
  const otherText = (c?.[otherKey] as string | null | undefined) ?? '';
  const otherRow = rows.find((r) => r.code === 'other');
  const showOther = (otherRow && value.includes(otherRow.id)) || otherText !== '';
  const k = `community.${listKey}`;
  return (
    <F k={k} label={t(`form.opt_${listKey}`)}>
      <div>
        <Chips
          multiple
          options={rows.map((r) => ({ value: r.id, label: pickName(r) }))}
          value={value}
          testId={`form-opt-${listKey}`}
          onChange={(next) => {
            const patch: Partial<Community> = { [listKey]: next } as Partial<Community>;
            if (otherRow && !next.includes(otherRow.id))
              (patch as Record<string, unknown>)[otherKey] = null;
            api.setSection('community', patch);
          }}
        />
        {showOther && (
          <input
            type="text"
            class="control chips__other"
            maxLength={240}
            value={otherText}
            placeholder={t('ui.otherPlaceholder')}
            aria-label={t('form.otherText', { list: t(`form.opt_${listKey}`) })}
            data-testid={`form-opt-${listKey}-other`}
            onInput={(e) =>
              api.setSection('community', {
                [otherKey]: e.currentTarget.value || null,
              } as Partial<Community>)
            }
          />
        )}
      </div>
    </F>
  );
}

export function CommunitySection() {
  const { draft, api } = useForm();
  const c = draft.working.community;
  const set = (patch: Partial<Community>): void => api.setSection('community', patch);
  return (
    <div class="pf-fields">
      <div class="pf-grid3">
        <F k="community.branch_name" label={t('form.branchName')}>
          <TextInput
            value={c?.branch_name}
            dir="auto"
            testId="form-com-branch"
            onValue={(v) => set({ branch_name: v === '' ? null : v })}
          />
        </F>
        <F k="community.population" label={t('form.population')}>
          <NumberInput
            value={c?.population}
            testId="form-com-population"
            onValue={(v) => set({ population: v })}
          />
        </F>
        <F k="community.muslim_pct" label={t('form.muslimPct')}>
          <NumberInput
            decimal
            value={c?.muslim_pct}
            testId="form-com-muslim-pct"
            onValue={(v) => set({ muslim_pct: v })}
          />
        </F>
      </div>
      {OPTION_LIST_KEYS.map((key) => (
        <OptionList key={key} listKey={key} />
      ))}
    </div>
  );
}

export function SensitiveSection() {
  const { draft, api, env } = useForm();
  const s = draft.working.sensitive;
  const set = (patch: Partial<Row<'community_sensitive'>>): void =>
    api.setSection('sensitive', patch);
  return (
    <div class="pf-fields" data-testid="form-sensitive">
      <p class="pf-note pf-note--restricted">
        {env.access.restrictedRead ? t('form.sensitiveNoteReader') : t('form.sensitiveNoteBlind')}
      </p>
      <div class="pf-grid2">
        <F k="sensitive.ibadi_families" label={t('form.ibadiFamilies')}>
          <NumberInput
            value={s?.ibadi_families}
            testId="form-sen-ibadi-families"
            onValue={(v) => set({ ibadi_families: v })}
          />
        </F>
        <F k="sensitive.omani_families" label={t('form.omaniFamilies')}>
          <NumberInput
            value={s?.omani_families}
            testId="form-sen-omani-families"
            onValue={(v) => set({ omani_families: v })}
          />
        </F>
        <F k="sensitive.omani_student_pct" label={t('form.omaniStudentPct')}>
          <NumberInput
            decimal
            value={s?.omani_student_pct}
            testId="form-sen-omani-students"
            onValue={(v) => set({ omani_student_pct: v })}
          />
        </F>
        <F k="sensitive.ibadi_student_pct" label={t('form.ibadiStudentPct')}>
          <NumberInput
            decimal
            value={s?.ibadi_student_pct}
            testId="form-sen-ibadi-students"
            onValue={(v) => set({ ibadi_student_pct: v })}
          />
        </F>
        <F k="sensitive.omani_teacher_pct" label={t('form.omaniTeacherPct')}>
          <NumberInput
            decimal
            value={s?.omani_teacher_pct}
            testId="form-sen-omani-teachers"
            onValue={(v) => set({ omani_teacher_pct: v })}
          />
        </F>
        <F k="sensitive.ibadi_teacher_pct" label={t('form.ibadiTeacherPct')}>
          <NumberInput
            decimal
            value={s?.ibadi_teacher_pct}
            testId="form-sen-ibadi-teachers"
            onValue={(v) => set({ ibadi_teacher_pct: v })}
          />
        </F>
        <F k="sensitive.guest_financial_capacity" label={t('form.guestCapacity')}>
          <EnumSelect
            enumKey="guest_financial_capacity"
            codes={GUEST_FINANCIAL_CAPACITIES}
            value={s?.guest_financial_capacity}
            testId="form-sen-guest-capacity"
            onValue={(v) =>
              set({
                guest_financial_capacity:
                  v as Row<'community_sensitive'>['guest_financial_capacity'],
              })
            }
          />
        </F>
      </div>
    </div>
  );
}
