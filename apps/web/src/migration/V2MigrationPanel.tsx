/**
 * The v2 migration panel of the settings section and of the import page: the v2 data still
 * on this device (offer to upload it as drafts — `v2-migrate-accept`), a v2 backup file
 * ("نسخة احتياطية", `v2-import-file`), and the runs whose upload is not confirmed yet.
 * The flow itself (summary → progress → report) is the one dialog of controller.ts, loaded on
 * demand.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { can } from '../auth';
import { fmt, t } from '../i18n';
import { syncStatus } from '../sync';
import { Button, toast } from '../ui';
import type { MigrationInput } from './flowState';
import { readErrorText } from './labels';
import { deviceV2Summary, v2Changed } from './local';
import { listRunStates, type RunState } from './state';
import { parseV2Json } from './v2read';
import './migration.css';

async function open(input: MigrationInput): Promise<void> {
  try {
    const controller = await import('./controller');
    await controller.openMigration(input);
  } catch {
    toast(t('migration.error_unknown'), 'error');
  }
}

function runStatus(run: RunState): string {
  if (run.savedAt === null) return t('migration.runInterrupted');
  if (run.pushedAt === null) return t('migration.runWaitingUpload');
  if (run.source === 'v2_local' && run.keysRemovedAt === null) return t('migration.runWaitingKeys');
  return t('migration.runDone');
}

export function V2MigrationPanel() {
  const writer = can.write.value;
  const tick = v2Changed.value;
  const lastSync = syncStatus.value.lastSyncAt;
  const local = deviceV2Summary();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [runs, setRuns] = useState<RunState[]>([]);

  useEffect(() => {
    let alive = true;
    listRunStates()
      .then((all) => {
        if (alive) setRuns(all.slice(0, 5));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tick, lastSync]);

  const chooseFile = async (event: Event): Promise<void> => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    setFileError(null);
    if (!file) return;
    setReading(true);
    try {
      const text = await file.text();
      const result = parseV2Json(text, file.name);
      if (!result.ok) {
        setFileError(readErrorText(result.error));
        return;
      }
      await open({ kind: 'file', data: result.data });
    } catch {
      setFileError(t('migration.read_unreadable'));
    } finally {
      setReading(false);
      input.value = '';
    }
  };

  const check = async (): Promise<void> => {
    const { finalizePendingRuns } = await import('./finalize');
    const done = await finalizePendingRuns();
    toast(
      done > 0 ? t('migration.checkDone') : t('migration.checkWaiting'),
      done > 0 ? 'success' : 'info',
    );
  };

  return (
    <div class="mig-panel stack" data-testid="v2-migration-panel" data-tick={tick}>
      <p class="muted">{t('migration.panelIntro')}</p>

      {local && (
        <div class="mig-local" data-testid="v2-local-offer">
          <p>
            {t('migration.localFound', {
              projects: fmt.number(local.projects),
              people: fmt.number(local.people),
            })}
          </p>
          {writer ? (
            <Button
              variant="gold"
              onClick={() => void open({ kind: 'local' })}
              testId="v2-migrate-accept"
            >
              {t('migration.accept')}
            </Button>
          ) : (
            <p class="muted">{t('migration.noWriteAccess')}</p>
          )}
        </div>
      )}
      {!local && (
        <p class="muted" data-testid="v2-local-none">
          {t('migration.localNone')}
        </p>
      )}

      <div class="field">
        <label class="field__label" for="mig-file">
          {t('migration.fileLabel')}
        </label>
        <input
          ref={fileInput}
          id="mig-file"
          class="control"
          type="file"
          accept="application/json,.json"
          onChange={(e) => void chooseFile(e)}
          disabled={!writer || reading}
          aria-describedby={fileError ? 'mig-file-hint mig-file-error' : 'mig-file-hint'}
          aria-invalid={fileError ? 'true' : undefined}
          data-testid="v2-import-file"
        />
        <p class="field__hint" id="mig-file-hint">
          {t('migration.fileHint')}
        </p>
        {fileError && (
          <p
            class="field__error"
            id="mig-file-error"
            role="alert"
            data-testid="v2-import-file-error"
          >
            {fileError}
          </p>
        )}
      </div>

      {runs.length > 0 && (
        <div class="mig-runs">
          <h3>{t('migration.runsTitle')}</h3>
          <ul>
            {runs.map((run) => (
              <li key={`${run.source}:${run.fingerprint}`} data-testid="v2-run">
                <bdi>{run.fileName ?? t('migration.thisDevice')}</bdi> ·{' '}
                {fmt.dateTime(new Date(run.startedAt))} ·{' '}
                {t('migration.runProjects', {
                  count: fmt.number(Object.keys(run.projects).length),
                })}{' '}
                — <span>{runStatus(run)}</span>
              </li>
            ))}
          </ul>
          {runs.some(
            (r) =>
              r.savedAt !== null &&
              (r.pushedAt === null || (r.source === 'v2_local' && r.keysRemovedAt === null)),
          ) && (
            <Button size="sm" onClick={() => void check()} testId="v2-runs-check">
              {t('migration.checkUpload')}
            </Button>
          )}
        </div>
      )}
      <p class="muted mig-small">{t('migration.noReplaceNote')}</p>
    </div>
  );
}
