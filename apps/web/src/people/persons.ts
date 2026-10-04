/**
 * Writes of the people module. Every write is a `mutate()` (offline first: local row +
 * outbox operation). Persons are NEVER merged here — merging is a reviewer action on the
 * server (rpc.ts), and "same person" in the picker only links to an existing id.
 */
import { mutate, type Row } from '../db';
import { uuidv7 } from '../lib/uuidv7';

type Person = Row<'persons'>;

/** Fields of the new-person form (brief §2.4). `name_ar` is required. */
export interface PersonDraft {
  name_ar: string;
  name_latin?: string;
  phone_e164?: string;
  gender?: NonNullable<Person['gender']>;
  birth_year?: number;
  home_admin_area_id?: string;
  education_level?: string;
  graduated_from?: string;
}

export const EDITABLE_FIELDS = [
  'name_ar',
  'name_latin',
  'phone_e164',
  'gender',
  'birth_year',
  'home_admin_area_id',
  'education_level',
  'graduated_from',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Trimmed text or undefined. */
function text(v: string | null | undefined): string | undefined {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s === '' ? undefined : s;
}

/** The draft without empty values (what `onChange({ newPerson })` hands to the caller). */
export function cleanDraft(draft: PersonDraft): PersonDraft {
  const out: PersonDraft = { name_ar: text(draft.name_ar) ?? '' };
  const latin = text(draft.name_latin);
  if (latin) out.name_latin = latin;
  if (draft.phone_e164) out.phone_e164 = draft.phone_e164;
  if (draft.gender) out.gender = draft.gender;
  if (typeof draft.birth_year === 'number' && Number.isFinite(draft.birth_year))
    out.birth_year = draft.birth_year;
  if (draft.home_admin_area_id) out.home_admin_area_id = draft.home_admin_area_id;
  const education = text(draft.education_level);
  if (education) out.education_level = education;
  const graduated = text(draft.graduated_from);
  if (graduated) out.graduated_from = graduated;
  return out;
}

/**
 * Creates a person row on the device (synced later). `scope` sets `country_id` /
 * `branch_id`; leave it empty when the server can default it (user with a single branch).
 */
export async function createPerson(
  draft: PersonDraft,
  scope: { countryId?: string | null; branchId?: string | null } = {},
): Promise<string> {
  const clean = cleanDraft(draft);
  if (!clean.name_ar) throw new Error('name_ar_required');
  const id = uuidv7();
  const row: Partial<Person> = { ...clean };
  if (scope.countryId) row.country_id = scope.countryId;
  if (scope.branchId) row.branch_id = scope.branchId;
  await mutate('persons', id, row, { insert: true });
  return id;
}

/** Saves the fields that differ from `before` (empty text clears the column). */
export async function updatePerson(before: Person, next: PersonDraft): Promise<EditableField[]> {
  const clean = cleanDraft(next);
  const patch: Partial<Person> = {};
  const changed: EditableField[] = [];
  for (const field of EDITABLE_FIELDS) {
    const value = (clean as Partial<Record<EditableField, unknown>>)[field] ?? null;
    const old = (before as unknown as Record<string, unknown>)[field] ?? null;
    if (value !== old) {
      (patch as Record<string, unknown>)[field] = value;
      changed.push(field);
    }
  }
  if (changed.length > 0) await mutate('persons', before.id, patch);
  return changed;
}
