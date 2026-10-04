import { useEffect, useState } from 'preact/hooks';
import { fmt, hasTranslation, t } from '../i18n';
import { syncNow, syncStatus } from '../sync';
import { IconAlert, IconOffline, IconOnline, IconPhoto, IconSync, IconUpload } from './icons';
import { Spinner } from './Spinner';

export type SyncBadgeState = 'offline' | 'syncing' | 'error' | 'ok';

type Status = typeof syncStatus.value;

export function syncBadgeState(status: Pick<Status, 'online' | 'state'>): SyncBadgeState {
  if (!status.online) return 'offline';
  if (status.state === 'pushing' || status.state === 'pulling') return 'syncing';
  if (status.state === 'error') return 'error';
  return 'ok';
}

function stateLabel(status: Status, state: SyncBadgeState): string {
  switch (state) {
    case 'offline':
      return t('ui.syncOffline');
    case 'syncing':
      return status.state === 'pushing' ? t('ui.syncPushing') : t('ui.syncPulling');
    case 'error':
      // The sync engine reports a translation key; fall back to a generic message.
      return status.lastError && hasTranslation(status.lastError)
        ? t(status.lastError)
        : t('ui.syncError');
    default:
      return t('ui.syncOnline');
  }
}

/** Re-render every `ms` so "2 minutes ago" stays true. */
function useTick(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

/**
 * Permanent sync indicator (brief §4.5): online / offline, pending operations, pending
 * photos, time of the last successful sync and a "sync now" button. Always in the shell.
 */
export function SyncBadge() {
  useTick(30_000);
  const status = syncStatus.value;
  const state = syncBadgeState(status);
  const busy = state === 'syncing';
  const lastSync =
    status.lastSyncAt == null
      ? t('ui.syncNever')
      : t('ui.syncLast', { time: fmt.relative(new Date(status.lastSyncAt)) });

  return (
    <div class={`sync sync--${state}`} data-testid="sync-badge" data-state={state}>
      <span class="sync__state" role="status" aria-live="polite" title={lastSync}>
        {state === 'offline' ? (
          <IconOffline size={20} />
        ) : state === 'error' ? (
          <IconAlert size={20} />
        ) : busy ? (
          <Spinner size={18} />
        ) : (
          <IconOnline size={20} />
        )}
        <span class="sync__label">{stateLabel(status, state)}</span>
        <span class="sync__detail">{lastSync}</span>
      </span>

      <span class="sync__count" title={t('ui.syncPendingOps', { count: status.pendingOps })}>
        <IconUpload size={18} />
        <span data-testid="sync-pending-ops" aria-hidden="true">
          {status.pendingOps}
        </span>
        <span class="sr-only">{t('ui.syncPendingOps', { count: status.pendingOps })}</span>
      </span>

      <span class="sync__count" title={t('ui.syncPendingPhotos', { count: status.pendingPhotos })}>
        <IconPhoto size={18} />
        <span data-testid="sync-pending-photos" aria-hidden="true">
          {status.pendingPhotos}
        </span>
        <span class="sr-only">{t('ui.syncPendingPhotos', { count: status.pendingPhotos })}</span>
      </span>

      {status.failedOps > 0 && (
        <span
          class="sync__count sync__count--failed"
          title={t('ui.syncFailedOps', { count: status.failedOps })}
        >
          <IconAlert size={18} />
          <span data-testid="sync-failed-ops" aria-hidden="true">
            {status.failedOps}
          </span>
          <span class="sr-only">{t('ui.syncFailedOps', { count: status.failedOps })}</span>
        </span>
      )}

      <button
        type="button"
        class="icon-btn sync__now"
        data-testid="sync-now"
        aria-label={t('ui.syncNow')}
        title={t('ui.syncNow')}
        disabled={!status.online || busy}
        onClick={() => {
          // Failures are reported through syncStatus (state "error"), not thrown at the user.
          syncNow().catch(() => undefined);
        }}
      >
        <IconSync size={20} />
      </button>
    </div>
  );
}
