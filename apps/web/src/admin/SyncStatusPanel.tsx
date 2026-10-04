/**
 * Sync status board (brief §1 "a dashboard of the sync state", people-admin.md §7): per user
 * and device — last seen / push / pull, pending operations and photos, app version, open
 * conflicts, operations rejected in the last 7 days, revoked state. Users needing attention
 * first. Refreshes itself every 60 s while the page is visible (not in a background tab, not
 * offline) and at once when it becomes visible again after a pause.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmt, t } from '../i18n';
import { Badge, Button, EmptyState, IconSync } from '../ui';
import { isOnline, loadSyncStatus } from './api';
import { deviceName, roleLabel } from './labels';
import { Ltr, ResourceState, useResource, When } from './shared';
import {
  deviceAttention,
  needsAttention,
  REFRESH_MS,
  sortByAttention,
  sortDevices,
  userAttention,
  type Attention,
} from './syncStatus';
import type { SyncStatusReport, SyncStatusUser } from './types';

const TONE: Record<Attention, 'danger' | 'warning' | 'info' | 'neutral' | 'success' | 'inactive'> =
  {
    problems: 'danger',
    pending: 'warning',
    stale: 'info',
    blocked: 'inactive',
    ok: 'success',
    no_device: 'neutral',
  };

/** Re-runs `refresh` every `ms` while the document is visible; once more on becoming visible. */
export function useVisibleInterval(refresh: () => void, ms: number): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let last = Date.now();
    const visible = (): boolean =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const tick = (): void => {
      if (!visible() || !isOnline()) return;
      last = Date.now();
      latest.current();
    };
    const start = (): void => {
      if (timer === null) timer = setInterval(tick, ms);
    };
    const stop = (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = (): void => {
      if (!visible()) {
        stop();
        return;
      }
      if (Date.now() - last >= ms) tick();
      start();
    };
    if (visible()) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms]);
}

export function SyncStatusPanel() {
  const data = useResource(loadSyncStatus);
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  useVisibleInterval(() => {
    if (!data.loading) void data.reload();
  }, REFRESH_MS);

  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section class="adm-panel" aria-labelledby="adm-sync-title" data-testid="admin-sync">
      <div class="adm-panel__head">
        <h2 id="adm-sync-title">{t('admin.syncTitle')}</h2>
        <Button
          icon={<IconSync size={18} />}
          testId="admin-sync-refresh"
          busy={data.loading && data.data !== null}
          onClick={() => void data.reload()}
        >
          {t('admin.refresh')}
        </Button>
      </div>
      <ResourceState resource={data} testId="admin-sync">
        {(report) => (
          <Board
            report={report}
            onlyAttention={onlyAttention}
            setOnlyAttention={setOnlyAttention}
            open={open}
            toggle={toggle}
          />
        )}
      </ResourceState>
    </section>
  );
}

function Board({
  report,
  onlyAttention,
  setOnlyAttention,
  open,
  toggle,
}: {
  report: SyncStatusReport;
  onlyAttention: boolean;
  setOnlyAttention: (v: boolean) => void;
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}) {
  const s = report.summary;
  const sorted = sortByAttention(report.users ?? []);
  const users = onlyAttention ? sorted.filter(needsAttention) : sorted;
  const tiles: Array<{ key: string; value: number; tone?: 'danger' | 'warning' }> = [
    { key: 'users', value: s.users },
    { key: 'devices', value: s.devices },
    { key: 'stale_devices', value: s.stale_devices, tone: s.stale_devices ? 'warning' : undefined },
    { key: 'pending_ops', value: s.pending_ops, tone: s.pending_ops ? 'warning' : undefined },
    {
      key: 'pending_photos',
      value: s.pending_photos,
      tone: s.pending_photos ? 'warning' : undefined,
    },
    {
      key: 'open_conflicts',
      value: s.open_conflicts,
      tone: s.open_conflicts ? 'danger' : undefined,
    },
    { key: 'rejected_7d', value: s.rejected_7d, tone: s.rejected_7d ? 'danger' : undefined },
    { key: 'users_without_device', value: s.users_without_device },
  ];
  return (
    <>
      <p class="adm-note" role="status" data-testid="admin-sync-generated">
        {report.scope === 'country' ? t('admin.syncScopeCountry') : t('admin.syncScopeAll')}
        {' · '}
        {t('admin.updatedAt', { time: fmt.dateTime(report.generated_at) })}
        {' · '}
        {t('admin.autoRefresh')}
      </p>
      <ul class="adm-tiles" data-testid="admin-sync-summary">
        {tiles.map((tile) => (
          <li
            key={tile.key}
            class={tile.tone ? `adm-tile adm-tile--${tile.tone}` : 'adm-tile'}
            data-testid={`admin-sync-tile-${tile.key}`}
          >
            <span class="adm-tile__value">{fmt.number(tile.value)}</span>
            <span class="adm-tile__label">{t(`admin.tile_${tile.key}`)}</span>
          </li>
        ))}
      </ul>
      <label class="adm-check">
        <input
          type="checkbox"
          data-testid="admin-sync-attention-only"
          checked={onlyAttention}
          onChange={(e) => setOnlyAttention(e.currentTarget.checked)}
        />
        {t('admin.onlyAttention')}
      </label>
      {users.length === 0 ? (
        <EmptyState
          title={onlyAttention ? t('admin.nothingNeedsAttention') : t('admin.noUsers')}
          testId="admin-sync-empty"
        />
      ) : (
        <ul class="adm-sync-list" data-testid="admin-sync-users">
          {users.map((u) => (
            <SyncUserRow
              key={u.user_id}
              user={u}
              open={open.has(u.user_id)}
              onToggle={() => toggle(u.user_id)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function SyncUserRow({
  user,
  open,
  onToggle,
}: {
  user: SyncStatusUser;
  open: boolean;
  onToggle: () => void;
}) {
  const attention = userAttention(user);
  const panelId = `adm-sync-devices-${user.user_id}`;
  const roles = [...new Set((user.roles ?? []).map((r) => r.role))];
  return (
    <li
      class={`adm-sync-user adm-sync-user--${attention}`}
      data-testid="admin-sync-user"
      data-user-id={user.user_id}
      data-attention={attention}
    >
      <button
        type="button"
        class="adm-sync-user__head"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span class="adm-sync-user__name">
          {user.full_name?.trim() || t('admin.unnamedUser')}
          <span class="muted adm-small">{roles.map((r) => roleLabel(r)).join(' · ')}</span>
        </span>
        <span class="adm-sync-user__stats">
          <Badge tone={TONE[attention]}>{t(`admin.attention_${attention}`)}</Badge>
          {user.open_conflicts > 0 && (
            <span class="adm-stat adm-stat--danger">
              {t('admin.statConflicts', { count: user.open_conflicts })}
            </span>
          )}
          {user.rejected_7d > 0 && (
            <span class="adm-stat adm-stat--danger">
              {t('admin.statRejected', { count: user.rejected_7d })}
            </span>
          )}
          {(user.pending_ops > 0 || user.pending_photos > 0) && (
            <span class="adm-stat">
              {t('admin.pendingShort', { ops: user.pending_ops, photos: user.pending_photos })}
            </span>
          )}
          <span class="adm-stat muted">
            {t('admin.lastSeen')}: <When at={user.last_seen_at} />
          </span>
          {!user.active && <Badge tone="danger">{t('admin.statusInactive')}</Badge>}
        </span>
      </button>
      {open && (
        <div id={panelId} class="adm-sync-user__devices">
          {(user.devices ?? []).length === 0 ? (
            <p class="muted">{t('admin.noDevices')}</p>
          ) : (
            <div class="adm-table-wrap">
              <table class="adm-table adm-table--compact" data-testid="admin-sync-devices">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.colDevice')}</th>
                    <th scope="col">{t('admin.appVersion')}</th>
                    <th scope="col">{t('admin.lastSeen')}</th>
                    <th scope="col">{t('admin.lastPush')}</th>
                    <th scope="col">{t('admin.lastPull')}</th>
                    <th scope="col">{t('admin.colPending')}</th>
                    <th scope="col">{t('admin.colConflicts')}</th>
                    <th scope="col">{t('admin.colRejected')}</th>
                    <th scope="col">{t('admin.colState')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortDevices(user.devices).map((d) => {
                    const a = deviceAttention(d);
                    return (
                      <tr key={d.id} data-testid="admin-sync-device" data-attention={a}>
                        <td>
                          <span class="adm-names">
                            <span>{deviceName(d)}</span>
                            <Ltr class="mono muted adm-small">{d.device_id}</Ltr>
                          </span>
                        </td>
                        <td>
                          <Ltr>{d.app_version ?? '—'}</Ltr>
                        </td>
                        <td>
                          <When at={d.last_seen_at} />
                        </td>
                        <td>
                          <When at={d.last_push_at} />
                        </td>
                        <td>
                          <When at={d.last_pull_at} />
                        </td>
                        <td>
                          {t('admin.pendingShort', {
                            ops: d.pending_ops,
                            photos: d.pending_photos,
                          })}
                        </td>
                        <td>{fmt.number(d.open_conflicts)}</td>
                        <td>{fmt.number(d.rejected_7d)}</td>
                        <td>
                          {d.revoked_at ? (
                            <Badge tone="danger">{t('admin.deviceRevoked')}</Badge>
                          ) : d.stale ? (
                            <Badge tone="info">{t('admin.attention_stale')}</Badge>
                          ) : (
                            <Badge tone={TONE[a]}>{t(`admin.attention_${a}`)}</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
