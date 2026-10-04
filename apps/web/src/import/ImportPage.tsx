/**
 * Bulk import (route `/import`, brief §10): 1. the official template, 2. upload of the filled
 * CSV / XLSX (parsed and validated on the server), 3. review page by page with the action of
 * every row, 4. commit — always a MERGE by `external_id`, never a replacement (the v2 "import
 * backup" button is gone) — and the history of batches with their rollback. Below: the v2
 * migration (local data of this device or a v2 backup file).
 */
import { useEffect, useState } from 'preact/hooks';
import { can } from '../auth';
import { fmt, locale, t } from '../i18n';
import { V2MigrationPanel } from '../migration/V2MigrationPanel';
import { navigate } from '../routes';
import { Button, EmptyState } from '../ui';
import { importApi } from './api';
import { HistoryCard } from './HistoryCard';
import { PreviewPanel } from './PreviewPanel';
import { TemplateCard } from './TemplateCard';
import { UploadCard } from './UploadCard';
import type {
  BatchRow,
  CommitResult,
  ImportSummary,
  ImportTemplate,
  TemplateColumn,
} from './types';
import { useOnline } from './useOnline';
import './import.css';

/** Templates fetched in this page session, by language. */
const templates = new Map<string, ImportTemplate>();

export function summaryOfBatch(b: BatchRow): ImportSummary {
  return {
    batchId: b.id,
    state: b.state,
    sourceKind: b.sourceKind,
    fileName: b.fileName,
    rowCount: b.rowCount,
    counts: b.counts,
    ignoredColumns: [],
    firstErrors: [],
    committedAt: b.committedAt,
    rolledBackAt: b.rolledBackAt,
  };
}

export default function ImportPage() {
  const online = useOnline();
  const lang = locale.value;
  const [columns, setColumns] = useState<TemplateColumn[]>(
    () => templates.get(lang)?.columns ?? [],
  );
  const [batch, setBatch] = useState<ImportSummary | null>(null);
  const [done, setDone] = useState<CommitResult | null>(null);
  const [version, setVersion] = useState(0);

  // Column headers in the interface language label the fields of errors.
  useEffect(() => {
    const cached = templates.get(lang);
    if (cached) {
      setColumns(cached.columns);
      return;
    }
    if (!online) return;
    let alive = true;
    importApi()
      .template(lang)
      .then((tpl) => {
        templates.set(lang, tpl);
        if (alive) setColumns(tpl.columns);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [lang, online]);

  if (!can.write.value) {
    return (
      <div class="page imp" data-testid="import-page">
        <EmptyState
          title={t('import.noAccessTitle')}
          message={t('import.noAccessMessage')}
          testId="import-no-access"
        />
      </div>
    );
  }

  const staged = (summary: ImportSummary): void => {
    setDone(null);
    setBatch(summary);
    setVersion((v) => v + 1);
  };

  return (
    <div class="page imp" data-testid="import-page">
      <p class="imp-intro">{t('import.intro')}</p>
      {!online && (
        <p class="imp-offline" role="status" data-testid="import-offline">
          {t('import.offlineLong')}
        </p>
      )}

      <TemplateCard online={online} cache={templates} />

      {batch ? (
        <PreviewPanel
          key={batch.batchId}
          summary={batch}
          columns={columns}
          online={online}
          onCommitted={(result) => {
            setBatch(null);
            setDone(result);
            setVersion((v) => v + 1);
          }}
          onClose={() => setBatch(null)}
        />
      ) : (
        <UploadCard online={online} onStaged={staged} />
      )}

      {done && (
        <section
          class="card imp-step imp-done"
          aria-labelledby="imp-done-title"
          data-testid="import-done"
          role="status"
        >
          <h2 id="imp-done-title">
            <span class="imp-step__no" aria-hidden="true">
              4
            </span>
            {t('import.doneTitle')}
          </h2>
          <p data-testid="import-done-counts">
            {t('import.appliedCounts', {
              created: fmt.number(done.counts.applied_created),
              updated: fmt.number(done.counts.applied_updated),
              skipped: fmt.number(done.counts.skipped),
            })}
          </p>
          <p class="muted">{t('import.doneHint')}</p>
          <div class="row">
            <Button
              variant="primary"
              onClick={() => navigate('/projects')}
              testId="import-done-projects"
            >
              {t('import.openProjects')}
            </Button>
            <Button onClick={() => setDone(null)} testId="import-done-again">
              {t('import.importAnother')}
            </Button>
          </div>
        </section>
      )}

      <HistoryCard online={online} version={version} onOpen={(b) => staged(summaryOfBatch(b))} />

      <section class="card" aria-labelledby="imp-v2-title" data-testid="import-v2">
        <h2 id="imp-v2-title">{t('migration.sectionTitle')}</h2>
        <V2MigrationPanel />
      </section>
    </div>
  );
}
