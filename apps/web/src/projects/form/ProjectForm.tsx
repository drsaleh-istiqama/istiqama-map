/**
 * The project form (brief §7): type → name → location → country / area / locality (filled
 * from the point) → status → photos, then folded optional sections. Autosaved to IndexedDB,
 * validated next to each field, geo-checked and duplicate-checked before ONE
 * `saveProjectBundle()`. Works fully offline.
 */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fmt, t } from '../../i18n';
import { getNumberSetting, type DuplicateHit, type ProjectBundle, type Row } from '../../db';
import { transport } from '../../sync';
import { Button, Spinner, confirm, focusableElements, toast } from '../../ui';
import { RecordStateBadge } from '../labels';
import { isMine, type FormAccess } from './access';
import { FormContext, type FormApi, type FormCtx, type FormEnv, type ListKey } from './context';
import { Collapsible } from './controls';
import type * as OptionalSections from './optional';
import { createAutosave, discardStoredDraft, draftWorthKeeping, type Autosave } from './drafts';
import { findDuplicates } from './duplicates';
import { checkPoint, isOnline, locatePoint, type LocateResult } from './geo';
import { ensureShapes, type Rpc } from './geoCache';
import { changedFields, hasChanges } from './merge';
import {
  defaultCurrency,
  isLive,
  sectionFilled,
  sectionRow,
  type FormDraft,
  type SectionKey,
} from './model';
import { Completeness, CompletenessMeter, DuplicateDialog } from './panels';
import { queuePhotoUploads } from './peers';
import { getBranch, getCountry, listCountries } from './queries';
import { FormSaveError, saveChoices, saveDraft } from './save';
import { NameSection, TypeSection } from './sections/basics';
import { LocationSection } from './sections/location';
import { PhotosSection } from './sections/photos';
import { PlaceSection } from './sections/place';
import { StatusSection } from './sections/status';
import {
  fieldId,
  orderedErrorKeys,
  validateForm,
  type FieldErrors,
  type SaveIntent,
} from './validate';
import './form.css';

type OptionalModule = typeof OptionalSections;

interface OptionalDef {
  key: 'basics' | 'donors' | 'staff' | 'land' | 'facilities' | 'community' | 'sensitive';
  title: string;
  restricted?: boolean;
  render: (m: OptionalModule) => JSX.Element;
}

const OPTIONAL: OptionalDef[] = [
  { key: 'basics', title: 'form.secBasics', render: (m) => <m.BasicsSection /> },
  { key: 'donors', title: 'form.secDonors', render: (m) => <m.DonorsSection /> },
  { key: 'staff', title: 'form.secStaff', render: (m) => <m.StaffSection /> },
  { key: 'land', title: 'form.secLand', render: (m) => <m.LandSection /> },
  { key: 'facilities', title: 'form.secFacilities', render: (m) => <m.FacilitiesSection /> },
  { key: 'community', title: 'form.secCommunity', render: (m) => <m.CommunitySection /> },
  {
    key: 'sensitive',
    title: 'form.secSensitive',
    restricted: true,
    render: (m) => <m.SensitiveSection />,
  },
];

/** Optional section that holds the field of an error key. */
export function sectionOfKey(key: string): OptionalDef['key'] | null {
  const head = key.split('.')[0]!;
  if (['capacity', 'builder', 'build_year', 'build_date'].includes(head)) return 'basics';
  if (['donors', 'staff', 'land', 'facilities', 'community', 'sensitive'].includes(head))
    return head as OptionalDef['key'];
  return null;
}

let optionalChunk: Promise<OptionalModule> | null = null;
export function loadOptional(): Promise<OptionalModule> {
  optionalChunk ??= import('./optional');
  return optionalChunk;
}

const rpc: Rpc = (fn, args) => transport.rpc(fn, args);

function pointOf(p: Row<'projects'>): { lon: number; lat: number } | null {
  return typeof p.lon === 'number' &&
    typeof p.lat === 'number' &&
    Number.isFinite(p.lon) &&
    Number.isFinite(p.lat) &&
    p.lon >= -180 &&
    p.lon <= 180 &&
    p.lat >= -90 &&
    p.lat <= 90
    ? { lon: p.lon, lat: p.lat }
    : null;
}

/** Focus the control of `key` (or the first focusable element inside it). */
function focusField(key: string): void {
  const el = document.getElementById(fieldId(key));
  if (!el) return;
  const target = el.matches('input, select, textarea, button, [tabindex]')
    ? el
    : (focusableElements(el)[0] ?? el);
  target.focus();
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
}

/** Bundle as it will be scored once saved: untouched new sections do not count. */
export function previewBundle(d: FormDraft): ProjectBundle {
  const w = d.working;
  const keep = <K extends SectionKey>(key: K): ProjectBundle[K] | undefined => {
    const row = w[key];
    if (!row) return undefined;
    if (d.original?.[key]) return row;
    return Object.keys(changedFields(null, row)).length > 0 ? row : undefined;
  };
  const out: ProjectBundle = {
    project: w.project,
    maintenance: w.maintenance.filter(isLive),
    photos: w.photos.filter(isLive),
    donors: w.donors.filter(isLive),
    // A staff row counts once a person is chosen (an empty row cannot be saved anyway).
    staff: w.staff.filter((x) => isLive(x) && !!x.person_id),
  };
  const land = keep('land');
  const facilities = keep('facilities');
  const community = keep('community');
  if (land) out.land = land;
  if (facilities) out.facilities = facilities;
  if (community) out.community = community;
  return out;
}

export interface ProjectFormProps {
  initial: FormDraft;
  access: FormAccess;
  /** Problems of operations the server rejected (edit of a record that "needs attention"). */
  serverProblems?: { fields: FieldErrors; general: string[] };
  onSaved: (projectId: string) => void;
  onLeave: () => void;
  onOpenProject: (hit: DuplicateHit) => void;
  /** Test hook: overrides the save dependencies. */
  saveImpl?: typeof saveDraft;
}

export function ProjectForm({
  initial,
  access,
  serverProblems,
  onSaved,
  onLeave,
  onOpenProject,
  saveImpl = saveDraft,
}: ProjectFormProps) {
  const [draft, setDraft] = useState<FormDraft>(initial);
  const draftRef = useRef(draft);
  const [errors, setErrors] = useState<FieldErrors>(serverProblems?.fields ?? {});
  const [countries, setCountries] = useState<Row<'countries'>[]>([]);
  const [country, setCountry] = useState<Row<'countries'> | undefined>(undefined);
  const [accuracyWarnM, setAccuracyWarnM] = useState(30);
  const [located, setLocated] = useState<(LocateResult & { lon: number; lat: number }) | null>(
    null,
  );
  const [locating, setLocating] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [optional, setOptional] = useState<OptionalModule | null>(null);
  const [saving, setSaving] = useState(false);
  const [dups, setDups] = useState<{ hits: DuplicateHit[]; intent: SaveIntent } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [photosBusy, setPhotosBusy] = useState(false);
  const photosBusyRef = useRef(false);
  const autosave = useRef<Autosave | null>(null);
  const finished = useRef(false);
  const preferCountries = useRef<string[]>([]);

  // --- state updates ----------------------------------------------------------------------
  const commit = (fn: (d: FormDraft) => FormDraft): void => {
    const next = fn(draftRef.current);
    if (next === draftRef.current) return;
    draftRef.current = next;
    setDraft(next);
    autosave.current?.changed();
  };

  const api: FormApi = useMemo(
    () => ({
      update: commit,
      setProject: (patch) =>
        commit((d) => ({
          ...d,
          working: { ...d.working, project: { ...d.working.project, ...patch } },
        })),
      setSection: (key, patch) =>
        commit((d) => ({
          ...d,
          working: { ...d.working, [key]: { ...sectionRow(d.working, key), ...patch } },
        })),
      setExtras: (patch) => commit((d) => ({ ...d, extras: { ...d.extras, ...patch } })),
      addRow: (key, row) =>
        commit((d) => ({
          ...d,
          working: { ...d.working, [key]: [...(d.working[key] as unknown[]), row] },
        })),
      patchRow: (key, id, patch) =>
        commit((d) => ({
          ...d,
          working: {
            ...d.working,
            [key]: (d.working[key] as Array<{ id: string }>).map((r) =>
              r.id === id ? { ...r, ...patch } : r,
            ),
          },
        })),
      removeRow: (key: ListKey, id: string) =>
        commit((d) => {
          const rows = d.working[key] as Array<{
            id: string;
            person?: { id: string };
            donor?: { id: string };
          }>;
          const row = rows.find((r) => r.id === id);
          // What was typed in the person picker of a removed staff row goes with it.
          const { [id]: _typed, ...pickerDrafts } = d.extras.pickerDrafts ?? {};
          return {
            ...d,
            working: { ...d.working, [key]: rows.filter((r) => r.id !== id) },
            extras: {
              ...d.extras,
              newPersonIds: d.extras.newPersonIds.filter((p) => p !== row?.person?.id),
              newDonorIds: d.extras.newDonorIds.filter((p) => p !== row?.donor?.id),
              ...(d.extras.pickerDrafts ? { pickerDrafts } : {}),
            },
          };
        }),
      setPhotos: (photos) =>
        commit((d) => ({
          ...d,
          working: { ...d.working, photos },
          extras: {
            ...d.extras,
            seenPhotoIds: [...new Set([...d.extras.seenPhotoIds, ...photos.map((p) => p.id)])],
          },
        })),
      setPhotosBusy: (busy) => {
        photosBusyRef.current = busy;
        setPhotosBusy(busy);
      },
      clearError: (key) =>
        setErrors((e) => {
          if (!(key in e)) return e;
          const next = { ...e };
          delete next[key];
          return next;
        }),
    }),
    [],
  );

  // --- autosave ---------------------------------------------------------------------------
  // Created synchronously so that the very first keystroke is already tracked.
  if (!autosave.current && !finished.current) {
    autosave.current = createAutosave({
      read: () => draftRef.current,
      intervalMs: 5000,
      onSaved: (at) => setSavedAt(at),
      onError: (error) => console.error('[form] autosave failed', error),
    });
  }
  useEffect(() => {
    void getNumberSetting('form.autosave_seconds', 5, 1, 60).then(
      (s) => autosave.current?.setIntervalMs(s * 1000),
      () => undefined,
    );
    return () => {
      const a = autosave.current;
      autosave.current = null;
      void a?.stop({ flush: !finished.current });
    };
  }, []);

  // --- reference data ---------------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    void listCountries().then((c) => alive && setCountries(c));
    void getNumberSetting('gps.accuracy_warn_m', 30, 1, 1000).then(
      (n) => alive && setAccuracyWarnM(n),
    );
    void (async () => {
      const fromBranches = await Promise.all(access.branches.map((b) => getBranch(b)));
      const ids = [
        ...access.countries,
        ...fromBranches.map((b) => b?.country_id).filter((c): c is string => !!c),
        ...(draftRef.current.working.project.country_id
          ? [draftRef.current.working.project.country_id]
          : []),
      ];
      preferCountries.current = [...new Set(ids)];
      if (isOnline()) await ensureShapes(preferCountries.current, rpc, { online: true });
    })();
    // Prefetch the optional sections once the first screen is idle.
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    const timer = idle
      ? null
      : setTimeout(() => void loadOptional().then((m) => alive && setOptional(() => m)), 2000);
    if (idle) idle(() => void loadOptional().then((m) => alive && setOptional(() => m)));
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const countryId = draft.working.project.country_id;
  useEffect(() => {
    let alive = true;
    void getCountry(countryId).then((c) => alive && setCountry(c));
    return () => {
      alive = false;
    };
  }, [countryId]);

  // --- geofill ----------------------------------------------------------------------------
  const point = pointOf(draft.working.project);
  useEffect(() => {
    if (!point) {
      setLocated(null);
      setLocating(false);
      return;
    }
    if (located && located.lon === point.lon && located.lat === point.lat) return;
    let alive = true;
    const timer = setTimeout(() => {
      setLocating(true);
      void locatePoint(point, { rpc, online: isOnline(), preferCountries: preferCountries.current })
        .then((res) => {
          if (alive) setLocated({ ...res, lon: point.lon, lat: point.lat });
        })
        .finally(() => alive && setLocating(false));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [point?.lon, point?.lat]);

  // Apply the result unless the user corrected the area by hand.
  useEffect(() => {
    if (!located || !point || located.lon !== point.lon || located.lat !== point.lat) return;
    const d = draftRef.current;
    const gf = d.extras.geofillFor;
    if (gf && gf.lon === point.lon && gf.lat === point.lat) return;
    if (d.extras.manualArea || located.source === 'none') return;
    commit((cur) => {
      const countryId = located.countryId ?? cur.working.project.country_id;
      // A locality belongs to one country: drop the choice when the point moved to another.
      const otherCountry = countryId !== cur.working.project.country_id;
      return {
        ...cur,
        working: {
          ...cur.working,
          project: {
            ...cur.working.project,
            country_id: countryId,
            admin_area_id: located.adminAreaId,
            ...(otherCountry ? { locality_id: null } : {}),
          },
        },
        extras: {
          ...cur.extras,
          areaPath: located.areaPath,
          geofillFor: { lon: point.lon, lat: point.lat },
          ...(otherCountry ? { newLocality: null } : {}),
        },
      };
    });
    setErrors((e) => {
      const next = { ...e };
      delete next.country;
      delete next.area;
      return next;
    });
  }, [located, draft.extras.geofillFor, draft.extras.manualArea]);

  // --- Esc never discards: it asks, and the draft stays -------------------------------
  const requestLeave = async (): Promise<void> => {
    if (photosBusyRef.current) {
      toast(t('form.photosBusy'), 'info');
      return;
    }
    const d = draftRef.current;
    if (draftWorthKeeping(d)) {
      await autosave.current?.flush();
      const ok = await confirm({
        title: t('form.leaveTitle'),
        message: t('form.leaveBody'),
        confirmLabel: t('form.leave'),
        danger: false,
      });
      if (!ok) return;
    }
    onLeave();
  };
  const leaveRef = useRef(requestLeave);
  leaveRef.current = requestLeave;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.documentElement.classList.contains('has-modal')) return;
      e.preventDefault();
      void leaveRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // --- save -------------------------------------------------------------------------------
  const showErrors = async (found: FieldErrors): Promise<void> => {
    setErrors(found);
    const keys = orderedErrorKeys(found);
    const sections = keys.map(sectionOfKey).filter((s): s is OptionalDef['key'] => !!s);
    if (sections.length > 0) {
      setOpen((o) => new Set([...o, ...sections]));
      const m = await loadOptional();
      setOptional(() => m);
    }
    toast(t('form.fixErrors', { count: keys.length }), 'error');
    const first = keys[0];
    if (first) requestAnimationFrame(() => requestAnimationFrame(() => focusField(first)));
  };

  const doSave = async (intent: SaveIntent): Promise<void> => {
    setSaving(true);
    try {
      await autosave.current?.flush();
      const d = draftRef.current;
      const bundle = await saveImpl(d, intent, { isReviewer: access.review });
      finished.current = true;
      // Staged photos: their rows exist now, hand them to the upload queue.
      await queuePhotoUploads(bundle.photos).catch((error: unknown) =>
        console.warn('[form] could not queue photo uploads', error),
      );
      await autosave.current?.stop({ flush: false });
      await autosave.current?.discard();
      toast(t('form.saved'), 'success');
      onSaved(d.projectId);
    } catch (error) {
      console.error('[form] save failed', error);
      toast(
        error instanceof FormSaveError && error.code === 'gone'
          ? t('form.saveGone')
          : t('form.saveFailed'),
        'error',
      );
    } finally {
      setSaving(false);
    }
  };

  const save = async (intent: SaveIntent): Promise<void> => {
    if (saving) return;
    if (photosBusyRef.current) {
      toast(t('form.photosBusy'), 'info');
      return;
    }
    const d = draftRef.current;
    const found = validateForm(d.working, {
      intent,
      extras: d.extras,
      restrictedWrite: access.restrictedWrite,
    });
    if (Object.keys(found).length > 0) {
      await showErrors(found);
      return;
    }
    setErrors({});
    setSaving(true);
    let hits: DuplicateHit[] = [];
    try {
      const p = d.working.project;
      const pt = pointOf(p);
      // Geo-validation (brief §7.2): warn before saving, the user may override.
      if (pt && p.country_id) {
        const res = located && located.lon === pt.lon && located.lat === pt.lat ? located : null;
        const check = await checkPoint(
          pt,
          { countryId: p.country_id, areaPath: d.extras.areaPath },
          res,
        );
        if (check.country === 'outside' || check.area === 'outside') {
          setSaving(false);
          const ok = await confirm({
            title: t('form.geoConfirmTitle'),
            message:
              check.country === 'outside' ? t('form.geoOutsideCountry') : t('form.geoOutsideArea'),
            confirmLabel: t('form.geoConfirmSave'),
            danger: false,
          });
          if (!ok) {
            focusField('location');
            return;
          }
          setSaving(true);
        }
      }
      // Duplicates (brief §7.3): new records, or edits of type / place / name.
      const o = d.original?.project;
      const relevant =
        !o ||
        o.type !== p.type ||
        o.lon !== p.lon ||
        o.lat !== p.lat ||
        o.name_ar !== p.name_ar ||
        o.locality_id !== p.locality_id;
      if (relevant) {
        const nl = d.extras.newLocality;
        hits = await findDuplicates(
          {
            type: p.type as string,
            lon: pt?.lon ?? null,
            lat: pt?.lat ?? null,
            name: p.name_ar ?? '',
            localityId: nl && p.locality_id === nl.id ? null : p.locality_id,
            excludeId: d.projectId,
          },
          { rpc, online: isOnline() },
        );
      }
    } finally {
      setSaving(false);
    }
    if (hits.length > 0) {
      setDups({ hits, intent });
      return;
    }
    await doSave(intent);
  };

  const discard = async (): Promise<void> => {
    const d = draftRef.current;
    const ok = await confirm({
      title: d.mode === 'new' ? t('form.discardNewTitle') : t('form.discardEditTitle'),
      message: d.mode === 'new' ? t('form.discardNewBody') : t('form.discardEditBody'),
      confirmLabel: t('form.discard'),
      danger: true,
    });
    if (!ok) return;
    finished.current = true;
    await autosave.current?.stop({ flush: false });
    await discardStoredDraft(d);
    onLeave();
  };

  // --- render -----------------------------------------------------------------------------
  const env: FormEnv = {
    access,
    countries,
    country,
    currency: defaultCurrency(country),
    accuracyWarnM,
    located,
    locating,
  };
  const ctx: FormCtx = { draft, api, errors, env };
  const filled = sectionFilled(draft.working);
  const preview = previewBundle(draft);
  const stored = draft.original?.project;
  const choices = saveChoices(stored?.record_state ?? null, access.review);
  const dirty = draftWorthKeeping(draft);
  const changed = draft.mode === 'edit' ? hasChanges(draft.original, draft.working) : dirty;

  const toggle = (key: string, isOpen: boolean): void => {
    setOpen((o) => {
      const next = new Set(o);
      if (isOpen) next.add(key);
      else next.delete(key);
      return next;
    });
    if (isOpen && !optional) void loadOptional().then((m) => setOptional(() => m));
  };

  const primaryLabel =
    stored?.record_state === 'returned'
      ? t('form.resubmit')
      : stored?.record_state === 'submitted' ||
          (stored?.record_state === 'approved' && access.review)
        ? t('form.saveChanges')
        : stored?.record_state === 'approved'
          ? t('form.saveAndReview')
          : t('form.submit');

  return (
    <FormContext.Provider value={ctx}>
      <form
        class="pf"
        data-testid="project-form"
        data-mode={draft.mode}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save('submit');
        }}
      >
        <header class="pf-head">
          {stored && (
            <p class="pf-head__state">
              {stored.code && <span class="ltr mono">{stored.code}</span>}
              <RecordStateBadge state={stored.record_state} testId="form-record-state" />
            </p>
          )}
          <p class="muted pf-head__by" data-testid="form-entered-by">
            {draft.mode === 'new' || (stored && isMine(stored, access))
              ? t('form.enteredBy', { name: access.fullName || t('common.unnamedUser') })
              : t('form.enteredByOther')}
          </p>
          {choices.returnsToReview && (
            <p class="pf-note pf-note--warn" data-testid="form-returns-to-review">
              {t('form.returnsToReview')}
            </p>
          )}
          {stored?.record_state === 'submitted' && (
            <p class="pf-note pf-note--info">{t('form.inReview')}</p>
          )}
          {stored?.record_state === 'returned' && stored.review_note && (
            <p class="pf-note pf-note--warn" data-testid="form-review-note">
              {t('form.reviewNote', { note: stored.review_note })}
            </p>
          )}
          {serverProblems &&
            serverProblems.general.length + Object.keys(serverProblems.fields).length > 0 && (
              <div class="pf-note pf-note--error" role="alert" data-testid="form-server-errors">
                <p>{t('form.serverRejected')}</p>
                {serverProblems.general.length > 0 && (
                  <ul>
                    {serverProblems.general.map((m) => (
                      <li key={m}>{t(m)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
        </header>

        <div class="pf-core">
          <TypeSection />
          <NameSection />
          <LocationSection />
          <PlaceSection />
          <StatusSection />
          <PhotosSection />
        </div>

        <h2 class="pf-optional-title">{t('form.optionalTitle')}</h2>
        <div class="pf-optional">
          {OPTIONAL.filter((s) => !s.restricted || access.restrictedWrite).map((s) => (
            <Collapsible
              key={s.key}
              id={s.key}
              title={t(s.title)}
              open={open.has(s.key)}
              onToggle={(v) => toggle(s.key, v)}
              filled={filled[s.key]}
              restricted={s.restricted}
            >
              {optional ? s.render(optional) : <Spinner size={20} />}
            </Collapsible>
          ))}
        </div>

        <section class="pf-summary" aria-label={t('form.completenessLabel')}>
          <Completeness bundle={preview} />
          <p class="muted pf-autosave" role="status" data-testid="form-autosave">
            {savedAt && dirty ? t('form.autosaved', { time: fmt.dateTime(new Date(savedAt)) }) : ''}
          </p>
          <div class="pf-summary__buttons">
            <Button testId="form-cancel" onClick={() => void requestLeave()}>
              {t('ui.cancel')}
            </Button>
            {changed && (
              <Button variant="ghost" testId="form-discard" onClick={() => void discard()}>
                {draft.mode === 'new' ? t('form.discardNew') : t('form.discardEdit')}
              </Button>
            )}
          </div>
        </section>

        {/* Sticky on phones: only the save actions and a one-line progress meter. */}
        <footer class="pf-actions">
          <CompletenessMeter bundle={preview} />
          <div class="pf-actions__buttons">
            {choices.draft && (
              <Button
                testId="form-save-draft"
                busy={saving}
                disabled={photosBusy}
                onClick={() => void save('draft')}
              >
                {stored?.record_state === 'returned'
                  ? t('form.saveKeepReturned')
                  : t('form.saveDraft')}
              </Button>
            )}
            <Button
              type="submit"
              variant="gold"
              testId="form-save"
              busy={saving}
              disabled={photosBusy}
            >
              {primaryLabel}
            </Button>
          </div>
        </footer>
      </form>

      {dups && (
        <DuplicateDialog
          hits={dups.hits}
          onCancel={() => setDups(null)}
          onDifferent={() => {
            const intent = dups.intent;
            setDups(null);
            void doSave(intent);
          }}
          onOpen={(hit) => {
            setDups(null);
            void autosave.current?.flush().then(() => {
              toast(t('form.keptAsDraft'), 'info');
              onOpenProject(hit);
            });
          }}
        />
      )}
    </FormContext.Provider>
  );
}
