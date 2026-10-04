/**
 * What the person picker holds before its choice is handed over: the text typed in the
 * search box, or the open "new person" form. Brief §7.4: a phone call, the Back button or a
 * reload must not lose it — the caller stores this draft with its own autosaved record and
 * passes it back when the picker mounts again (`<PersonPicker draft onDraftChange>`).
 *
 * The add-person dialog of the people page keeps its draft in the device's `drafts` store
 * (`people:add-person`, one per device, tied to the signed-in user).
 */
import { drafts, getLocalSession } from '../db';
import { emptyFormState, type PersonFormState } from './PersonForm';

export interface PersonPickerDraft {
  /** `search`: text in the search box; `new`: the "new person" form is open. */
  mode: 'search' | 'new';
  /** Text of the search box. */
  query: string;
  /** Fields of the new-person form (`mode: 'new'`). */
  form?: PersonFormState;
  /** Branch chosen for a person the picker creates itself (`persist`). */
  branchId?: string;
}

const TEXT_FIELDS = [
  'name_ar',
  'name_latin',
  'dial',
  'phone',
  'birth_year',
  'education_level',
  'graduated_from',
] as const;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A stored draft read back (an older or damaged value gives null, never a crash). */
export function asPickerDraft(value: unknown): PersonPickerDraft | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.mode !== 'search' && v.mode !== 'new') return null;
  const out: PersonPickerDraft = { mode: v.mode, query: str(v.query) };
  if (v.mode === 'new') {
    const f = (v.form && typeof v.form === 'object' ? v.form : {}) as Record<string, unknown>;
    const form = emptyFormState(null);
    for (const key of TEXT_FIELDS) form[key] = str(f[key]);
    form.gender = f.gender === 'male' || f.gender === 'female' ? f.gender : '';
    form.home_admin_area_id =
      typeof f.home_admin_area_id === 'string' && f.home_admin_area_id
        ? f.home_admin_area_id
        : null;
    out.form = form;
  }
  if (typeof v.branchId === 'string' && v.branchId) out.branchId = v.branchId;
  return out;
}

/** True when the new-person form holds anything the user typed (the calling code aside). */
export function formHasInput(form: PersonFormState): boolean {
  return (
    [
      form.name_ar,
      form.name_latin,
      form.phone,
      form.gender,
      form.birth_year,
      form.education_level,
      form.graduated_from,
    ].some((v) => v.trim() !== '') || form.home_admin_area_id !== null
  );
}

/** The draft of the picker's current state; null when nothing is worth keeping. */
export function pickerDraftOf(state: {
  mode: 'search' | 'new' | 'chosen';
  query: string;
  form: PersonFormState;
  branchId: string;
}): PersonPickerDraft | null {
  if (state.mode === 'chosen') return null;
  if (state.mode === 'search') {
    return state.query.trim() ? { mode: 'search', query: state.query } : null;
  }
  if (!formHasInput(state.form) && !state.query.trim()) return null;
  return {
    mode: 'new',
    query: state.query,
    form: { ...state.form },
    ...(state.branchId ? { branchId: state.branchId } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// The people page's add-person dialog
// ---------------------------------------------------------------------------------------

export const ADD_PERSON_DRAFT_KEY = 'people:add-person';

interface StoredAddDraft {
  v: 1;
  userId: string | null;
  draft: PersonPickerDraft;
}

/**
 * The unfinished "add person" entry of the signed-in user on this device, if any. Waits for
 * the writes already requested, so a dialog reopened right after a discard starts empty.
 */
export async function readAddPersonDraft(): Promise<PersonPickerDraft | null> {
  await writing;
  try {
    const stored = (await drafts.get(ADD_PERSON_DRAFT_KEY)) as StoredAddDraft | undefined;
    if (!stored || stored.v !== 1) return null;
    const { userId } = await getLocalSession();
    if ((stored.userId ?? null) !== (userId ?? null)) return null;
    return asPickerDraft(stored.draft);
  } catch (error) {
    console.warn('[people] could not read the add-person draft', error);
    return null;
  }
}

/** The chain of add-person draft writes (each write catches its own errors). */
let writing: Promise<void> = Promise.resolve();

/** Stores (or, with null, forgets) the add-person draft; writes are applied in call order. */
export function writeAddPersonDraft(draft: PersonPickerDraft | null): Promise<void> {
  const write = async (): Promise<void> => {
    try {
      if (!draft) {
        await drafts.remove(ADD_PERSON_DRAFT_KEY);
        return;
      }
      const { userId } = await getLocalSession();
      const value: StoredAddDraft = { v: 1, userId, draft };
      await drafts.put(ADD_PERSON_DRAFT_KEY, value);
    } catch (error) {
      console.warn('[people] could not store the add-person draft', error);
    }
  };
  writing = writing.then(write, write);
  return writing;
}
