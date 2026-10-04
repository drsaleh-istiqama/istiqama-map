/**
 * Form state container shared by the sections (one context instead of prop drilling).
 */
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ProjectBundle, Row } from '../../db';
import type { FormAccess } from './access';
import type { LocateResult } from './geo';
import type { FormDraft, FormExtras, SectionKey } from './model';
import type { FieldErrors } from './validate';

export type ListKey = 'maintenance' | 'donors' | 'staff';
export type ListRow<K extends ListKey> = ProjectBundle[K][number];

export interface FormApi {
  /** Replace the whole draft (functional update). */
  update(fn: (draft: FormDraft) => FormDraft): void;
  setProject(patch: Partial<Row<'projects'>>): void;
  /** Patch a 1:1 section; the row is created on the first edit. */
  setSection<K extends SectionKey>(key: K, patch: Partial<NonNullable<ProjectBundle[K]>>): void;
  setExtras(patch: Partial<FormExtras>): void;
  addRow<K extends ListKey>(key: K, row: ListRow<K>): void;
  patchRow<K extends ListKey>(key: K, id: string, patch: Partial<ListRow<K>>): void;
  removeRow(key: ListKey, id: string): void;
  setPhotos(photos: Row<'project_photos'>[]): void;
  /** The photo editor is compressing / has a picker open / waits for a review. */
  setPhotosBusy(busy: boolean): void;
  /** Clear the error of one field (the user is fixing it). */
  clearError(key: string): void;
}

export interface FormEnv {
  access: FormAccess;
  countries: Row<'countries'>[];
  /** Country of the project (selected), for currencies. */
  country: Row<'countries'> | undefined;
  currency: string;
  accuracyWarnM: number;
  /** Latest geofill result for the current point. */
  located: LocateResult | null;
  locating: boolean;
}

export interface FormCtx {
  draft: FormDraft;
  api: FormApi;
  errors: FieldErrors;
  env: FormEnv;
}

export const FormContext = createContext<FormCtx | null>(null);

export function useForm(): FormCtx {
  const ctx = useContext(FormContext);
  if (!ctx) throw new Error('useForm() outside <FormContext.Provider>');
  return ctx;
}
