/**
 * First-run offer (brief §10): on a device whose localStorage still holds the v2 keys
 * (`istiqama-projects-v2` / `istiqama-people-v1`), a signed-in user who may write is offered
 * to upload that data to his account as DRAFTS for review (`v2-migrate-accept`). "Later"
 * hides the offer for a day; it stays available in Settings and on the import page (where
 * this card is not shown, so the test id stays unique).
 *
 * Mounted by the shell on every screen through `LazySlot`:
 *   <LazySlot load={() => import('../../migration/V2MigrationPrompt').then((m) => m.default)} />
 * Light on purpose: the dialog, the runner and the photo pipeline load only on "accept".
 * After every sync it also completes, in the background, runs whose upload was pending
 * (the v2 keys are removed only once the server acknowledged everything).
 */
import { useEffect, useMemo } from 'preact/hooks';
import { can, session } from '../auth';
import { fmt, t } from '../i18n';
import { getPref, setPref } from '../lib/prefs';
import { useRoute } from '../routes';
import { syncStatus } from '../sync';
import { Button, toast } from '../ui';
import { flow, flowHidden, type MigrationInput } from './flowState';
import { deviceHasV2Keys, deviceV2Summary, v2Changed } from './local';
import './migration.css';

export const SNOOZE_PREF = 'migration.v2PromptSnooze';
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

interface Snooze {
  fingerprint: string;
  until: number;
}

function snoozed(fingerprint: string): boolean {
  const s = getPref<Snooze | null>(SNOOZE_PREF, null);
  return !!s && s.fingerprint === fingerprint && s.until > Date.now();
}

/** Routes that show the full migration panel themselves. */
const PANEL_ROUTES = /^\/(import|settings)(\/|$)/;

async function openFlow(input: MigrationInput): Promise<void> {
  try {
    const controller = await import('./controller');
    await controller.openMigration(input);
  } catch {
    toast(t('migration.error_unknown'), 'error');
  }
}

async function showFlow(): Promise<void> {
  const controller = await import('./controller');
  controller.showMigration();
}

export default function V2MigrationPrompt() {
  const route = useRoute();
  const signedIn = Boolean(session.value);
  const writer = can.write.value;
  const tick = v2Changed.value;
  const status = syncStatus.value;
  const state = flow.value;
  const hidden = flowHidden.value;
  // Parsed once per change of the migration state (the values may be large).
  const summary = useMemo(
    () => (signedIn && writer ? deviceV2Summary() : null),
    [signedIn, writer, tick],
  );

  // Background completion of runs waiting for their upload.
  useEffect(() => {
    if (!signedIn || status.lastSyncAt === null || !deviceHasV2Keys()) return;
    import('./finalize').then((m) => m.finalizePendingRuns()).catch(() => undefined);
  }, [signedIn, status.lastSyncAt]);

  if (!signedIn || !writer) return null;

  // A run hidden by the user keeps going: offer to show it again.
  if (hidden && state.step !== 'closed') {
    return (
      <div
        class="mig-prompt mig-prompt--compact"
        role="region"
        aria-label={t('migration.dialogTitle')}
        data-testid="v2-migrate-prompt"
      >
        <span>
          {state.step === 'running' ? t('migration.runningTitle') : t('migration.dialogTitle')}
        </span>
        <Button
          size="sm"
          variant="primary"
          onClick={() => void showFlow()}
          testId="v2-migrate-show"
        >
          {t('migration.show')}
        </Button>
      </div>
    );
  }

  if (!summary || state.step !== 'closed') return null;
  if (PANEL_ROUTES.test(route.path ?? '')) return null;
  if (snoozed(summary.fingerprint)) return null;

  const later = (): void => {
    setPref<Snooze>(SNOOZE_PREF, {
      fingerprint: summary.fingerprint,
      until: Date.now() + SNOOZE_MS,
    });
    toast(t('migration.laterToast'), 'info');
    v2Changed.value++;
  };

  return (
    <section class="mig-prompt" aria-labelledby="mig-prompt-title" data-testid="v2-migrate-prompt">
      <h2 id="mig-prompt-title" class="mig-prompt__title">
        {t('migration.promptTitle')}
      </h2>
      <p>
        {t('migration.localFound', {
          projects: fmt.number(summary.projects),
          people: fmt.number(summary.people),
        })}
      </p>
      <p class="muted">{t('migration.promptHint')}</p>
      <div class="row">
        <Button
          variant="gold"
          onClick={() => void openFlow({ kind: 'local' })}
          testId="v2-migrate-accept"
        >
          {t('migration.accept')}
        </Button>
        <Button variant="ghost" onClick={later} testId="v2-migrate-later">
          {t('migration.later')}
        </Button>
      </div>
    </section>
  );
}
