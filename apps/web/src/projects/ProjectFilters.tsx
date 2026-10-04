import { useEffect, useState } from 'preact/hooks';
import {
  PROJECT_STATUSES,
  PROJECT_TYPES,
  RECORD_STATES,
  type ProjectFilter,
  type Row,
} from '../db';
import { pickName, t } from '../i18n';
import { Button, Select, type SelectOption } from '../ui';
import { recordStateLabel, statusLabel, typeLabel } from './labels';
import { listAreas, listBranches, listCountries } from './queries';

/** Filters of a list view as stored per view (`useViewFilters`): the db filter + area levels. */
export interface ListFilters extends ProjectFilter {
  /** Level-1 area chosen in the first area select. */
  area1?: string;
  /** Area chosen in the second select (child of `area1`). */
  area2?: string;
}

const FILTER_KEYS = [
  'countryId',
  'branchId',
  'type',
  'status',
  'recordState',
  'incomplete',
  'mine',
  'openMaintenance',
] as const;

/** The database filter of a view's stored filters (the text query is passed separately). */
export function toProjectFilter(f: ListFilters, q?: string): ProjectFilter {
  const out: ProjectFilter = {};
  for (const key of FILTER_KEYS) {
    const v = f[key];
    if (v !== undefined && v !== null && v !== '' && v !== false)
      (out as Record<string, unknown>)[key] = v;
  }
  const area = f.area2 || f.area1;
  if (area) out.adminAreaId = area;
  const text = (q ?? f.q ?? '').trim();
  if (text) out.q = text;
  if (f.sort) out.sort = f.sort;
  return out;
}

/** Number of active filters other than the text query. */
export function activeFilterCount(f: ListFilters): number {
  let n = 0;
  for (const key of FILTER_KEYS) if (f[key]) n++;
  if (f.area1 || f.area2) n++;
  return n;
}

const byName = (a: SelectOption, b: SelectOption): number => a.label.localeCompare(b.label);

function useOptions<T>(load: () => Promise<T[]>, deps: unknown[]): T[] {
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => {
    let alive = true;
    load()
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, deps);
  return rows;
}

export interface ProjectFiltersProps {
  filters: ListFilters;
  onChange: (patch: Partial<ListFilters>) => void;
  /** Show the "mine" switch (users who enter data). */
  showMine: boolean;
  /** Which groups to offer (the maintenance view hides the record-state filters). */
  fields?: {
    recordState?: boolean;
    incomplete?: boolean;
    openMaintenance?: boolean;
    status?: boolean;
  };
  /** `quick` = type + status (always visible), `more` = the rest (collapsible panel). */
  group?: 'all' | 'quick' | 'more';
  idPrefix: string;
}

/** Country → branch → area (two levels) → type / status / record state, plus switches. */
export function ProjectFilters({
  filters,
  onChange,
  showMine,
  fields = {},
  group = 'all',
  idPrefix,
}: ProjectFiltersProps) {
  const show = {
    recordState: true,
    incomplete: true,
    openMaintenance: true,
    status: true,
    ...fields,
  };
  const quick = group !== 'more';
  const more = group !== 'quick';
  const countries = useOptions<Row<'countries'>>(
    () => (more ? listCountries() : Promise.resolve([])),
    [more],
  );
  const countryId = filters.countryId || (countries.length === 1 ? countries[0]!.id : undefined);
  const branches = useOptions<Row<'branches'>>(
    () => (more ? listBranches(countryId) : Promise.resolve([])),
    [countryId, more],
  );
  const areas1 = useOptions<Row<'admin_areas'>>(
    () => (more && countryId ? listAreas(countryId) : Promise.resolve([])),
    [countryId, more],
  );
  const areas2 = useOptions<Row<'admin_areas'>>(
    () => (countryId && filters.area1 ? listAreas(countryId, filters.area1) : Promise.resolve([])),
    [countryId, filters.area1],
  );

  const opts = (rows: Array<{ id: string } & Parameters<typeof pickName>[0]>): SelectOption[] =>
    rows.map((r) => ({ value: r.id, label: pickName(r) || r.id })).sort(byName);

  const id = (name: string): string => `${idPrefix}-${name}`;
  const label = (forId: string, text: string) => (
    <label class="pfilters__label" for={forId}>
      {text}
    </label>
  );

  return (
    <div class={quick && !more ? 'pfilters__grid pfilters__grid--quick' : 'pfilters__grid'}>
      {more && countries.length > 1 && (
        <div class="pfilters__item">
          {label(id('country'), t('projects.filterCountry'))}
          <Select
            id={id('country')}
            testId="filter-country"
            options={opts(countries)}
            value={filters.countryId ?? ''}
            placeholder={t('projects.allCountries')}
            onChange={(v) =>
              onChange({
                countryId: v || undefined,
                branchId: undefined,
                area1: undefined,
                area2: undefined,
              })
            }
          />
        </div>
      )}
      {more && branches.length > 0 && (
        <div class="pfilters__item">
          {label(id('branch'), t('projects.filterBranch'))}
          <Select
            id={id('branch')}
            testId="filter-branch"
            options={opts(branches)}
            value={filters.branchId ?? ''}
            placeholder={t('projects.allBranches')}
            onChange={(v) => onChange({ branchId: v || undefined })}
          />
        </div>
      )}
      {more && areas1.length > 0 && (
        <div class="pfilters__item">
          {label(id('area'), t('projects.filterArea'))}
          <Select
            id={id('area')}
            testId="filter-area"
            options={opts(areas1)}
            value={filters.area1 ?? ''}
            placeholder={t('projects.allAreas')}
            onChange={(v) => onChange({ area1: v || undefined, area2: undefined })}
          />
        </div>
      )}
      {more && areas2.length > 0 && (
        <div class="pfilters__item">
          {label(id('area2'), t('projects.filterSubArea'))}
          <Select
            id={id('area2')}
            testId="filter-area2"
            options={opts(areas2)}
            value={filters.area2 ?? ''}
            placeholder={t('projects.allSubAreas')}
            onChange={(v) => onChange({ area2: v || undefined })}
          />
        </div>
      )}
      {quick && (
        <div class="pfilters__item">
          {label(id('type'), t('projects.filterType'))}
          <Select
            id={id('type')}
            testId="filter-type"
            options={PROJECT_TYPES.map((c) => ({ value: c, label: typeLabel(c) }))}
            value={filters.type ?? ''}
            placeholder={t('projects.allTypes')}
            onChange={(v) => onChange({ type: v || undefined })}
          />
        </div>
      )}
      {quick && show.status && (
        <div class="pfilters__item">
          {label(id('status'), t('projects.filterStatus'))}
          <Select
            id={id('status')}
            testId="filter-status"
            options={PROJECT_STATUSES.map((c) => ({ value: c, label: statusLabel(c) }))}
            value={filters.status ?? ''}
            placeholder={t('projects.allStatuses')}
            onChange={(v) => onChange({ status: v || undefined })}
          />
        </div>
      )}
      {more && show.recordState && (
        <div class="pfilters__item">
          {label(id('record'), t('projects.filterRecordState'))}
          <Select
            id={id('record')}
            testId="filter-record-state"
            options={RECORD_STATES.map((c) => ({ value: c, label: recordStateLabel(c) }))}
            value={filters.recordState ?? ''}
            placeholder={t('projects.allRecordStates')}
            onChange={(v) => onChange({ recordState: v || undefined })}
          />
        </div>
      )}
      {more && (
        <div class="pfilters__switches" role="group" aria-label={t('projects.filterMore')}>
          {show.incomplete && (
            <Toggle
              testId="filter-incomplete"
              checked={!!filters.incomplete}
              label={t('projects.filterIncomplete')}
              onChange={(v) => onChange({ incomplete: v || undefined })}
            />
          )}
          {showMine && (
            <Toggle
              testId="filter-mine"
              checked={!!filters.mine}
              label={t('projects.filterMine')}
              onChange={(v) => onChange({ mine: v || undefined })}
            />
          )}
          {show.openMaintenance && (
            <Toggle
              testId="filter-open-maintenance"
              checked={!!filters.openMaintenance}
              label={t('projects.filterOpenMaintenance')}
              onChange={(v) => onChange({ openMaintenance: v || undefined })}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** A pressed / not pressed chip (one tab stop, 44 px target). */
function Toggle({
  checked,
  label,
  onChange,
  testId,
}: {
  checked: boolean;
  label: string;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      class={checked ? 'chip chip--on' : 'chip'}
      aria-pressed={checked ? 'true' : 'false'}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    >
      {label}
    </button>
  );
}

export function ResetFiltersButton({
  disabled,
  onReset,
}: {
  disabled: boolean;
  onReset: () => void;
}) {
  return (
    <Button size="sm" variant="ghost" testId="filter-reset" disabled={disabled} onClick={onReset}>
      {t('projects.resetFilters')}
    </Button>
  );
}
