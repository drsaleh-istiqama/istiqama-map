import { useEffect, useState } from 'preact/hooks';
import { db, listProjects, type ListCursor, type ProjectFilter, type ProjectListItem } from '../db';
import { fmt, pickName, t } from '../i18n';
import { navigate } from '../routes';
import { syncStatus } from '../sync';
import { Badge, Button, EmptyState, Spinner, toast, useLiveQuery, VirtualList } from '../ui';
import { RecordStateBadge, StatusBadge, TypeIcon } from './labels';
import { canApprove, canReturn, type Actor } from './permissions';
import { placeOf, SyncFlags } from './ProjectCard';
import { PAGE_SIZE } from './ProjectList';
import { approveProject, returnProject } from './review';
import { ReturnDialog } from './ReturnDialog';
import { RowActions } from './RowActions';
import { useKeysetList } from './useKeysetList';

/** Fixed height of a review row (name, badges, place line, the two decision buttons). */
export const REVIEW_ROW_HEIGHT = 152;

/** Submitted records, the most recently changed first (as before: `sort: 'updated'`). */
const SUBMITTED: ProjectFilter & { sort: 'updated' } = {
  recordState: 'submitted',
  sort: 'updated',
};

function SubmittedRow({
  item,
  actor,
  onReturn,
  onDone,
}: {
  item: ProjectListItem;
  actor: Actor;
  onReturn: (item: ProjectListItem) => void;
  onDone: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const approve = async (): Promise<void> => {
    setBusy(true);
    try {
      await approveProject(item.id);
      toast(t('projects.approved'), 'success');
      onDone(item.id);
    } catch {
      toast(t('projects.actionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const approvable = canApprove(item, actor);
  const returnable = canReturn(item, actor);
  // The v2 migration flag (migration 0073): only the rows in view exist, so one primary-key
  // read per rendered row; the badge sits in the badge line (the row height is fixed).
  const migrationNote = useLiveQuery(
    () => db.projects.get(item.id).then((p) => p?.migration_note?.trim() || null),
    [item.id],
  );
  return (
    <div class="rrow" data-testid="review-row" data-id={item.id}>
      <div class="rrow__head">
        <TypeIcon type={item.type} size={20} labelled />
        <bdi class="rrow__name">{pickName(item) || item.code}</bdi>
        {item.code && (
          <span class="ltr rrow__code" dir="ltr">
            {item.code}
          </span>
        )}
      </div>
      <div class="rrow__line">
        <StatusBadge status={item.status} />
        <RecordStateBadge state={item.record_state} />
        <SyncFlags dirty={item.dirty} conflict={item.conflict} failed={item.failed} />
        {migrationNote && (
          <Badge tone="warning" title={migrationNote} testId="review-migration-note">
            {t('projects.migrationNoteFlag')}
          </Badge>
        )}
      </div>
      <div class="rrow__text">
        {[
          placeOf(item),
          t('projects.completenessShort', { value: fmt.percent(item.completeness) }),
          fmt.relative(item.updated_at),
        ]
          .filter((s) => s !== '')
          .join(' · ')}
      </div>
      {(approvable || returnable) && (
        <RowActions>
          {approvable && (
            <Button
              size="sm"
              variant="gold"
              testId="review-approve"
              busy={busy}
              onClick={() => void approve()}
            >
              {t('projects.approve')}
            </Button>
          )}
          {returnable && (
            <Button size="sm" testId="review-return" onClick={() => onReturn(item)}>
              {t('projects.returnToCollector')}
            </Button>
          )}
        </RowActions>
      )}
    </div>
  );
}

/**
 * (a) Submitted records of the reviewer's scope (the device holds exactly that scope): a
 * virtual list over keyset pages of 50 (brief §5) — a country's queue can hold thousands of
 * records on a 2 GB phone, and only the rows in view exist in the DOM. A row opens the
 * record; its buttons approve or return it.
 */
export function SubmittedPanel({
  actor,
  onCount,
}: {
  actor: Actor;
  onCount?: (n: number) => void;
}) {
  const [returning, setReturning] = useState<ProjectListItem | null>(null);
  const { lastSyncAt, pendingOps } = syncStatus.value;
  const list = useKeysetList<ProjectListItem, ListCursor>(
    (after) => listProjects(SUBMITTED, after, PAGE_SIZE),
    (row) => row.id,
    PAGE_SIZE,
    actor.userId ?? '',
    `${lastSyncAt ?? ''}|${pendingOps}`,
  );
  const { rows, total } = list;

  useEffect(() => {
    if (total !== null) onCount?.(total);
  }, [total]);

  if (total === null) return <Spinner block />;
  return (
    <div class="pfill" data-testid="review-submitted">
      {rows.length === 0 ? (
        <EmptyState testId="review-submitted-empty" title={t('projects.reviewQueueEmpty')} />
      ) : (
        <div class="plist__rows">
          <VirtualList
            items={rows}
            rowHeight={REVIEW_ROW_HEIGHT}
            rowKey={(item) => item.id}
            renderRow={(item) => (
              <SubmittedRow
                item={item}
                actor={actor}
                onReturn={setReturning}
                onDone={list.remove}
              />
            )}
            onEndReached={list.hasMore ? list.loadMore : undefined}
            onActivate={(index) => {
              const item = rows[index];
              if (item) navigate(`/projects/${item.id}`);
            }}
            label={t('projects.reviewTab_submitted')}
            testId="review-rows"
          />
        </div>
      )}
      <ReturnDialog
        open={returning !== null}
        projectName={returning ? pickName(returning) : ''}
        onCancel={() => setReturning(null)}
        onSubmit={async (note) => {
          if (!returning) return;
          await returnProject(returning.id, note);
          list.remove(returning.id);
          setReturning(null);
          toast(t('projects.returned'), 'success');
        }}
      />
    </div>
  );
}
