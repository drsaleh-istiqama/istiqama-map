import { useEffect, useState } from 'preact/hooks';
import { db, type Row } from '../db';
import { fmt, pickName, t } from '../i18n';
import {
  Button,
  confirm,
  EmptyState,
  Field,
  Modal,
  Spinner,
  toast,
  useDebounced,
  useLiveQuery,
} from '../ui';
import { findLocalities, listProposedLocalities, projectsOfLocality } from './queries';
import { approveLocality, mergeLocality, renameLocality } from './review';

type Locality = Row<'localities'>;

interface LocalityView {
  locality: Locality;
  areaName: string;
  countryName: string;
  projects: number;
}

async function loadViews(): Promise<LocalityView[]> {
  const rows = await listProposedLocalities();
  const areaIds = [...new Set(rows.map((l) => l.admin_area_id).filter((x): x is string => !!x))];
  const countryIds = [...new Set(rows.map((l) => l.country_id))];
  const [areas, countries, counts] = await Promise.all([
    areaIds.length ? db.admin_areas.bulkGet(areaIds) : Promise.resolve([]),
    countryIds.length ? db.countries.bulkGet(countryIds) : Promise.resolve([]),
    Promise.all(rows.map((l) => projectsOfLocality(l.id).then((ids) => ids.length))),
  ]);
  return rows.map((locality, i) => ({
    locality,
    areaName: pickName(areas.find((a) => a?.id === locality.admin_area_id)),
    countryName: pickName(countries.find((c) => c?.id === locality.country_id)),
    projects: counts[i] ?? 0,
  }));
}

function EditForm({ locality, onDone }: { locality: Locality; onDone: () => void }) {
  const [nameAr, setNameAr] = useState(locality.name_ar ?? '');
  const [nameLatin, setNameLatin] = useState(locality.name_latin ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (!nameAr.trim() && !nameLatin.trim()) {
      setError(t('projects.localityNameRequired'));
      return;
    }
    setBusy(true);
    try {
      await renameLocality(locality.id, {
        name_ar: nameAr.trim() || null,
        name_latin: nameLatin.trim() || null,
      });
      toast(t('projects.localitySaved'), 'success');
      onDone();
    } catch {
      toast(t('projects.actionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const idBase = `loc-${locality.id}`;
  return (
    <form class="pform" data-testid="locality-edit-form" noValidate onSubmit={(e) => void save(e)}>
      <div class="pform__row">
        <Field label={t('projects.localityNameAr')} htmlFor={`${idBase}-ar`} error={error}>
          <input
            class="control"
            dir="rtl"
            data-testid="locality-name-ar"
            value={nameAr}
            onInput={(e) => setNameAr(e.currentTarget.value)}
          />
        </Field>
        <Field label={t('projects.localityNameLatin')} htmlFor={`${idBase}-latin`}>
          <input
            class="control"
            dir="ltr"
            data-testid="locality-name-latin"
            value={nameLatin}
            onInput={(e) => setNameLatin(e.currentTarget.value)}
          />
        </Field>
      </div>
      <div class="prow__actions">
        <Button type="submit" variant="primary" size="sm" busy={busy} testId="locality-save">
          {t('common.save')}
        </Button>
        <Button size="sm" testId="locality-edit-cancel" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Choose an approved locality of the same country to merge the proposed one into. */
function MergeDialog({ source, onClose }: { source: Locality; onClose: () => void }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 250);
  const [hits, setHits] = useState<Locality[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    findLocalities(source.country_id, debounced)
      .then((rows) => {
        if (alive) setHits(rows.filter((l) => l.id !== source.id));
      })
      .catch(() => {
        if (alive) setHits([]);
      });
    return () => {
      alive = false;
    };
  }, [debounced, source.id]);

  const merge = async (target: Locality): Promise<void> => {
    const ok = await confirm({
      title: t('projects.mergeConfirmTitle'),
      message: t('projects.mergeConfirmBody', {
        source: pickName(source),
        target: pickName(target),
      }),
      confirmLabel: t('projects.mergeConfirm'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const moved = await mergeLocality(source.id, target.id);
      toast(t('projects.merged', { count: fmt.number(moved) }), 'success');
      onClose();
    } catch {
      toast(t('projects.actionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={t('projects.mergeTitle', { name: pickName(source) })}
      onClose={onClose}
      testId="merge-dialog"
    >
      <Field
        label={t('projects.mergeSearch')}
        htmlFor="merge-search"
        hint={t('projects.mergeHint')}
      >
        <input
          type="search"
          class="control"
          data-testid="merge-search"
          data-autofocus
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
      </Field>
      {busy ? (
        <Spinner block />
      ) : hits === null ? null : hits.length === 0 ? (
        <p class="psection__empty">
          {debounced.trim().length < 2 ? t('projects.mergeTypeMore') : t('projects.mergeNoHits')}
        </p>
      ) : (
        <ul class="prows" style={{ marginBlockStart: 'var(--sp-3)' }}>
          {hits.map((l) => (
            <li key={l.id} class="prow">
              <div class="prow__head">
                <bdi class="prow__title">{pickName(l)}</bdi>
                {l.name_latin && l.name_ar && (
                  <span class="prow__meta ltr" dir="ltr">
                    {l.name_latin}
                  </span>
                )}
              </div>
              <div class="prow__actions">
                <Button
                  size="sm"
                  variant="primary"
                  testId="merge-target"
                  onClick={() => void merge(l)}
                >
                  {t('projects.mergeInto')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function LocalityRow({ view }: { view: LocalityView }) {
  const { locality } = view;
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [busy, setBusy] = useState(false);
  const approve = async (): Promise<void> => {
    setBusy(true);
    try {
      await approveLocality(locality.id);
      toast(t('projects.localityApproved'), 'success');
    } catch {
      toast(t('projects.actionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class="prow" data-testid="locality-row" data-id={locality.id}>
      <div class="prow__head">
        <bdi class="prow__title">{pickName(locality) || t('projects.draftUntitled')}</bdi>
        {locality.name_latin && locality.name_ar && (
          <span class="prow__meta ltr" dir="ltr">
            {locality.name_latin}
          </span>
        )}
      </div>
      <div class="prow__meta">
        {[
          view.areaName,
          view.countryName,
          t('projects.localityProjects', { count: fmt.number(view.projects) }),
          fmt.relative(locality.created_at),
        ]
          .filter((s) => s !== '')
          .join(' · ')}
      </div>
      {editing ? (
        <EditForm locality={locality} onDone={() => setEditing(false)} />
      ) : (
        <div class="prow__actions">
          <Button
            size="sm"
            variant="gold"
            testId="locality-approve"
            busy={busy}
            onClick={() => void approve()}
          >
            {t('projects.approve')}
          </Button>
          <Button size="sm" testId="locality-edit" onClick={() => setEditing(true)}>
            {t('common.edit')}
          </Button>
          <Button size="sm" testId="locality-merge" onClick={() => setMerging(true)}>
            {t('projects.mergeAction')}
          </Button>
        </div>
      )}
      {merging && <MergeDialog source={locality} onClose={() => setMerging(false)} />}
    </li>
  );
}

/** (c) Villages entered by hand in the form (`proposed`), waiting for a reviewer. */
export function LocalitiesPanel() {
  const views = useLiveQuery(() => loadViews(), []);
  if (!views) return <Spinner block />;
  return (
    <div data-testid="review-localities">
      {views.length === 0 ? (
        <EmptyState testId="localities-empty" title={t('projects.localitiesEmpty')} />
      ) : (
        <>
          <p class="pnote">{t('projects.localitiesIntro')}</p>
          <ul class="prows">
            {views.map((v) => (
              <LocalityRow key={v.locality.id} view={v} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
