/**
 * The user's import batches (newest first) with what each one did, "continue the review" for
 * a validated batch and the rollback of a committed one (`import_rollback`: drafts created by
 * the batch are removed, updated fields restored unless somebody changed them since).
 */
import { useEffect, useState } from 'preact/hooks';
import { fmt, t } from '../i18n';
import { Badge, Button, Spinner, confirm, toast, type BadgeTone } from '../ui';
import { importApi } from './api';
import { batchStateLabel, importErrorText, sourceKindLabel } from './labels';
import type { BatchRow, RollbackResult } from './types';

const HISTORY_LIMIT = 20;

function batchTone(state: string): BadgeTone {
  switch (state) {
    case 'committed':
      return 'success';
    case 'validated':
      return 'info';
    case 'rolled_back':
      return 'inactive';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

export interface HistoryCardProps {
  online: boolean;
  /** Changes whenever a batch was staged / committed, to reload the list. */
  version: number;
  onOpen: (batch: BatchRow) => void;
}

export function HistoryCard({ online, version, onOpen }: HistoryCardProps) {
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RollbackResult>>({});

  const load = async (): Promise<void> => {
    setError(null);
    try {
      setRows(await importApi().batches(HISTORY_LIMIT));
    } catch (e) {
      setError(importErrorText(e));
    }
  };

  useEffect(() => {
    if (online) void load();
  }, [online, version]);

  const rollback = async (batch: BatchRow): Promise<void> => {
    const ok = await confirm({
      title: t('import.rollbackConfirmTitle'),
      message: t('import.rollbackConfirmMessage', {
        file: batch.fileName ?? sourceKindLabel(batch.sourceKind),
      }),
      confirmLabel: t('import.rollback'),
      danger: true,
    });
    if (!ok) return;
    setBusy(batch.id);
    try {
      const result = await importApi().rollback(batch.id);
      setResults((r) => ({ ...r, [batch.id]: result }));
      toast(t('import.rollbackDone', { count: fmt.number(result.reverted) }), 'success');
      await load();
    } catch (e) {
      toast(importErrorText(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section class="card" aria-labelledby="imp-history-title" data-testid="import-history">
      <h2 id="imp-history-title">{t('import.historyTitle')}</h2>
      {!online && <p class="muted">{t('import.offline')}</p>}
      {error && (
        <div class="imp-error" role="alert">
          <p>{error}</p>
          <Button size="sm" onClick={() => void load()}>
            {t('import.retry')}
          </Button>
        </div>
      )}
      {online && rows === null && !error && <Spinner block label={t('import.loading')} />}
      {rows && rows.length === 0 && <p class="muted">{t('import.historyEmpty')}</p>}
      {rows && rows.length > 0 && (
        <ul class="imp-history">
          {rows.map((b) => {
            const result = results[b.id];
            return (
              <li
                key={b.id}
                class="imp-history__item"
                data-testid="import-batch"
                data-state={b.state}
              >
                <div class="imp-history__head">
                  <bdi class="imp-history__name">{b.fileName ?? sourceKindLabel(b.sourceKind)}</bdi>
                  <Badge tone={batchTone(b.state)}>{batchStateLabel(b.state)}</Badge>
                </div>
                <p class="muted imp-history__meta">
                  {b.createdAt ? fmt.dateTime(b.createdAt) : ''} · {sourceKindLabel(b.sourceKind)} ·{' '}
                  {t('import.rowsTotal', { count: fmt.number(b.rowCount) })}
                </p>
                {b.state === 'committed' || b.state === 'rolled_back' ? (
                  <p class="imp-history__counts">
                    {t('import.appliedCounts', {
                      created: fmt.number(b.counts.applied_created),
                      updated: fmt.number(b.counts.applied_updated),
                      skipped: fmt.number(b.counts.skipped),
                    })}
                    {b.state === 'rolled_back'
                      ? ` · ${t('import.revertedCount', { count: fmt.number(b.counts.reverted) })}`
                      : ''}
                  </p>
                ) : null}
                {result && (
                  <div
                    class="imp-rollback-result"
                    role="status"
                    data-testid="import-rollback-result"
                  >
                    <p>
                      {t('import.rollbackResult', {
                        reverted: fmt.number(result.reverted),
                        kept: fmt.number(result.kept),
                        conflicting: fmt.number(result.conflictingFields),
                      })}
                    </p>
                    {result.noAccess > 0 && (
                      <p class="muted">
                        {t('import.rollbackNoAccess', { count: fmt.number(result.noAccess) })}
                      </p>
                    )}
                    {result.conflictingFields > 0 && (
                      <p class="muted">{t('import.rollbackConflictsHint')}</p>
                    )}
                  </div>
                )}
                <div class="row">
                  {b.state === 'validated' && (
                    <Button
                      size="sm"
                      onClick={() => onOpen(b)}
                      disabled={!online}
                      testId="import-batch-open"
                    >
                      {t('import.continueReview')}
                    </Button>
                  )}
                  {b.state === 'committed' && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void rollback(b)}
                      busy={busy === b.id}
                      disabled={!online || (busy !== null && busy !== b.id)}
                      testId="import-batch-rollback"
                    >
                      {t('import.rollback')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
