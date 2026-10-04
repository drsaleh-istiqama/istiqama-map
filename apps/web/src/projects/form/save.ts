/**
 * Final save (brief §7, item 9): the draft becomes ONE `saveProjectBundle()` call, preceded —
 * in the same local transaction — by the insert of a typed `proposed` locality (brief §2.1),
 * so that the outbox holds the locality before the project that points to it.
 */
import {
  db,
  loadProjectBundle,
  mutate,
  saveProjectBundle,
  type ProjectBundle,
  type RecordState,
} from '../../db';
import { buildBundle } from './merge';
import type { FormDraft } from './model';
import { getLocality } from './queries';
import type { SaveIntent } from './validate';

export class FormSaveError extends Error {
  constructor(
    readonly code: 'gone' | 'write_failed',
    readonly reason?: unknown,
  ) {
    super(code);
    this.name = 'FormSaveError';
  }
}

/**
 * The `record_state` to store (sync.md §4.3):
 *   new / draft: "save draft" keeps `draft`, "submit" sends `submitted`;
 *   returned:    "save" keeps `returned`, "submit" sends `submitted`;
 *   submitted:   stays `submitted`;
 *   approved:    a reviewer keeps `approved`; anybody else's edit returns it to review.
 */
export function targetRecordState(
  current: RecordState | null | undefined,
  intent: SaveIntent,
  isReviewer: boolean,
): RecordState {
  switch (current) {
    case 'approved':
      return isReviewer ? 'approved' : 'submitted';
    case 'submitted':
      return 'submitted';
    case 'returned':
      return intent === 'submit' ? 'submitted' : 'returned';
    default:
      return intent === 'submit' ? 'submitted' : 'draft';
  }
}

/** What the save buttons offer for a record in `current` state. */
export function saveChoices(
  current: RecordState | null | undefined,
  isReviewer: boolean,
): { draft: boolean; submit: boolean; returnsToReview: boolean } {
  switch (current) {
    case 'approved':
      return { draft: false, submit: true, returnsToReview: !isReviewer };
    case 'submitted':
      return { draft: false, submit: true, returnsToReview: false };
    default:
      return { draft: true, submit: true, returnsToReview: false };
  }
}

export interface SaveDeps {
  load: (id: string) => Promise<ProjectBundle | undefined>;
  save: (bundle: ProjectBundle) => Promise<void>;
  mutate: typeof mutate;
  getLocality: typeof getLocality;
  transaction: (fn: () => Promise<void>) => Promise<void>;
}

const defaultDeps: SaveDeps = {
  load: loadProjectBundle,
  save: saveProjectBundle,
  mutate,
  getLocality,
  transaction: (fn) => db.transaction('rw', db.tables, fn),
};

/** Saves the draft; returns the bundle handed to `saveProjectBundle()`. */
export async function saveDraft(
  draft: FormDraft,
  intent: SaveIntent,
  opts: { isReviewer: boolean; deps?: Partial<SaveDeps> },
): Promise<ProjectBundle> {
  const deps: SaveDeps = { ...defaultDeps, ...opts.deps };
  const current = await deps.load(draft.projectId);
  if (draft.mode === 'edit' && !current) throw new FormSaveError('gone');

  const baseState = (current ?? draft.original)?.project.record_state ?? null;
  const recordState = targetRecordState(baseState, intent, opts.isReviewer);
  const working: ProjectBundle = {
    ...draft.working,
    project: { ...draft.working.project, record_state: recordState },
  };
  const bundle = buildBundle({
    original: draft.original,
    working,
    current,
    newDonorIds: draft.extras.newDonorIds,
    newPersonIds: draft.extras.newPersonIds,
    seenPhotoIds: draft.extras.seenPhotoIds,
  });
  // Always state the target explicitly when it differs from what is stored.
  if (current && current.project.record_state !== recordState) {
    bundle.project = { ...bundle.project, record_state: recordState };
  }

  const nl = draft.extras.newLocality;
  const p = bundle.project;
  try {
    await deps.transaction(async () => {
      if (nl && p.locality_id === nl.id && !(await deps.getLocality(nl.id))) {
        await deps.mutate(
          'localities',
          nl.id,
          {
            country_id: p.country_id ?? undefined,
            admin_area_id: p.admin_area_id,
            name_ar: nl.name_ar.trim() || null,
            name_latin: nl.name_latin.trim() || null,
            status: 'proposed',
            lon: p.lon,
            lat: p.lat,
          },
          { insert: true },
        );
      }
      await deps.save(bundle);
    });
  } catch (error) {
    throw new FormSaveError('write_failed', error);
  }
  return bundle;
}
