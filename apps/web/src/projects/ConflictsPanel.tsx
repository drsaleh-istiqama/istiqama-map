import { useState } from 'preact/hooks';
import type { Row } from '../db';
import { fmt, hasTranslation, pickName, t } from '../i18n';
import { isSyncError } from '../sync';
import { Button, EmptyState, Link, Spinner, toast, useLiveQuery } from '../ui';
import { enumLabel } from './labels';
import { tableLabel } from './FailedOpsPanel';
import type { Actor } from './permissions';
import {
  conflictReferences,
  listOpenConflicts,
  projectNames,
  referenceTableOf,
  type NamedRow,
  type ProjectName,
} from './queries';
import { resolveConflict, type ConflictChoice } from './review';
import { isOnline } from './search';

type Conflict = Row<'sync_conflicts'>;

/** Columns whose values are enumerations, with their dictionary key (`enum.<key>.<code>`). */
const ENUM_COLUMNS: Record<string, string> = {
  type: 'project_type',
  status: 'project_status',
  record_state: 'record_state',
  location_source: 'location_source',
  ownership: 'land_ownership',
  student_transport: 'student_transport',
  students_origin: 'students_origin',
  priority: 'maintenance_priority',
  state: 'maintenance_state',
  role: 'staff_role',
  guest_financial_capacity: 'guest_financial_capacity',
  gender: 'gender',
  currency: 'currency',
  category: 'photo_category',
};

/**
 * Same column name, other meaning in one table: codes that are not a dictionary enumeration
 * get texts of this module (`projects.<prefix>_<code>`).
 */
const TABLE_CODE_COLUMNS: Record<string, string> = {
  'localities.status': 'localityStatus',
  'person_merge_requests.state': 'mergeState',
  'project_photos.upload_state': 'uploadState',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Translated column name, the raw name when there is no text for it (an unknown new column). */
export function columnLabel(field: string): string {
  const key = `projects.col_${field}`;
  return hasTranslation(key) ? t(key) : field;
}

export interface ConflictValueContext {
  /** Table of the conflicting row (`sync_conflicts.table_name`). */
  table?: string;
  /** Rows the values point to, by id (`conflictReferences`). */
  refs?: ReadonlyMap<string, NamedRow>;
}

/** Name of a referenced row; a translated notice when the row is not on this device. */
function referenceName(id: unknown, refs: ReadonlyMap<string, NamedRow> | undefined): string {
  if (typeof id !== 'string' || id === '') return t('projects.emptyValue');
  const row = refs?.get(id);
  const name = row ? pickName(row) : '';
  return name || t('projects.refNotOnDevice');
}

/**
 * A conflict value in words, in the interface language: enumerations through `enum.*`,
 * option lists and references (people, donors, areas, villages) by name, dates and numbers
 * through `Intl`, a location as "lat, lon".
 */
export function formatConflictValue(
  field: string,
  value: unknown,
  ctx: ConflictValueContext = {},
): string {
  if (value === null || value === undefined || value === '') return t('projects.emptyValue');
  if (Array.isArray(value) && value.length === 0) return t('projects.emptyValue');
  if (typeof value === 'boolean') return enumLabel('boolean', String(value));
  if (field === 'geom' && typeof value === 'object' && !Array.isArray(value)) {
    const p = value as { lon?: unknown; lat?: unknown };
    if (typeof p.lat === 'number' && typeof p.lon === 'number')
      return `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
  }
  if (referenceTableOf(field)) {
    const ids = Array.isArray(value) ? value : [value];
    return ids.map((id) => referenceName(id, ctx.refs)).join(t('projects.listSep'));
  }
  const own = ctx.table ? TABLE_CODE_COLUMNS[`${ctx.table}.${field}`] : undefined;
  if (own && typeof value === 'string') {
    const key = `projects.${own}_${value}`;
    return hasTranslation(key) ? t(key) : value;
  }
  const dict = ENUM_COLUMNS[field];
  if (dict && typeof value === 'string') return enumLabel(dict, value);
  if (typeof value === 'number') return fmt.number(value);
  if (typeof value === 'string' && ISO_DATE.test(value)) return fmt.date(value) || value;
  if (typeof value === 'string' && ISO_TIMESTAMP.test(value)) return fmt.dateTime(value) || value;
  if (Array.isArray(value)) {
    return value.map((v) => formatConflictValue(field, v, ctx)).join(t('projects.listSep'));
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ConflictRow({
  conflict,
  project,
  refs,
  actor,
  online,
  onResolved,
}: {
  conflict: Conflict;
  project?: ProjectName;
  refs: ReadonlyMap<string, NamedRow>;
  actor: Actor;
  online: boolean;
  onResolved: (id: string) => void;
}) {
  const ctx: ConflictValueContext = { table: conflict.table_name, refs };
  const [busy, setBusy] = useState<ConflictChoice | null>(null);
  const isLatin =
    conflict.field === 'geom' || /^-?[\d.,\s]+$/.test(String(conflict.server_value ?? ''));
  const resolve = async (choice: ConflictChoice): Promise<void> => {
    setBusy(choice);
    try {
      await resolveConflict(conflict, choice);
      toast(t('projects.conflictResolved'), 'success');
      onResolved(conflict.id);
    } catch (error) {
      const message = isSyncError(error) || error instanceof Error ? error.message : '';
      if (message.includes('conflict_already_resolved')) {
        toast(t('projects.conflictAlreadyResolved'), 'info');
        onResolved(conflict.id);
      } else if (message.includes('row_deleted') || message.includes('row_missing')) {
        toast(t('projects.conflictRowDeleted'), 'error');
      } else {
        toast(t('projects.actionFailed'), 'error');
      }
    } finally {
      setBusy(null);
    }
  };
  const who =
    conflict.client_user_id && conflict.client_user_id === actor.userId
      ? t('projects.you')
      : t('projects.otherUser');
  return (
    <li class="prow" data-testid="conflict-row" data-id={conflict.id} data-field={conflict.field}>
      <div class="prow__head">
        <span class="badge badge--warning">{tableLabel(conflict.table_name)}</span>
        <span class="prow__title">{columnLabel(conflict.field)}</span>
      </div>
      {project && (
        <Link href={`/projects/${project.id}`} class="prow__meta">
          <bdi>{pickName(project) || project.code}</bdi>
        </Link>
      )}
      <div class="pvalues">
        <div class="pvalue" data-testid="conflict-server-value">
          <span class="pvalue__label">{t('projects.conflictServerValue')}</span>
          <bdi class={isLatin ? 'pvalue__text ltr' : 'pvalue__text'}>
            {formatConflictValue(conflict.field, conflict.server_value, ctx)}
          </bdi>
        </div>
        <div class="pvalue" data-testid="conflict-client-value">
          <span class="pvalue__label">{t('projects.conflictClientValue')}</span>
          <bdi class={isLatin ? 'pvalue__text ltr' : 'pvalue__text'}>
            {formatConflictValue(conflict.field, conflict.client_value, ctx)}
          </bdi>
        </div>
      </div>
      <p class="prow__meta">
        {t('projects.conflictBy', { who, when: fmt.dateTime(conflict.created_at) })}
        {conflict.client_device_id && (
          <>
            {' · '}
            <span class="ltr" dir="ltr">
              {conflict.client_device_id.slice(0, 8)}
            </span>
          </>
        )}
      </p>
      <div class="prow__actions">
        <Button
          size="sm"
          variant="secondary"
          testId="conflict-keep-server"
          busy={busy === 'server'}
          disabled={!online || busy !== null}
          onClick={() => void resolve('server')}
        >
          {t('projects.conflictKeepServer')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          testId="conflict-keep-client"
          busy={busy === 'client'}
          disabled={!online || busy !== null}
          onClick={() => void resolve('client')}
        >
          {t('projects.conflictKeepClient')}
        </Button>
      </div>
    </li>
  );
}

/** (b) Field conflicts waiting for a reviewer (sync.md §6). Online only. */
export function ConflictsPanel({ actor }: { actor: Actor }) {
  const data = useLiveQuery(async () => {
    const conflicts = await listOpenConflicts(actor.seeRestricted);
    const [names, refs] = await Promise.all([
      projectNames(conflicts.map((c) => c.project_id)),
      conflictReferences(conflicts),
    ]);
    return { conflicts, names, refs };
  }, [actor.seeRestricted]);
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const online = isOnline();

  if (!data) return <Spinner block />;
  const open = data.conflicts.filter((c) => !resolved.has(c.id));
  return (
    <div data-testid="review-conflicts">
      {!online && <p class="pdetails__notice">{t('projects.conflictsOffline')}</p>}
      {open.length === 0 ? (
        <EmptyState testId="conflicts-empty" title={t('projects.conflictsEmpty')} />
      ) : (
        <>
          <p class="pnote">{t('projects.conflictsIntro')}</p>
          <ul class="prows">
            {open.map((c) => (
              <ConflictRow
                key={c.id}
                conflict={c}
                project={c.project_id ? data.names.get(c.project_id) : undefined}
                refs={data.refs}
                actor={actor}
                online={online}
                onResolved={(id) => setResolved((s) => new Set([...s, id]))}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
