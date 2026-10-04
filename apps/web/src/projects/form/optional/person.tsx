/**
 * The person of a staff row (brief §2.4): `<PersonPicker>` of `src/people` — typing a name
 * shows possible matches and the user chooses "same person" or "new person"; nothing is ever
 * merged automatically. While that module is not available a minimal picker with the same
 * rule (explicit choice, local candidates only) keeps the form usable.
 */
import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { pickName, t } from '../../../i18n';
import {
  findLocalPersonCandidates,
  newRow,
  normalizePhone,
  type PersonCandidate,
  type ProjectBundle,
  type Row,
} from '../../../db';
import { Button, Spinner } from '../../../ui';
import { enumLabel } from '../../labels';
import { useForm } from '../context';
import { F } from '../controls';
import { fieldId } from '../validate';
import {
  loadPersonPicker,
  type NewPersonInput,
  type PersonPickerDraft,
  type PersonPickerProps,
  type PersonPickerSelection,
} from '../peers';

type StaffEntry = ProjectBundle['staff'][number];

export function PersonField({ entry }: { entry: StaffEntry }) {
  const { draft, api, errors } = useForm();
  const project = draft.working.project;
  const [Picker, setPicker] = useState<ComponentType<PersonPickerProps> | null | undefined>(
    undefined,
  );
  const key = `staff.${entry.id}.person`;
  const isNew = !!entry.person && draft.extras.newPersonIds.includes(entry.person.id);

  useEffect(() => {
    let alive = true;
    void loadPersonPicker().then((c) => alive && setPicker(() => c));
    return () => {
      alive = false;
    };
  }, []);

  const onSelect = (sel: PersonPickerSelection): void => {
    const previousNew = isNew ? entry.person!.id : null;
    if ('personId' in sel) {
      api.update((d) => ({
        ...d,
        working: {
          ...d.working,
          staff: d.working.staff.map((x) => {
            if (x.id !== entry.id) return x;
            const { person: _drop, ...rest } = x;
            return { ...rest, person_id: sel.personId };
          }),
        },
        extras: {
          ...d.extras,
          newPersonIds: d.extras.newPersonIds.filter((n) => n !== previousNew),
        },
      }));
    } else {
      // Everything the picker collected (v2 parity 3.1: birth year, home area, education…).
      const input = sel.newPerson as NewPersonInput & Partial<Row<'persons'>>;
      const person = newRow('persons', {
        ...input,
        name_ar: input.name_ar?.trim() || null,
        name_latin: input.name_latin?.trim() || null,
        phone_e164: input.phone_e164 ? normalizePhone(input.phone_e164) : null,
        country_id: project.country_id,
        branch_id: project.branch_id,
        home_admin_area_id: input.home_admin_area_id ?? project.admin_area_id,
      } as Partial<Row<'persons'>>);
      api.update((d) => ({
        ...d,
        working: {
          ...d.working,
          staff: d.working.staff.map((x) =>
            x.id === entry.id ? { ...x, person_id: person.id, person } : x,
          ),
        },
        extras: {
          ...d.extras,
          newPersonIds: [...d.extras.newPersonIds.filter((n) => n !== previousNew), person.id],
        },
      }));
    }
    api.clearError(key);
  };

  // Typed in the picker but not chosen yet (search text, half-filled "new person" form): kept
  // in the autosaved draft and handed back when the picker mounts again (Back, reload, a
  // folded section reopened — brief §7.4).
  const pickerDraft = draft.extras.pickerDrafts?.[entry.id] ?? null;
  const onPickerDraft = (next: PersonPickerDraft | null): void => {
    api.update((d) => {
      const current = d.extras.pickerDrafts ?? {};
      if (!next && !(entry.id in current)) return d; // nothing to forget: no autosave
      const pickerDrafts = { ...current };
      if (next) pickerDrafts[entry.id] = next;
      else delete pickerDrafts[entry.id];
      return { ...d, extras: { ...d.extras, pickerDrafts } };
    });
  };

  const newPersonLine = isNew && entry.person && (
    <p class="pf-picked" data-testid="form-staff-new-person">
      <span>{pickName(entry.person)}</span>
      <span class="pf-tag">{t('form.newTag')}</span>
    </p>
  );

  if (Picker) {
    // The picker brings its own label and hints; the form adds the new-person line and the
    // inline error (linked through the group's aria-describedby).
    const error = errors[key];
    const errorId = `${fieldId(key)}-error`;
    return (
      <div
        class={error ? 'pf-person field--invalid' : 'pf-person'}
        id={fieldId(key)}
        role="group"
        aria-describedby={error ? errorId : undefined}
      >
        {newPersonLine}
        <Picker
          value={isNew ? null : entry.person_id || null}
          onChange={onSelect}
          adminAreaId={project.admin_area_id}
          role={entry.role ?? undefined}
          testId="form-staff-person"
          draft={pickerDraft}
          onDraftChange={onPickerDraft}
        />
        {error && (
          <p class="field__error" id={errorId} role="alert">
            {t(error)}
          </p>
        )}
      </div>
    );
  }

  return (
    <F k={key} label={t('form.person')} required>
      <div class="pf-person">
        {newPersonLine}
        {Picker === undefined ? (
          <Spinner size={20} />
        ) : (
          <FallbackPicker
            current={!isNew && entry.person ? entry.person : null}
            adminAreaId={project.admin_area_id}
            onSelect={onSelect}
          />
        )}
      </div>
    </F>
  );
}

function FallbackPicker({
  current,
  adminAreaId,
  onSelect,
}: {
  current: Row<'persons'> | null;
  adminAreaId: string | null;
  onSelect: (sel: PersonPickerSelection) => void;
}) {
  const [editing, setEditing] = useState(!current);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [candidates, setCandidates] = useState<PersonCandidate[]>([]);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (name.trim().length < 2 && !phone.trim()) setCandidates([]);
      else
        void findLocalPersonCandidates({ name, phone, adminAreaId }).then(
          (c) => alive && setCandidates(c),
        );
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [name, phone, adminAreaId]);

  if (current && !editing) {
    return (
      <div class="pf-picked">
        <span>{pickName(current)}</span>
        <Button
          variant="ghost"
          size="sm"
          testId="form-staff-person-change"
          onClick={() => setEditing(true)}
        >
          {t('form.change')}
        </Button>
      </div>
    );
  }

  const hasArabic = [...name].some((ch) => ch.charCodeAt(0) >= 0x600 && ch.charCodeAt(0) <= 0x6ff);
  return (
    <div class="pf-fallback-picker">
      <div class="pf-grid2">
        <input
          type="text"
          class="control"
          dir="auto"
          value={name}
          placeholder={t('form.personName')}
          aria-label={t('form.personName')}
          data-testid="form-staff-person-name"
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <input
          type="tel"
          class="control ltr-num"
          dir="ltr"
          value={phone}
          placeholder={t('form.personPhone')}
          aria-label={t('form.personPhone')}
          data-testid="form-staff-person-phone"
          onInput={(e) => setPhone(e.currentTarget.value)}
        />
      </div>
      {candidates.length > 0 && (
        <div class="pf-candidates" role="group" aria-label={t('form.possibleMatches')}>
          <p class="pf-note pf-note--info">{t('form.possibleMatches')}</p>
          <ul class="pf-search__list">
            {candidates.map((c) => (
              <li key={c.id} class="pf-candidate">
                <span>
                  <strong>{pickName(c)}</strong>
                  {c.roles.length > 0 && (
                    <span class="muted">
                      {' '}
                      · {c.roles.map((r) => enumLabel('staff_role', r)).join(t('form.listSep'))}
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  testId={`form-person-same-${c.id}`}
                  onClick={() => onSelect({ personId: c.id })}
                >
                  {t('form.samePerson')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {name.trim().length >= 2 && (
        <Button
          size="sm"
          testId="form-person-new"
          onClick={() =>
            onSelect({
              newPerson: {
                name_ar: hasArabic ? name.trim() : '',
                ...(hasArabic ? {} : { name_latin: name.trim() }),
                ...(phone.trim() ? { phone_e164: phone.trim() } : {}),
              },
            })
          }
        >
          {t('form.newPerson')}
        </Button>
      )}
    </div>
  );
}
