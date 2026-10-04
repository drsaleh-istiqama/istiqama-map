/**
 * Person picker for the staff form (web.md §5, brief §2.4).
 *
 *   <PersonPicker value={personId | null} onChange={(sel) => …} adminAreaId? role? testId? />
 *
 * Typing a name (or a phone number) lists "possible matching persons": the device's
 * `findLocalPersonCandidates` at once, then the server's `person_candidates` when online
 * (phone match, per-script trigram similarity >= 0.6, same-area ranking; phones masked by the
 * server stay masked). The user explicitly chooses "same person" or "new person".
 * It NEVER merges and never picks a person on its own — not even for an exact match.
 *
 * `onChange` receives `{ personId }` for an existing person, or `{ newPerson }` with the
 * fields of the new-person form (the caller creates the row together with the record it
 * belongs to, e.g. `staff[i].person` of `saveProjectBundle`). With `persist` the picker
 * creates the row itself and answers `{ personId }`.
 *
 * What is typed before the choice (search text, the new-person form) is reported through
 * `onDraftChange` and restored from `draft` when the picker mounts again, so the caller can
 * keep it in its autosaved draft: Back, a reload or a phone call never lose it (brief §7.4).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { me } from '../auth';
import { findLocalPersonCandidates, type PersonCandidate, type Row } from '../db';
import { fmt, pickName, t } from '../i18n';
import { Button, Field, Select, toast, useDebounced, useLiveQuery } from '../ui';
import { combineCandidates, scriptOf, type Candidate } from './candidates';
import { datesText, NameBlock, PhoneText, primaryName, rolesText } from './display';
import { dialForIso, toPersonE164 } from './phone';
import {
  emptyFormState,
  formPhone,
  PersonForm,
  validatePersonForm,
  type PersonFormErrors,
  type PersonFormState,
} from './PersonForm';
import { createPerson, type PersonDraft } from './persons';
import { asPickerDraft, formHasInput, pickerDraftOf, type PersonPickerDraft } from './pickerDraft';
import {
  defaultDial,
  listCountries,
  loadPerson,
  serverDefaultsScope,
  writableBranches,
} from './queries';
import { isOnline, serverCandidates } from './rpc';
import { useCombobox } from './useCombobox';
import './people.css';

export type { PersonPickerDraft } from './pickerDraft';
export type PersonSelection = { personId: string } | { newPerson: PersonDraft };

export interface PersonPickerProps {
  value: string | null;
  onChange: (sel: PersonSelection) => void;
  /** Area of the record being edited: candidates living or working there rank higher. */
  adminAreaId?: string | null;
  /** Staff role being filled (`imam`, `teacher`, …): shown in the label, matching roles highlighted. */
  role?: Row<'project_staff'>['role'] | (string & {}) | null;
  testId?: string;
  // --- extensions (additive) -------------------------------------------------------------
  /** Offer "new person" (default true). */
  allowNew?: boolean;
  /** Create the new person row here and answer `{ personId }` (default false). */
  persist?: boolean;
  /** Scope of a person created with `persist`. Without it the user picks a branch when needed. */
  countryId?: string | null;
  branchId?: string | null;
  /** Persons that must not be offered (e.g. already on the staff list). */
  excludeIds?: readonly string[];
  label?: string;
  autoFocus?: boolean;
  /**
   * Reports whether the new-person form holds typed data, so a surrounding dialog can ask
   * before closing (brief §7.4: Esc or a click outside never discards what was typed).
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * What was typed before an interruption (from `onDraftChange`, stored with the caller's
   * autosaved draft). Read when the picker mounts; to restore another one, remount it with a
   * new `key`.
   */
  draft?: PersonPickerDraft | null;
  /**
   * Called whenever the typed search text or the new-person form changes; `null` once there
   * is nothing to keep (empty box, or the choice was handed over through `onChange`).
   */
  onDraftChange?: (draft: PersonPickerDraft | null) => void;
}

type Mode = 'search' | 'new' | 'chosen';
type ServerNote = 'offline' | 'error' | null;

const SEARCH_DEBOUNCE_MS = 250;
const MAX_PROJECTS_SHOWN = 2;

let instance = 0;

/** A typed text that is a phone number rather than a name (digits and separators only). */
function asPhone(text: string): boolean {
  let digits = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const digit =
      (c >= 0x30 && c <= 0x39) || (c >= 0x660 && c <= 0x669) || (c >= 0x6f0 && c <= 0x6f9);
    if (digit) digits++;
    else if (!' +-().'.includes(ch)) return false;
  }
  return digits >= 6;
}

export default function PersonPicker(props: PersonPickerProps) {
  const {
    value,
    onChange,
    adminAreaId = null,
    role = null,
    allowNew = true,
    persist = false,
    excludeIds,
    autoFocus,
    onDirtyChange,
    onDraftChange,
  } = props;
  const base = props.testId ?? 'person-picker';
  const ids = useMemo(() => `pp${++instance}`, []);
  const listId = `${ids}-list`;
  const hintId = `${ids}-hint`;
  const inputRef = useRef<HTMLInputElement>(null);
  // What was typed before an interruption: read once, when the picker mounts.
  const [restored] = useState(() => asPickerDraft(props.draft ?? null));

  const [mode, setMode] = useState<Mode>(restored?.mode ?? (value ? 'chosen' : 'search'));
  const [query, setQuery] = useState(restored?.query ?? '');
  const [dial, setDial] = useState<string | null>(null);
  const [form, setForm] = useState<PersonFormState>(() => restored?.form ?? emptyFormState(null));
  const [errors, setErrors] = useState<PersonFormErrors>({});
  const [pendingNew, setPendingNew] = useState<PersonDraft | null>(null);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [serverNote, setServerNote] = useState<ServerNote>(null);
  const [busy, setBusy] = useState(false);
  const [countryNames, setCountryNames] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Array<Row<'branches'>>>([]);
  const [branchId, setBranchId] = useState(restored?.branchId ?? '');
  const [branchError, setBranchError] = useState<string | null>(null);
  const request = useRef(0);

  const dirty = mode === 'new' && formHasInput(form);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty]);

  // Report what is typed so the caller can keep it with its own autosaved draft.
  const draftNow = pickerDraftOf({ mode, query, form, branchId });
  const draftJson = JSON.stringify(draftNow);
  const reported = useRef(JSON.stringify(restored));
  useEffect(() => {
    if (!onDraftChange || draftJson === reported.current) return;
    reported.current = draftJson;
    onDraftChange(draftNow);
  }, [draftJson]);

  // Calling code of the user's country (or of the record's country) and country names.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const countries = await listCountries();
      const fromProp = props.countryId
        ? countries.find((c) => c.id === props.countryId)
        : undefined;
      const d = dialForIso(fromProp?.iso2) ?? (await defaultDial(me.peek()));
      if (!alive) return;
      setCountryNames(Object.fromEntries(countries.map((c) => [c.iso2, pickName(c)])));
      setDial(d);
      setForm((f) => (f.dial || f.phone ? f : { ...f, dial: d ?? '' }));
    })();
    return () => {
      alive = false;
    };
  }, [props.countryId]);

  const needsScope =
    persist && !props.branchId && !props.countryId && !serverDefaultsScope(me.value);
  useEffect(() => {
    if (!needsScope) return;
    void writableBranches(me.peek()).then((rows) => {
      setBranches(rows);
      if (rows.length === 1) setBranchId((b) => b || rows[0]!.id);
    });
  }, [needsScope]);

  // The parent changed the value: a reset to null returns to the search box, a new id shows it.
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current === value) return;
    const was = previous.current;
    previous.current = value;
    if (!value && was) {
      setChosen(null);
      setPendingNew(null);
      setMode('search');
    } else if (value) {
      setPendingNew(null);
      setMode('chosen');
    }
  }, [value]);

  // --- what is searched -------------------------------------------------------------------
  const search = useMemo(() => {
    if (mode === 'new') {
      return {
        name: (form.name_ar.trim() || form.name_latin.trim()).slice(0, 120),
        phone: formPhone(form) ?? null,
      };
    }
    if (mode !== 'search') return { name: '', phone: null };
    const text = query.trim();
    if (asPhone(text)) return { name: '', phone: toPersonE164(text, dial) };
    return { name: text.slice(0, 120), phone: null };
  }, [mode, query, form.name_ar, form.name_latin, form.phone, form.dial, dial]);
  const key = useDebounced(
    `${search.name}\n${search.phone ?? ''}\n${adminAreaId ?? ''}`,
    SEARCH_DEBOUNCE_MS,
  );
  const exclude = excludeIds ? excludeIds.join(',') : '';

  useEffect(() => {
    const [name = '', phone = '', area = ''] = key.split('\n');
    const token = ++request.current;
    const skip = new Set(exclude ? exclude.split(',') : []);
    const keep = (list: Candidate[]): Candidate[] => list.filter((c) => !skip.has(c.id));
    if (name.length < 2 && !phone) {
      setCandidates([]);
      setLoading(false);
      setServerNote(null);
      return;
    }
    setLoading(true);
    void (async () => {
      let local: PersonCandidate[] = [];
      try {
        local = await findLocalPersonCandidates({
          name,
          phone: phone || undefined,
          adminAreaId: area || null,
        });
      } catch (error) {
        console.error('[people] local candidates', error);
      }
      if (token !== request.current) return;
      setCandidates(keep(combineCandidates(local, null)));
      if (!isOnline()) {
        setServerNote('offline');
        setLoading(false);
        return;
      }
      try {
        const server = await serverCandidates({
          name,
          phone: phone || null,
          adminAreaId: area || null,
        });
        if (token !== request.current) return;
        setCandidates(keep(combineCandidates(local, server)));
        setServerNote(null);
      } catch {
        if (token === request.current) setServerNote('error');
      } finally {
        if (token === request.current) setLoading(false);
      }
    })();
  }, [key, exclude]);

  // --- choices ----------------------------------------------------------------------------
  const typed = query.trim();
  const showNewOption = allowNew && mode === 'search' && typed.length > 0;
  const optionCount = candidates.length + (showNewOption ? 1 : 0);

  const chooseExisting = (c: Candidate): void => {
    setChosen(c);
    setPendingNew(null);
    setMode('chosen');
    cb.setOpen(false);
    onChange({ personId: c.id });
  };

  const openNewForm = (): void => {
    const seed: Partial<PersonFormState> = { dial: dial ?? '' };
    if (asPhone(typed)) seed.phone = typed;
    else if (scriptOf(typed) === 'latin') seed.name_latin = typed;
    else seed.name_ar = typed;
    setForm(emptyFormState(dial, seed));
    setErrors({});
    setMode('new');
    cb.setOpen(false);
  };

  const cb = useCombobox({
    baseId: ids,
    count: optionCount,
    onChoose: (index) => {
      const c = candidates[index];
      if (c) chooseExisting(c);
      else if (showNewOption) openNewForm();
    },
  });

  const submitNew = async (): Promise<void> => {
    const { draft, errors: found } = validatePersonForm(form);
    let scopeError: string | null = null;
    if (needsScope && !branchId) scopeError = t('people.branchRequired');
    setErrors(found);
    setBranchError(scopeError);
    if (!draft || scopeError) {
      const first = found.name_ar
        ? `${base}-new-name-ar`
        : found.phone
          ? `${base}-new-phone`
          : found.birth_year
            ? `${base}-new-birth-year`
            : `${base}-branch`;
      document.querySelector<HTMLElement>(`[data-testid="${first}"]`)?.focus();
      return;
    }
    if (!persist) {
      setPendingNew(draft);
      setChosen(null);
      setMode('chosen');
      onChange({ newPerson: draft });
      return;
    }
    setBusy(true);
    try {
      const branch = branches.find((b) => b.id === branchId);
      const id = await createPerson(draft, {
        branchId: props.branchId ?? (needsScope ? branchId : null),
        countryId: props.countryId ?? branch?.country_id ?? null,
      });
      setPendingNew(null);
      setChosen(null);
      setMode('chosen');
      toast(t('people.created'), 'success');
      onChange({ personId: id });
    } catch (error) {
      console.error('[people] create person', error);
      toast(t('people.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Back to the search box; the current choice stays until another one is made ("keep"). */
  const change = (): void => {
    setMode('search');
    queueMicrotask(() => inputRef.current?.focus());
  };

  // --- selected person --------------------------------------------------------------------
  const stored = useLiveQuery(() => (value ? loadPerson(value) : undefined), [value]);
  const label =
    props.label ??
    (role
      ? t('people.pickerLabelRole', { role: t(`enum.staff_role.${role}`) })
      : t('people.pickerLabel'));

  // Shown at once after a choice, even before the parent passes the new value back.
  if (mode === 'chosen' && (value || pendingNew || chosen)) {
    const person =
      pendingNew ?? (value ? (stored ?? (chosen?.id === value ? chosen : null)) : chosen);
    return (
      <div class="pp" data-testid={base}>
        <span class="field__label">{label}</span>
        <div class="pp-selected" data-testid={`${base}-selected`}>
          <div class="pp-selected__body">
            {person ? (
              <NameBlock person={person} />
            ) : (
              <span class="muted">{t('people.unknownPerson')}</span>
            )}
            {pendingNew ? (
              <span class="pp-selected__note">{t('people.willCreate')}</span>
            ) : (
              person &&
              ('phone_e164' in person ? (
                <PhoneText phone={person.phone_e164} />
              ) : (
                'phone' in person && <PhoneText phone={person.phone} masked={person.phone_masked} />
              ))
            )}
          </div>
          <Button size="sm" testId={`${base}-change`} onClick={change}>
            {t('people.change')}
          </Button>
        </div>
      </div>
    );
  }

  // --- new person form --------------------------------------------------------------------
  if (mode === 'new') {
    return (
      <div class="pp" data-testid={base}>
        <h3 class="pp-new__title">{t('people.newFormTitle')}</h3>
        {candidates.length > 0 && (
          <div class="pp-warn" role="status" data-testid={`${base}-new-matches`}>
            <p class="pp-warn__text">{t('people.possibleMatchWarn')}</p>
            <ul class="pp-cands pp-cands--plain">
              {candidates.map((c) => (
                <li key={c.id} class="pp-cands__item">
                  <CandidateBody candidate={c} role={role} />
                  <Button
                    size="sm"
                    variant="primary"
                    testId={`${base}-same`}
                    data-person-id={c.id}
                    aria-label={t('people.samePersonLabel', { name: primaryName(c) })}
                    onClick={() => chooseExisting(c)}
                  >
                    {t('people.samePerson')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <PersonForm
          idBase={`${base}-new`}
          state={form}
          errors={errors}
          countryNames={countryNames}
          onChange={setForm}
        />
        {needsScope && (
          <Field label={t('people.branch')} htmlFor={`${ids}-branch`} required error={branchError}>
            <Select
              testId={`${base}-branch`}
              value={branchId}
              placeholder={t('people.choose')}
              options={branches.map((b) => ({ value: b.id, label: pickName(b) || b.code }))}
              onChange={setBranchId}
            />
          </Field>
        )}
        <div class="pp-actions">
          <Button
            variant="primary"
            testId={`${base}-new-confirm`}
            busy={busy}
            onClick={() => void submitNew()}
          >
            {t('people.createConfirm')}
          </Button>
          <Button testId={`${base}-new-cancel`} onClick={change}>
            {t('people.backToSearch')}
          </Button>
        </div>
      </div>
    );
  }

  // --- search -----------------------------------------------------------------------------
  const expanded = cb.open && optionCount > 0;
  return (
    <div class="pp" data-testid={base}>
      <label class="field__label" for={`${ids}-input`}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={`${ids}-input`}
        class="control"
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck={false}
        aria-autocomplete="list"
        aria-expanded={expanded ? 'true' : 'false'}
        aria-controls={listId}
        aria-activedescendant={expanded ? cb.activeId : undefined}
        aria-describedby={hintId}
        data-testid={`${base}-input`}
        placeholder={t('people.pickerPlaceholder')}
        autoFocus={autoFocus}
        value={query}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          cb.setOpen(true);
        }}
        onFocus={() => cb.setOpen(true)}
        onKeyDown={cb.onKeyDown}
      />
      <p class="field__hint" id={hintId}>
        {t('people.pickerHint')}
      </p>
      <p class="sr-only" role="status" aria-live="polite">
        {loading
          ? t('people.searching')
          : search.name.length >= 2 || search.phone
            ? t('people.candidateCount', { count: candidates.length })
            : ''}
      </p>
      {(search.name.length >= 2 || search.phone) && (
        <p class="pp-section-title" aria-hidden="true">
          {candidates.length > 0
            ? t('people.candidatesTitle')
            : loading
              ? t('people.searching')
              : t('people.candidatesNone')}
        </p>
      )}
      <ul
        id={listId}
        class="pp-cands"
        role="listbox"
        aria-label={t('people.candidatesTitle')}
        hidden={!expanded}
        data-testid={`${base}-listbox`}
      >
        {candidates.map((c, i) => (
          <li
            key={c.id}
            id={cb.optionId(i)}
            role="option"
            aria-selected={cb.active === i ? 'true' : 'false'}
            class={cb.active === i ? 'pp-cands__item pp-cands__item--active' : 'pp-cands__item'}
            data-testid={`${base}-candidate`}
            data-person-id={c.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => chooseExisting(c)}
          >
            <CandidateBody candidate={c} role={role} />
            <span class="pp-cands__action" aria-hidden="true">
              {t('people.samePerson')}
            </span>
          </li>
        ))}
        {showNewOption && (
          <li
            id={cb.optionId(candidates.length)}
            role="option"
            aria-selected={cb.active === candidates.length ? 'true' : 'false'}
            class={
              cb.active === candidates.length
                ? 'pp-cands__item pp-cands__new pp-cands__item--active'
                : 'pp-cands__item pp-cands__new'
            }
            data-testid={`${base}-new`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={openNewForm}
          >
            <span class="pp-cands__plus" aria-hidden="true">
              +
            </span>
            <span>{t('people.newPersonOption', { name: typed })}</span>
          </li>
        )}
      </ul>
      {serverNote && (search.name.length >= 2 || search.phone) && (
        <p class="pp-note" data-testid={`${base}-server-note`}>
          {serverNote === 'offline' ? t('people.offlineLocalOnly') : t('people.serverUnavailable')}
        </p>
      )}
      {(value || chosen || pendingNew) && (
        <div class="pp-actions">
          <Button
            size="sm"
            variant="ghost"
            testId={`${base}-keep`}
            onClick={() => setMode('chosen')}
          >
            {t('people.keepCurrent')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** What a candidate row shows: names, (masked) phone, home area, roles, projects, reasons. */
export function CandidateBody({
  candidate: c,
  role,
}: {
  candidate: Candidate;
  role?: string | null;
}) {
  const projects = c.staff.slice(0, MAX_PROJECTS_SHOWN);
  const more = c.staff.length - projects.length + c.hidden_projects;
  return (
    <div class="pp-cand">
      <NameBlock person={c} />
      <div class="pp-cand__meta">
        <PhoneText phone={c.phone} masked={c.phone_masked} />
        <span class="pp-cand__area">
          {c.home_area ? pickName(c.home_area) || c.home_area.text || '' : t('people.noHomeArea')}
        </span>
        {c.roles.length > 0 && (
          <span
            class={
              role && (c.roles as readonly string[]).includes(role)
                ? 'pp-cand__roles pp-cand__roles--match'
                : 'pp-cand__roles'
            }
          >
            {rolesText(c.roles)}
          </span>
        )}
      </div>
      {projects.length > 0 && (
        <ul class="pp-cand__projects">
          {projects.map((s) => (
            <li key={s.project_staff_id}>
              {s.project_code && (
                <span class="ltr mono" dir="ltr">
                  {s.project_code}
                </span>
              )}{' '}
              <bdi>
                {pickName({ name_ar: s.project_name_ar, name_latin: s.project_name_latin })}
              </bdi>
              {' · '}
              {t(`enum.staff_role.${s.role}`)}
              <span class="muted"> · {datesText(s.start_date, s.end_date)}</span>
            </li>
          ))}
          {more > 0 && <li class="muted">{t('people.moreProjects', { count: more })}</li>}
        </ul>
      )}
      <div class="pp-cand__reasons">
        {c.reasons.map((r) => (
          <span
            key={r}
            class={`badge badge--${r === 'phone' ? 'warning' : r === 'name' ? 'info' : 'neutral'}`}
          >
            {r === 'name' && c.similarity !== null
              ? t('people.reasonName', { percent: fmt.percent(Math.round(c.similarity * 100)) })
              : t(`people.reason_${r}`)}
          </span>
        ))}
      </div>
    </div>
  );
}
