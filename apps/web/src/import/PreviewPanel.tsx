/**
 * Step 3 — review a staged batch page by page (`import_preview`, keyset by row number):
 * translated errors per cell, warnings, duplicates with the matched project, and the action
 * of every row (skip / create / update → `import_set_action`). Then the commit
 * (`import_commit`, all-or-nothing): a row the server refuses at commit time is shown with its
 * error and nothing is written.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmt, t } from '../i18n';
import { typeLabel } from '../projects/labels';
import { Badge, Button, Link, Spinner, confirm, toast, type BadgeTone } from '../ui';
import { PREVIEW_PAGE, importApi } from './api';
import { fieldLabel, importErrorText, issueText, rowStateLabel } from './labels';
import type {
  CommitResult,
  DuplicateCandidate,
  ImportIssue,
  ImportSummary,
  PreviewFilter,
  PreviewPage,
  PreviewRow,
  RowAction,
  TemplateColumn,
} from './types';
import { isRecord } from './types';

const FILTERS: Array<{
  value: PreviewFilter | null;
  key: string;
  count?: keyof ImportSummary['counts'];
}> = [
  { value: null, key: 'import.filterAll', count: 'total' },
  { value: 'invalid', key: 'import.filterInvalid', count: 'invalid' },
  { value: 'duplicate', key: 'import.filterDuplicate', count: 'duplicate' },
  { value: 'warnings', key: 'import.filterWarnings', count: 'with_warnings' },
  { value: 'create', key: 'import.filterCreate', count: 'create' },
  { value: 'update', key: 'import.filterUpdate', count: 'update' },
  { value: 'skip', key: 'import.filterSkip', count: 'skip' },
];

export function stateTone(state: string): BadgeTone {
  switch (state) {
    case 'valid':
    case 'applied':
      return 'success';
    case 'invalid':
    case 'failed':
      return 'danger';
    case 'duplicate':
      return 'warning';
    case 'skipped':
    case 'reverted':
      return 'inactive';
    default:
      return 'neutral';
  }
}

/** Name shown for a row: the parsed Arabic / Latin name, else the first text cell of the file. */
export function rowName(row: PreviewRow): string | null {
  const project = row.parsed && isRecord(row.parsed.project) ? row.parsed.project : null;
  const name = project?.name_ar ?? project?.name_latin;
  if (typeof name === 'string' && name.trim() !== '') return name;
  return null;
}

function rowType(row: PreviewRow): string | null {
  const project = row.parsed && isRecord(row.parsed.project) ? row.parsed.project : null;
  return typeof project?.type === 'string' ? project.type : null;
}

/** Actions a row may take now (invalid rows: none). */
export function actionsFor(row: PreviewRow): RowAction[] {
  if (row.state === 'invalid' || row.action === null) return [];
  const out: RowAction[] = ['skip', 'create'];
  if (row.targetId || row.duplicateOf) out.push('update');
  return out;
}

export interface PreviewPanelProps {
  summary: ImportSummary;
  columns: readonly TemplateColumn[];
  online: boolean;
  onCommitted: (result: CommitResult) => void;
  onClose: () => void;
}

export function PreviewPanel({
  summary,
  columns,
  online,
  onCommitted,
  onClose,
}: PreviewPanelProps) {
  const batchId = summary.batchId;
  const [filter, setFilter] = useState<PreviewFilter | null>(null);
  // Keyset cursors: cursors[i] = `p_after` of page i.
  const [cursors, setCursors] = useState<number[]>([0]);
  const [page, setPage] = useState<PreviewPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const [committing, setCommitting] = useState(false);
  const [refused, setRefused] = useState<CommitResult | null>(null);
  const request = useRef(0);
  const listTop = useRef<HTMLHeadingElement>(null);

  const after = cursors[cursors.length - 1] ?? 0;
  const counts = page?.counts ?? summary.counts;
  const validated = (page?.state ?? summary.state) === 'validated';

  const load = async (cursor: number, only: PreviewFilter | null): Promise<void> => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await importApi().preview(batchId, cursor, PREVIEW_PAGE, only);
      if (id === request.current) setPage(result);
    } catch (e) {
      if (id === request.current) setError(importErrorText(e));
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (online) void load(after, filter);
  }, [batchId, after, filter, online]);

  const changeFilter = (value: PreviewFilter | null): void => {
    setFilter(value);
    setCursors([0]);
  };

  const nextPage = (): void => {
    if (page?.next !== null && page?.next !== undefined) {
      setCursors([...cursors, page.next]);
      listTop.current?.focus();
    }
  };
  const prevPage = (): void => {
    if (cursors.length > 1) {
      setCursors(cursors.slice(0, -1));
      listTop.current?.focus();
    }
  };

  /** `target`: the candidate the user picked ("merge into this one"); else the row's own. */
  const setAction = async (row: PreviewRow, action: RowAction, target?: string): Promise<void> => {
    setBusyRow(row.rowNo);
    try {
      await importApi().setAction(
        batchId,
        row.rowNo,
        action,
        action === 'update' ? (target ?? row.targetId ?? row.duplicateOf) : null,
      );
      await load(after, filter);
    } catch (e) {
      toast(importErrorText(e), 'error');
    } finally {
      setBusyRow(null);
    }
  };

  const commit = async (): Promise<void> => {
    const ok = await confirm({
      title: t('import.commitConfirmTitle'),
      message: t('import.commitConfirmMessage', {
        create: fmt.number(counts.create),
        update: fmt.number(counts.update),
        skip: fmt.number(counts.skip + counts.invalid),
      }),
      confirmLabel: t('import.commit'),
    });
    if (!ok) return;
    setCommitting(true);
    setRefused(null);
    try {
      const result = await importApi().commit(batchId);
      if (result.committed) {
        onCommitted(result);
        return;
      }
      setRefused(result);
      // Show the refused row first.
      setFilter(null);
      setCursors([Math.max(0, (result.failedRow ?? 1) - 1)]);
    } catch (e) {
      toast(importErrorText(e), 'error');
    } finally {
      setCommitting(false);
    }
  };

  const total = counts.total;
  const firstNo = page?.rows[0]?.rowNo;
  const lastNo = page?.rows[page.rows.length - 1]?.rowNo;
  const importable = counts.create + counts.update;

  return (
    <section
      class="card imp-step"
      aria-labelledby="imp-preview-title"
      data-testid="import-preview"
      data-batch={batchId}
    >
      <h2 id="imp-preview-title">
        <span class="imp-step__no" aria-hidden="true">
          3
        </span>
        {t('import.previewTitle')}
      </h2>
      <p class="muted">
        {summary.fileName ? <bdi>{summary.fileName}</bdi> : null}
        {summary.fileName ? ' · ' : ''}
        {t('import.rowsTotal', { count: fmt.number(summary.rowCount) })}
      </p>

      <dl class="imp-counts" data-testid="import-counts">
        <div class="imp-counts__item">
          <dt>{t('import.countValid')}</dt>
          <dd data-testid="import-count-valid">{fmt.number(counts.valid)}</dd>
        </div>
        <div class="imp-counts__item imp-counts__item--danger">
          <dt>{t('import.countInvalid')}</dt>
          <dd data-testid="import-count-invalid">{fmt.number(counts.invalid)}</dd>
        </div>
        <div class="imp-counts__item imp-counts__item--warning">
          <dt>{t('import.countDuplicate')}</dt>
          <dd data-testid="import-count-duplicate">{fmt.number(counts.duplicate)}</dd>
        </div>
        <div class="imp-counts__item">
          <dt>{t('import.countWarnings')}</dt>
          <dd>{fmt.number(counts.with_warnings)}</dd>
        </div>
      </dl>

      {summary.ignoredColumns.length > 0 && (
        <p class="imp-note" data-testid="import-ignored">
          {t('import.ignoredColumns', { columns: summary.ignoredColumns.join('، ') })}
        </p>
      )}

      {refused && (
        <div class="imp-refused" role="alert" data-testid="import-commit-refused">
          <strong>{t('import.commitRefused', { row: refused.failedRow ?? '?' })}</strong>
          {refused.error && (
            <p>
              <code class="ltr">{refused.error.code}</code> <bdi>{refused.error.message}</bdi>
            </p>
          )}
          <p class="muted">{t('import.commitRefusedHint')}</p>
        </div>
      )}

      <div class="chips imp-filters" role="group" aria-label={t('import.filterLabel')}>
        {FILTERS.map((f) => {
          const on = filter === f.value;
          return (
            <button
              key={f.key}
              type="button"
              class={on ? 'chip chip--on' : 'chip'}
              aria-pressed={on}
              onClick={() => changeFilter(f.value)}
              data-testid={`import-filter-${f.value ?? 'all'}`}
            >
              {t(f.key)}
              {f.count ? ` (${fmt.number(counts[f.count])})` : ''}
            </button>
          );
        })}
      </div>

      <h3 class="sr-only" tabIndex={-1} ref={listTop}>
        {t('import.rowsHeading')}
      </h3>
      {error && (
        <div class="imp-error" role="alert">
          <p>{error}</p>
          <Button size="sm" onClick={() => void load(after, filter)} testId="import-preview-retry">
            {t('import.retry')}
          </Button>
        </div>
      )}
      {loading && !page && <Spinner block label={t('import.loading')} />}
      {page && page.rows.length === 0 && !loading && (
        <p class="muted" data-testid="import-preview-empty">
          {t('import.noRows')}
        </p>
      )}
      {page && page.rows.length > 0 && (
        <ol class="imp-rows" aria-busy={loading} data-testid="import-rows">
          {page.rows.map((row) => (
            <RowCard
              key={row.rowNo}
              row={row}
              columns={columns}
              editable={validated && online}
              busy={busyRow === row.rowNo}
              refused={refused?.failedRow === row.rowNo}
              onAction={(a, target) => void setAction(row, a, target)}
            />
          ))}
        </ol>
      )}

      <div class="row imp-pager">
        <Button
          size="sm"
          onClick={prevPage}
          disabled={cursors.length <= 1 || loading}
          testId="import-page-prev"
        >
          {t('import.pagePrev')}
        </Button>
        <span class="muted" aria-live="polite">
          {firstNo !== undefined && lastNo !== undefined
            ? t('import.pageRange', {
                from: fmt.number(firstNo),
                to: fmt.number(lastNo),
                total: fmt.number(total),
              })
            : ''}
        </span>
        <Button
          size="sm"
          onClick={nextPage}
          disabled={page?.next === null || page?.next === undefined || loading}
          testId="import-page-next"
        >
          {t('import.pageNext')}
        </Button>
      </div>

      <div class="imp-commit">
        <p data-testid="import-commit-summary">
          {t('import.commitSummary', {
            create: fmt.number(counts.create),
            update: fmt.number(counts.update),
            skip: fmt.number(counts.skip),
          })}
        </p>
        {counts.invalid > 0 && (
          <p class="muted">{t('import.invalidLeftOut', { count: fmt.number(counts.invalid) })}</p>
        )}
        <p class="muted">{t('import.commitDraftsNote')}</p>
        <div class="row">
          <Button
            variant="gold"
            onClick={() => void commit()}
            disabled={!validated || !online || importable === 0 || loading}
            busy={committing}
            testId="import-commit"
          >
            {t('import.commitButton', { count: fmt.number(importable) })}
          </Button>
          <Button variant="ghost" onClick={onClose} testId="import-preview-close">
            {t('import.previewLater')}
          </Button>
        </div>
      </div>
    </section>
  );
}

interface RowCardProps {
  row: PreviewRow;
  columns: readonly TemplateColumn[];
  editable: boolean;
  busy: boolean;
  refused: boolean;
  onAction: (action: RowAction, target?: string) => void;
}

/** Possible-duplicate candidates of a row (first match per id), for the merge target. */
export function candidatesOf(row: PreviewRow): DuplicateCandidate[] {
  const seen = new Map<string, DuplicateCandidate>();
  for (const issue of row.warnings)
    for (const c of issue.candidates ?? []) if (!seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}

/** The project an `update` row merges into: its target, else the first candidate. */
export function mergeTargetOf(row: PreviewRow): string | null {
  return row.action === 'update' ? (row.targetId ?? row.duplicateOf) : null;
}

function candidateLabel(c: DuplicateCandidate): string {
  const name = c.name_ar ?? c.name_latin ?? '';
  return c.code ? `${c.code} ${name}`.trim() : name;
}

function IssueList({
  issues,
  columns,
  kind,
  merge,
}: {
  issues: ImportIssue[];
  columns: readonly TemplateColumn[];
  kind: 'error' | 'warning';
  /** Candidates may be picked as the merge target ("it is the same one as this project"). */
  merge?: {
    target: string | null;
    disabled: boolean;
    onPick: (id: string) => void;
  };
}) {
  if (issues.length === 0) return null;
  return (
    <ul
      class={`imp-issues imp-issues--${kind}`}
      aria-label={t(kind === 'error' ? 'import.errors' : 'import.warnings')}
    >
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${i}`} data-testid={`import-${kind}`} data-code={issue.code}>
          {issue.field && (
            <strong class="imp-issue__field">{fieldLabel(issue.field, columns)}: </strong>
          )}
          {issueText(issue)}
          {issue.candidates && issue.candidates.length > 0 && (
            <ul class="imp-candidates">
              {issue.candidates.map((c) => (
                <li key={c.id} data-testid="import-candidate">
                  <Link href={`/projects/${c.id}`}>
                    {c.code && (
                      <span class="ltr mono" dir="ltr">
                        {c.code}
                      </span>
                    )}{' '}
                    <bdi>{c.name_ar ?? c.name_latin ?? ''}</bdi>
                  </Link>
                  {c.type ? ` · ${typeLabel(c.type)}` : ''}
                  {c.distance_m !== null
                    ? ` · ${t('import.distance', { m: fmt.number(Math.round(c.distance_m)) })}`
                    : ''}
                  {merge &&
                    (merge.target === c.id ? (
                      <span class="imp-candidate__chosen" data-testid="import-candidate-chosen">
                        {' '}
                        <Badge tone="success">{t('import.mergeChosen')}</Badge>
                      </span>
                    ) : (
                      <>
                        {' '}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={merge.disabled}
                          onClick={() => merge.onPick(c.id)}
                          testId="import-candidate-merge"
                          aria-label={t('import.mergeIntoNamed', { project: candidateLabel(c) })}
                        >
                          {t('import.mergeInto')}
                        </Button>
                      </>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function RowCard({ row, columns, editable, busy, refused, onAction }: RowCardProps) {
  const name = rowName(row);
  const type = rowType(row);
  const actions = actionsFor(row);
  const selectId = `imp-action-${row.rowNo}`;
  const target = mergeTargetOf(row);
  const targetCandidate = target ? candidatesOf(row).find((c) => c.id === target) : undefined;
  // Every candidate can be the merge target, not only the first one (brief §10).
  const merge = actions.includes('update')
    ? {
        target,
        disabled: !editable || busy,
        onPick: (id: string) => onAction('update', id),
      }
    : undefined;
  return (
    <li
      class={refused ? 'imp-row imp-row--refused' : 'imp-row'}
      data-testid="import-row"
      data-row={row.rowNo}
      data-state={row.state}
      data-action={row.action ?? ''}
    >
      <div class="imp-row__head">
        <span class="imp-row__no">{t('import.rowNo', { n: fmt.number(row.rowNo) })}</span>
        <bdi class="imp-row__name">{name ?? t('import.rowUnnamed')}</bdi>
        {type && <span class="muted">{typeLabel(type)}</span>}
        <Badge tone={stateTone(row.state)}>{rowStateLabel(row.state)}</Badge>
      </div>
      {row.externalId && (
        <p class="imp-row__ext muted">
          {t('import.externalId')}:{' '}
          <span class="ltr mono" dir="ltr">
            {row.externalId}
          </span>
        </p>
      )}
      <IssueList issues={row.errors} columns={columns} kind="error" />
      <IssueList
        issues={row.warnings}
        columns={columns}
        kind="warning"
        {...(merge ? { merge } : {})}
      />
      {actions.length > 0 && (
        <div class="imp-row__action">
          <label for={selectId}>{t('import.actionLabel')}</label>
          <select
            id={selectId}
            class="control select"
            value={row.action ?? ''}
            disabled={!editable || busy}
            onChange={(e) => onAction(e.currentTarget.value as RowAction)}
            data-testid="import-row-action"
          >
            {actions.map((a) => (
              <option key={a} value={a}>
                {t(`import.action_${a}`)}
              </option>
            ))}
          </select>
          {busy && <Spinner size={16} label={t('import.saving')} />}
          {targetCandidate && (
            <p class="imp-row__target" data-testid="import-row-target" data-target={target}>
              {t('import.mergeTarget')}{' '}
              {targetCandidate.code && (
                <span class="ltr mono" dir="ltr">
                  {targetCandidate.code}
                </span>
              )}{' '}
              <bdi>{targetCandidate.name_ar ?? targetCandidate.name_latin ?? ''}</bdi>
            </p>
          )}
        </div>
      )}
    </li>
  );
}
