import { useState } from 'preact/hooks';
import { discardFailedOp, retryFailedOps, type FailedOp } from '../db';
import { fmt, hasTranslation, pickName, t } from '../i18n';
import { Button, confirm, Link, Spinner, toast, useLiveQuery } from '../ui';
import { listFailedOpsWithContext, type FailedOpView } from './queries';
import { kickSync } from './review';

/** Translated table name ("Project", "Maintenance entry", …), the raw name when unknown. */
export function tableLabel(table: string): string {
  const key = `projects.table_${table}`;
  return hasTranslation(key) ? t(key) : table;
}

/** Plain-language reason of a rejection; the code itself when there is no text for it. */
export function errorLabel(code: string | undefined): string {
  const key = `projects.err_${code ?? 'unknown'}`;
  return hasTranslation(key) ? t(key) : t('projects.err_other', { code: code ?? '?' });
}

export function opKindLabel(op: Pick<FailedOp, 'kind' | 'base_version' | 'fields'>): string {
  if (op.kind === 'delete') return t('projects.opDelete');
  return op.base_version === 0 && 'created_at' in op.fields
    ? t('projects.opInsert')
    : t('projects.opUpdate');
}

function FailedRow({ view }: { view: FailedOpView }) {
  const { op, project } = view;
  const [busy, setBusy] = useState<'retry' | 'discard' | null>(null);
  const id = op.id!;

  const retry = async (): Promise<void> => {
    setBusy('retry');
    try {
      await retryFailedOps([id]);
      kickSync();
      toast(t('projects.retryQueued'), 'success');
    } catch {
      toast(t('projects.actionFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const discard = async (): Promise<void> => {
    const ok = await confirm({
      title: t('projects.discardOpTitle'),
      message: t('projects.discardOpBody'),
      confirmLabel: t('projects.discardOp'),
      danger: true,
    });
    if (!ok) return;
    setBusy('discard');
    try {
      await discardFailedOp(id);
      toast(t('projects.discardedOp'), 'success');
    } catch {
      toast(t('projects.actionFailed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <li class="prow" data-testid="failed-op" data-id={id} data-code={op.error.code}>
      <div class="prow__head">
        <span class="badge badge--danger">{opKindLabel(op)}</span>
        <span class="prow__title">{tableLabel(op.table)}</span>
        <span class="prow__meta">{fmt.dateTime(new Date(op.failed_at))}</span>
      </div>
      {project && (
        <Link href={`/projects/${project.id}`} class="prow__meta">
          <bdi>{pickName(project) || project.code}</bdi>
        </Link>
      )}
      <p class="pnote" data-testid="failed-op-reason">
        {errorLabel(op.error.code)}
      </p>
      <div class="prow__actions">
        <Button
          size="sm"
          variant="primary"
          testId="failed-retry"
          busy={busy === 'retry'}
          onClick={() => void retry()}
        >
          {t('projects.retry')}
        </Button>
        <Button
          size="sm"
          variant="danger"
          testId="failed-discard"
          busy={busy === 'discard'}
          onClick={() => void discard()}
        >
          {t('projects.discardOp')}
        </Button>
      </div>
    </li>
  );
}

/**
 * Operations of this device the server rejected ("needs attention", sync.md §4.1). The user
 * retries (same op id) or discards (the device goes back to what the server has).
 */
export function FailedOpsPanel({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const views = useLiveQuery(() => listFailedOpsWithContext(), []);
  const [busy, setBusy] = useState(false);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  const retryAll = async (): Promise<void> => {
    setBusy(true);
    try {
      await retryFailedOps();
      kickSync();
      toast(t('projects.retryQueued'), 'success');
    } catch {
      toast(t('projects.actionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="psection" aria-labelledby="sec-failed" data-testid="failed-ops">
      <Heading id="sec-failed" class="psection__title">
        <span>{t('projects.failedTitle')}</span>
        {views && views.length > 1 && (
          <Button size="sm" testId="failed-retry-all" busy={busy} onClick={() => void retryAll()}>
            {t('projects.retryAll')}
          </Button>
        )}
      </Heading>
      {views === undefined ? (
        <Spinner block />
      ) : views.length === 0 ? (
        <p class="psection__empty" data-testid="failed-ops-empty">
          {t('projects.failedEmpty')}
        </p>
      ) : (
        <>
          <p class="pnote">{t('projects.failedIntro')}</p>
          <ul class="prows">
            {views.map((v) => (
              <FailedRow key={v.op.id} view={v} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
