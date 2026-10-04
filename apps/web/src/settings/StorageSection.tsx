import { useEffect, useState } from 'preact/hooks';
import { fmt, t } from '../i18n';
import { getPref, setPref } from '../lib/prefs';
import { syncStatus } from '../sync';
import { WIFI_ONLY_PREF_KEY } from '../sync/network';
import { storageEstimate, type StorageInfo } from '../sync/storage';
import { Button, Spinner } from '../ui';

/** Device storage (brief §4.6) and the "upload photos on Wi-Fi only" switch (brief §4.4). */
export function StorageSection() {
  const [info, setInfo] = useState<StorageInfo | null | undefined>(undefined);
  const [wifiOnly, setWifiOnly] = useState<boolean>(() => getPref(WIFI_ONLY_PREF_KEY, false));
  const status = syncStatus.value;

  const refresh = (): void => {
    setInfo(undefined);
    storageEstimate()
      .then((result) => setInfo(result))
      .catch(() => setInfo(null));
  };
  useEffect(refresh, []);

  const toggleWifiOnly = (checked: boolean): void => {
    setWifiOnly(checked);
    setPref(WIFI_ONLY_PREF_KEY, checked);
  };

  return (
    <section class="card" aria-labelledby="settings-storage">
      <h2 id="settings-storage">{t('settings.storageTitle')}</h2>
      <div class="stack">
        {info === undefined ? (
          <Spinner size={20} label={t('ui.loading')} />
        ) : info === null ? (
          <p class="muted" data-testid="storage-unavailable">
            {t('settings.storageUnavailable')}
          </p>
        ) : (
          <div data-testid="storage-usage">
            <p>
              {t('settings.storageUsed', {
                used: fmt.bytes(info.usage),
                quota: fmt.bytes(info.quota),
              })}
            </p>
            <div
              class="meter"
              role="progressbar"
              aria-label={t('settings.storageTitle')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(info.percentUsed)}
            >
              <div
                class="meter__fill"
                style={{ inlineSize: `${Math.max(1, info.percentUsed)}%` }}
              />
            </div>
            <p class="field__hint">
              {info.persisted ? t('settings.storagePersisted') : t('settings.storageNotPersisted')}
            </p>
          </div>
        )}

        <dl class="kv">
          <dt>{t('settings.pendingOps')}</dt>
          <dd data-testid="settings-pending-ops">{fmt.number(status.pendingOps)}</dd>
          <dt>{t('settings.pendingPhotos')}</dt>
          <dd data-testid="settings-pending-photos">{fmt.number(status.pendingPhotos)}</dd>
        </dl>

        <Button size="sm" testId="storage-refresh" onClick={refresh}>
          {t('settings.storageRefresh')}
        </Button>

        <label class="switch">
          <span>
            <strong>{t('settings.wifiOnlyLabel')}</strong>
            <span class="field__hint" id="wifi-only-hint">
              {' '}
              {t('settings.wifiOnlyHint')}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={wifiOnly}
            aria-describedby="wifi-only-hint"
            data-testid="wifi-only"
            onChange={(event) => toggleWifiOnly(event.currentTarget.checked)}
          />
        </label>
      </div>
    </section>
  );
}
