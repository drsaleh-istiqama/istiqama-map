/**
 * Offline map packs in Settings (brief §4.7): the packs published in `map_packs`, their size
 * BEFORE downloading, download with progress (pause / resume), integrity check, delete, and
 * the storage they use. Mount it in src/settings/SettingsPage.tsx in place of the
 * "map packs" placeholder section (it renders its own `<section data-testid="settings-map-packs">`).
 */
import { useEffect, useState } from 'preact/hooks';
import { db, type MapPackRow } from '../db';
import { fmt, pickName, t } from '../i18n';
import { syncStatus } from '../sync';
import { Badge, Button, confirm, Spinner, toast, useLiveQuery, type BadgeTone } from '../ui';
import { PackError, type LocalPackRecord, type PackProgress, type PackStatus } from './packs';
import { packManager } from './packsRuntime';
import { availablePacks } from './queries';
import './map.css';

const STATUS_TONE: Record<PackStatus, BadgeTone> = {
  available: 'neutral',
  partial: 'warning',
  installed: 'success',
  update: 'info',
};

function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
}

interface PackItemProps {
  row: MapPackRow;
  record: LocalPackRecord | undefined;
  progress: PackProgress | undefined;
  online: boolean;
}

function PackItem({ row, record, progress, online }: PackItemProps) {
  const manager = packManager();
  const status = manager.status(row, record);
  const running = progress?.phase === 'downloading' || progress?.phase === 'verifying';
  const total = Number(row.bytes);
  const done = progress?.done ?? record?.bytesDone ?? 0;
  const name = pickName(row);
  const testId = `map-pack-${row.code}`;

  const start = async (): Promise<void> => {
    try {
      await manager.download(row);
      if (manager.progress.peek()[row.code] === undefined)
        toast(t('map.packInstalled', { name }), 'success');
    } catch (error) {
      const code = error instanceof PackError ? error.code : 'network';
      toast(t(`map.packError_${code}`), 'error');
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('map.packDeleteTitle'),
      message: t('map.packDeleteBody', { name, size: fmt.bytes(record?.bytesDone ?? total) }),
      confirmLabel: t('map.packDelete'),
      danger: true,
    });
    if (!ok) return;
    await manager.remove(row.code);
    toast(t('map.packDeleted', { name }), 'success');
  };

  return (
    <li class="pack" data-testid={testId} data-status={status}>
      <div class="pack__head">
        <span class="pack__name">{name}</span>
        <Badge tone={STATUS_TONE[status]} testId={`${testId}-status`}>
          {t(`map.packStatus_${status}`)}
        </Badge>
      </div>
      <p class="pack__meta">
        {t('map.packSize', { size: fmt.bytes(total) })}
        {row.min_zoom !== null && row.max_zoom !== null && (
          <> · {t('map.packZoom', { min: row.min_zoom, max: row.max_zoom })}</>
        )}
        {row.tiles_version && (
          <>
            {' · '}
            <bdi dir="ltr" class="ltr">
              {row.tiles_version}
            </bdi>
          </>
        )}
      </p>

      {(running || status === 'partial' || progress) && (
        <div>
          <div
            class="meter"
            role="progressbar"
            aria-label={t('map.packProgress', { name })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent(done, total)}
            data-testid={`${testId}-progress`}
          >
            <div
              class="meter__fill"
              style={{ inlineSize: `${Math.max(1, percent(done, total))}%` }}
            />
          </div>
          <p class="field__hint" aria-live="polite">
            {progress?.phase === 'verifying'
              ? t('map.packVerifying')
              : t('map.packProgressText', {
                  done: fmt.bytes(done),
                  total: fmt.bytes(total),
                  percent: percent(done, total),
                })}
          </p>
        </div>
      )}
      {progress?.phase === 'failed' && progress.error && (
        <p class="pack__error" role="alert">
          {t(`map.packError_${progress.error}`)}
        </p>
      )}

      <div class="pack__actions">
        {running ? (
          <Button
            size="sm"
            testId={`${testId}-pause`}
            disabled={progress?.phase === 'verifying'}
            onClick={() => manager.pause(row.code)}
          >
            {progress?.phase === 'verifying' ? <Spinner size={16} /> : null}
            {t('map.packPause')}
          </Button>
        ) : status === 'installed' ? null : (
          <Button
            size="sm"
            variant="primary"
            testId={`${testId}-download`}
            disabled={!online}
            onClick={() => void start()}
          >
            {status === 'partial'
              ? t('map.packResume')
              : status === 'update'
                ? t('map.packUpdate', { size: fmt.bytes(total) })
                : t('map.packDownload', { size: fmt.bytes(total) })}
          </Button>
        )}
        {record && !running && (
          <Button
            size="sm"
            variant="danger"
            testId={`${testId}-delete`}
            onClick={() => void remove()}
          >
            {t('map.packDelete')}
          </Button>
        )}
      </div>
    </li>
  );
}

/** Offline map packs for the Settings page (default export). */
export function PacksSection() {
  const manager = packManager();
  const rows = useLiveQuery(() => availablePacks(), []);
  const records = useLiveQuery(async () => (await db.packs.toArray()) as LocalPackRecord[], []);
  const progress = manager.progress.value;
  const online = syncStatus.value.online;
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const packsBytes = (records ?? []).reduce((sum, r) => sum + (r.bytesDone || 0), 0);

  useEffect(() => {
    void manager.reconcile().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
    void navigator.storage
      .estimate()
      .then(({ usage: used = 0, quota = 0 }) => setUsage({ used, quota }))
      .catch(() => setUsage(null));
  }, [packsBytes]);

  const byCode = new Map((records ?? []).map((r) => [r.code, r]));

  return (
    <section
      class="card packs"
      aria-labelledby="settings-map-packs"
      data-testid="settings-map-packs"
    >
      <h2 id="settings-map-packs">{t('map.packsTitle')}</h2>
      <div class="stack">
        <p class="muted">{t('map.packsIntro')}</p>
        <p data-testid="map-packs-usage">
          {t('map.packsUsage', { size: fmt.bytes(packsBytes) })}
          {usage && usage.quota > 0 && (
            <>
              {' · '}
              {t('map.packsDevice', { used: fmt.bytes(usage.used), quota: fmt.bytes(usage.quota) })}
            </>
          )}
        </p>
        {!online && <p class="field__hint">{t('map.packsOffline')}</p>}
        {rows === undefined ? (
          <Spinner size={20} label={t('map.loading')} />
        ) : rows.length === 0 ? (
          <p class="muted" data-testid="map-packs-empty">
            {t('map.packsEmpty')}
          </p>
        ) : (
          <ul class="packs__list">
            {rows.map((row) => (
              <PackItem
                key={row.code}
                row={row}
                record={byCode.get(row.code)}
                progress={progress[row.code]}
                online={online}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default PacksSection;
