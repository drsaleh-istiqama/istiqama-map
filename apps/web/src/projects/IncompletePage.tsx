import { listIncompleteProjects, type ListCursor, type ProjectListItem } from '../db';
import type { CompletenessKey } from '../lib/completeness';
import { fmt, pickName, t } from '../i18n';
import { navigate } from '../routes';
import { syncStatus } from '../sync';
import {
  Button,
  confirm,
  EmptyState,
  Link,
  Spinner,
  toast,
  useLiveQuery,
  VirtualList,
} from '../ui';
import { FailedOpsPanel } from './FailedOpsPanel';
import { discardStoredDraft, listUserDrafts, type DraftSummary } from './form/drafts';
import type { FormDraft } from './form/model';
import { RecordStateBadge, StatusBadge, TypeIcon } from './labels';
import { canEditProject, currentActor, type Actor } from './permissions';
import { placeOf, SyncFlags } from './ProjectCard';
import { PAGE_SIZE } from './ProjectList';
import { missingParts } from './queries';
import { RowActions } from './RowActions';
import { useKeysetList, type KeysetPage } from './useKeysetList';
import './projects.css';

export function missingLabel(key: CompletenessKey): string {
  return t(`projects.missing_${key}`);
}

/** Fixed height of an incomplete-record row (name and "complete now", badges, two lines of what is missing). */
export const INCOMPLETE_ROW_HEIGHT = 152;

/** Height of the list box: as tall as its rows, at most this share of the screen (the drafts and rejected operations follow below). */
const INCOMPLETE_LIST_MAX = '65vh';

interface IncompleteItem {
  item: ProjectListItem;
  missing: CompletenessKey[] | undefined;
}

function IncompleteRow({ item, missing, actor }: IncompleteItem & { actor: Actor }) {
  const editable = canEditProject(item, actor);
  const missingText = (missing ?? []).map(missingLabel).join(t('projects.listSep'));
  return (
    <div class="rrow" data-testid="incomplete-row" data-id={item.id}>
      <div class="rrow__head">
        <TypeIcon type={item.type} size={20} labelled />
        <bdi class="rrow__name">{pickName(item) || item.code}</bdi>
        <span class="pcard__cmp">
          {t('projects.completenessShort', { value: fmt.percent(item.completeness) })}
        </span>
      </div>
      <div class="rrow__line">
        <StatusBadge status={item.status} />
        <RecordStateBadge state={item.record_state} />
        <SyncFlags dirty={item.dirty} conflict={item.conflict} failed={item.failed} />
        <span class="rrow__text">{placeOf(item)}</span>
        {editable && (
          <RowActions class="rrow__end">
            <Link
              href={`/projects/${item.id}/edit`}
              class="btn btn--secondary btn--sm"
              testId="incomplete-edit"
            >
              <span class="btn__label">{t('projects.completeNow')}</span>
            </Link>
          </RowActions>
        )}
      </div>
      {missing && missing.length > 0 && (
        <div class="rrow__missing" title={missingText}>
          <span class="rrow__label">{t('projects.missingTitle')}</span>
          <ul class="ptags" data-testid="incomplete-missing">
            {missing.map((k) => (
              <li key={k} data-key={k}>
                {missingLabel(k)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

async function incompletePage(
  after: ListCursor | null,
): Promise<KeysetPage<IncompleteItem, ListCursor>> {
  const page = await listIncompleteProjects({ mine: true }, after, PAGE_SIZE);
  const parts = await missingParts(page.rows.map((r) => r.id));
  return {
    rows: page.rows.map((item) => ({ item, missing: parts.get(item.id) })),
    next: page.next,
    total: page.total,
  };
}

/**
 * The signed-in user's incomplete records: a virtual list over keyset pages of 50 (brief §5),
 * only the rows in view in the DOM. A row opens the record; "complete now" opens the form.
 */
function IncompleteList({ actor }: { actor: Actor }) {
  const { lastSyncAt, pendingOps } = syncStatus.value;
  const list = useKeysetList<IncompleteItem, ListCursor>(
    incompletePage,
    (row) => row.item.id,
    PAGE_SIZE,
    actor.userId ?? '',
    `${lastSyncAt ?? ''}|${pendingOps}`,
  );
  const { rows, total } = list;

  return (
    <section class="psection" aria-labelledby="sec-incomplete" data-testid="incomplete-records">
      <h2 id="sec-incomplete">
        <span>{t('projects.incompleteTitle')}</span>
        {total !== null && total > 0 && <span class="pcount">{fmt.number(total)}</span>}
      </h2>
      {total === null ? (
        <Spinner block />
      ) : rows.length === 0 ? (
        <EmptyState
          testId="incomplete-empty"
          title={t('projects.incompleteEmpty')}
          message={t('projects.incompleteEmptyHint')}
        />
      ) : (
        <>
          <p class="pnote">{t('projects.incompleteIntro')}</p>
          <div
            class="pvbox"
            style={{
              blockSize: `min(${rows.length * INCOMPLETE_ROW_HEIGHT + 2}px, ${INCOMPLETE_LIST_MAX})`,
            }}
          >
            <VirtualList
              items={rows}
              rowHeight={INCOMPLETE_ROW_HEIGHT}
              rowKey={(row) => row.item.id}
              renderRow={(row) => <IncompleteRow {...row} actor={actor} />}
              onEndReached={list.hasMore ? list.loadMore : undefined}
              onActivate={(index) => {
                const row = rows[index];
                if (row) navigate(`/projects/${row.item.id}`);
              }}
              label={t('projects.incompleteTitle')}
              testId="incomplete-rows"
            />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Title of a form draft and where it is continued — the form's convention
 * (`project-form:<new|edit>:<project id>`, `/projects/new?draft=<id>`, `/projects/<id>/edit`).
 */
export function describeDraft(draft: Pick<FormDraft, 'mode' | 'projectId' | 'working'>): {
  name: string;
  href: string;
} {
  const project = draft.working?.project;
  const name = pickName({
    name_ar: project?.name_ar ?? null,
    name_latin: project?.name_latin ?? null,
  });
  const href =
    draft.mode === 'edit'
      ? `/projects/${draft.projectId}/edit`
      : `/projects/new?draft=${encodeURIComponent(draft.projectId)}`;
  return { name, href };
}

function DraftsSection({ userId }: { userId: string | null }) {
  const list = useLiveQuery(() => listUserDrafts(userId), [userId]);
  const discard = async (summary: DraftSummary): Promise<void> => {
    const ok = await confirm({
      title: t('projects.discardDraftTitle'),
      message: t('projects.discardDraftBody'),
      confirmLabel: t('projects.discardDraft'),
      danger: true,
    });
    if (!ok) return;
    try {
      // The form's own discard: also frees the photos of a project that was never saved.
      await discardStoredDraft(summary.draft);
      toast(t('projects.draftDiscarded'), 'success');
    } catch {
      toast(t('projects.actionFailed'), 'error');
    }
  };
  return (
    <section class="psection" aria-labelledby="sec-drafts" data-testid="form-drafts">
      <h2 id="sec-drafts">{t('projects.draftsTitle')}</h2>
      {list === undefined ? (
        <Spinner block />
      ) : list.length === 0 ? (
        <p class="psection__empty" data-testid="drafts-empty">
          {t('projects.draftsEmpty')}
        </p>
      ) : (
        <ul class="prows">
          {list.map((d) => {
            const info = describeDraft(d.draft);
            return (
              <li
                key={d.key}
                class="prow"
                data-testid="draft-row"
                data-key={d.key}
                data-mode={d.draft.mode}
              >
                <div class="prow__head">
                  <bdi class="prow__title">{info.name || t('projects.draftUntitled')}</bdi>
                  <span class="prow__meta">
                    {t('projects.draftSaved', { when: fmt.relative(new Date(d.updatedAt)) })}
                  </span>
                </div>
                <div class="prow__actions">
                  <Link href={info.href} class="btn btn--primary btn--sm" testId="draft-continue">
                    <span class="btn__label">{t('projects.draftContinue')}</span>
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    testId="draft-discard"
                    onClick={() => void discard(d)}
                  >
                    {t('projects.discardDraft')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * "Incomplete records" (brief §7.5, route `/incomplete`): the signed-in user's records below
 * 100 % with what is missing, the unfinished form drafts, and rejected operations of this
 * device that need a decision.
 */
export default function IncompletePage() {
  const actor = currentActor();
  return (
    <div class="ppage pstack" data-testid="incomplete-page">
      <IncompleteList actor={actor} />
      <DraftsSection userId={actor.userId} />
      {actor.write && <FailedOpsPanel />}
    </div>
  );
}
