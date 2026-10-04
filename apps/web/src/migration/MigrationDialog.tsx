/**
 * The one migration dialog (see controller.ts): summary before anything is written, progress,
 * final report. Esc / close never discard anything: during the run it only hides the window
 * (the run continues), the summary writes nothing, the report is kept on the device.
 */
import { useEffect } from 'preact/hooks';
import { fmt, t } from '../i18n';
import { navigate } from '../routes';
import { syncStatus } from '../sync';
import { Button, Modal, Spinner } from '../ui';
import {
  closeMigration,
  flow,
  flowHidden,
  migrationDeps,
  refreshReport,
  retryMigration,
  startMigration,
} from './controller';
import { flowErrorText, groupWarnings, isInfo, warningText } from './labels';
import type { RunReport } from './runner';
import type { MigrationWarning, PlanCounts } from './v2map';
import './migration.css';

function CountsList({ counts, testId }: { counts: PlanCounts; testId: string }) {
  const items: Array<[string, number, string]> = [
    ['migration.countProjects', counts.projects, 'projects'],
    ['migration.countSkipped', counts.skipped, 'skipped'],
    ['migration.countPersons', counts.persons, 'persons'],
    ['migration.countStaff', counts.staff, 'staff'],
    ['migration.countSalaries', counts.salaries, 'salaries'],
    ['migration.countPhotos', counts.photos, 'photos'],
    ['migration.countPhotosRejected', counts.photosRejected, 'photos-rejected'],
    ['migration.countDonorsNew', counts.donorsNew, 'donors-new'],
    ['migration.countDonorsReused', counts.donorsReused, 'donors-reused'],
    ['migration.countLocalitiesNew', counts.localitiesNew, 'localities-new'],
    ['migration.countMaintenance', counts.maintenance, 'maintenance'],
    ['migration.countWithoutLocation', counts.withoutLocation, 'without-location'],
    ['migration.countMergeSuggestions', counts.mergeSuggestions, 'merge-suggestions'],
  ];
  return (
    <dl class="mig-counts" data-testid={testId}>
      {items
        .filter(([, n, id]) => n > 0 || id === 'projects')
        .map(([key, n, id]) => (
          <div class="mig-counts__item" key={key} data-count={id}>
            <dt>{t(key)}</dt>
            <dd>{fmt.number(n)}</dd>
          </div>
        ))}
    </dl>
  );
}

function WarningGroups({ warnings }: { warnings: readonly MigrationWarning[] }) {
  if (warnings.length === 0) return null;
  const groups = groupWarnings(warnings);
  const attention = warnings.filter((w) => !isInfo(w)).length;
  return (
    <details class="mig-warnings" data-testid="v2-migrate-warnings">
      <summary>
        {t('migration.warningsTitle', { count: fmt.number(warnings.length) })}
        {attention > 0
          ? ` · ${t('migration.warningsAttention', { count: fmt.number(attention) })}`
          : ''}
      </summary>
      <ul>
        {groups.map((g) => (
          <li key={g.key}>
            <strong>
              <bdi>{g.name}</bdi>
            </strong>
            <ul>
              {g.items.map((w, i) => (
                <li key={i} class={isInfo(w) ? 'mig-w mig-w--info' : 'mig-w'} data-code={w.code}>
                  {warningText(w)}
                  {w.field ? (
                    <>
                      {' '}
                      <code class="ltr" dir="ltr">
                        {w.field}
                      </code>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ReportView({ report }: { report: RunReport }) {
  const pushed = report.push.done;
  const local = report.source === 'v2_local';
  return (
    <div
      class="stack"
      data-testid="v2-migrate-report"
      data-pushed={String(pushed)}
      data-keys-removed={String(report.keysRemoved)}
    >
      <p class="mig-lead" role="status">
        {report.failed.length > 0
          ? t('migration.reportPartial', {
              saved: fmt.number(report.saved + report.resumedSaved),
              failed: fmt.number(report.failed.length),
            })
          : t('migration.reportSaved', { count: fmt.number(report.saved + report.resumedSaved) })}
      </p>
      <dl class="mig-counts" data-testid="v2-migrate-report-counts">
        <div class="mig-counts__item">
          <dt>{t('migration.reportProjects')}</dt>
          <dd data-testid="v2-migrate-saved">{fmt.number(report.saved + report.resumedSaved)}</dd>
        </div>
        <div class="mig-counts__item">
          <dt>{t('migration.countSkipped')}</dt>
          <dd>{fmt.number(report.skipped.length)}</dd>
        </div>
        <div class="mig-counts__item">
          <dt>{t('migration.countPersons')}</dt>
          <dd>{fmt.number(report.counts.persons)}</dd>
        </div>
        <div class="mig-counts__item">
          <dt>{t('migration.reportPhotos')}</dt>
          <dd>{fmt.number(report.photosAdded)}</dd>
        </div>
      </dl>

      <div class={pushed ? 'mig-push mig-push--ok' : 'mig-push'} data-testid="v2-migrate-push">
        {pushed ? (
          <p>
            {local
              ? report.keysRemoved
                ? t('migration.pushDoneKeys')
                : t('migration.pushDone')
              : t('migration.pushDoneFile')}
          </p>
        ) : (
          <>
            <p>{t('migration.pushWaiting', { count: fmt.number(report.push.pending) })}</p>
            {report.push.photos > 0 && (
              <p data-testid="v2-migrate-photos-waiting">
                {t('migration.pushWaitingPhotos', { count: fmt.number(report.push.photos) })}
              </p>
            )}
            {local && <p class="muted">{t('migration.keysKept')}</p>}
          </>
        )}
        {report.push.failed > 0 && (
          <div class="mig-failures" role="alert">
            <p>{t('migration.pushRejected', { count: fmt.number(report.push.failed) })}</p>
            <ul>
              {report.push.failures.slice(0, 10).map((f, i) => (
                <li key={i}>
                  <code class="ltr" dir="ltr">
                    {f.table}: {f.code}
                  </code>
                  {f.message ? (
                    <>
                      {' '}
                      <bdi>{f.message}</bdi>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <p class="muted">{t('migration.pushRejectedHint')}</p>
          </div>
        )}
      </div>

      {report.failed.length > 0 && (
        <div class="mig-failures" role="alert" data-testid="v2-migrate-failed">
          <p>{t('migration.saveFailed')}</p>
          <ul>
            {report.failed.map((f) => (
              <li key={f.key}>
                <bdi>{f.name}</bdi> — <span class="muted">{f.message}</span>
              </li>
            ))}
          </ul>
          <p class="muted">{t('migration.saveFailedHint')}</p>
        </div>
      )}
      {report.photosFailed.length > 0 && (
        <div class="mig-failures">
          <p>{t('migration.photosFailed', { count: fmt.number(report.photosFailed.length) })}</p>
          <ul>
            {report.photosFailed.slice(0, 10).map((f, i) => (
              <li key={i}>
                <bdi>{f.name}</bdi> · {t('migration.photoNo', { n: fmt.number(f.index + 1) })} —{' '}
                {f.permanent ? t('migration.photoGivenUp') : t('migration.photoRetry')}
              </li>
            ))}
          </ul>
        </div>
      )}
      <WarningGroups warnings={report.warnings} />
    </div>
  );
}

export function MigrationDialog() {
  const state = flow.value;
  const hidden = flowHidden.value;
  const status = syncStatus.value;

  // While the upload of the reported run is not confirmed: re-check after every sync.
  const reportWaiting =
    state.step === 'report' &&
    (!state.report.push.done || (state.report.source === 'v2_local' && !state.report.keysRemoved));
  useEffect(() => {
    if (reportWaiting) void refreshReport();
  }, [reportWaiting, status.lastSyncAt, status.pendingOps, status.failedOps, status.pendingPhotos]);

  if (state.step === 'closed') return null;
  const open = !hidden;
  const running = state.step === 'running';

  const confirmClose = (): boolean => {
    closeMigration();
    return false;
  };

  let title = t('migration.dialogTitle');
  let body = null;
  let footer = null;

  switch (state.step) {
    case 'preparing':
      body = (
        <div data-testid="v2-migrate-preparing">
          <Spinner block label={t('migration.preparing')} />
          <p class="muted mig-center">{t('migration.preparingHint')}</p>
        </div>
      );
      footer = (
        <Button variant="ghost" onClick={closeMigration}>
          {t('migration.cancel')}
        </Button>
      );
      break;
    case 'summary': {
      const { plan, resumed } = state.prepared;
      const nothing = plan.counts.projects === 0 && plan.standalonePersons.length === 0;
      title = t('migration.summaryTitle');
      body = (
        <div class="stack" data-testid="v2-migrate-summary">
          {resumed && <p class="mig-note">{t('migration.resumed')}</p>}
          <p>{nothing ? t('migration.nothingNew') : t('migration.summaryLead')}</p>
          <CountsList counts={plan.counts} testId="v2-migrate-counts" />
          <ul class="mig-rules">
            <li>{t('migration.ruleDrafts')}</li>
            <li>{t('migration.ruleNoMerge')}</li>
            {plan.counts.salaries > 0 && <li>{t('migration.ruleSalary')}</li>}
            <li>
              {state.input.kind === 'local' ? t('migration.ruleKeys') : t('migration.ruleFile')}
            </li>
          </ul>
          <WarningGroups warnings={plan.warnings} />
        </div>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={closeMigration} testId="v2-migrate-cancel">
            {t('migration.cancel')}
          </Button>
          <Button
            variant="gold"
            onClick={() => void startMigration()}
            disabled={nothing && state.input.kind !== 'local'}
            testId="v2-migrate-start"
          >
            {nothing
              ? t('migration.finishOnly')
              : t('migration.start', { count: fmt.number(plan.counts.projects) })}
          </Button>
        </>
      );
      break;
    }
    case 'running': {
      const { done, total, phase, current } = state.progress;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      title = t('migration.runningTitle');
      body = (
        <div class="stack" data-testid="v2-migrate-progress" data-phase={phase}>
          <p role="status">
            {phase === 'uploading' ? t('migration.phaseUploading') : t('migration.phaseSaving')}
          </p>
          <div
            class="meter"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={t('migration.progressLabel')}
          >
            <div class="meter__fill" style={{ inlineSize: `${pct}%` }} />
          </div>
          <p class="muted">
            {t('migration.progressCount', { done: fmt.number(done), total: fmt.number(total) })}
            {current ? (
              <>
                {' · '}
                <bdi>{current}</bdi>
              </>
            ) : null}
          </p>
          <p class="muted">{t('migration.runningHint')}</p>
        </div>
      );
      footer = (
        <Button variant="ghost" onClick={closeMigration} testId="v2-migrate-hide">
          {t('migration.hide')}
        </Button>
      );
      break;
    }
    case 'report':
      title = t('migration.reportTitle');
      body = <ReportView report={state.report} />;
      footer = (
        <>
          {!state.report.push.done && (
            <Button
              onClick={() => void refreshReport({ sync: true })}
              disabled={!status.online}
              testId="v2-migrate-sync"
            >
              {t('migration.syncNow')}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => {
              closeMigration();
              navigate('/projects');
            }}
            testId="v2-migrate-open-projects"
          >
            {t('migration.openDrafts')}
          </Button>
          <Button variant="ghost" onClick={closeMigration} testId="v2-migrate-close">
            {t('migration.close')}
          </Button>
        </>
      );
      break;
    case 'error':
      title = t('migration.errorTitle');
      body = (
        <p role="alert" data-testid="v2-migrate-error" data-code={state.code}>
          {flowErrorText(state.code)}
        </p>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={closeMigration}>
            {t('migration.close')}
          </Button>
          <Button
            variant="primary"
            onClick={retryMigration}
            disabled={!migrationDeps().online() && state.code === 'reference_missing'}
            testId="v2-migrate-retry"
          >
            {t('migration.retry')}
          </Button>
        </>
      );
      break;
  }

  return (
    <Modal
      open={open}
      title={title}
      onClose={closeMigration}
      confirmClose={running ? confirmClose : undefined}
      size="lg"
      testId="v2-migrate-dialog"
      footer={footer}
    >
      {body}
    </Modal>
  );
}
