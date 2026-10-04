/**
 * Notifications menu for the top bar (brief §9.3: "the user receives a notification and a
 * download link"). Mount it in the shell next to the sync badge:
 *
 *   import { NotificationsBell } from '../../reports/NotificationsBell';
 *   <NotificationsBell />
 *
 * It reads the synced `notifications` rows (works offline), shows the unread count, lists the
 * latest notifications, marks them read (`mutate` → pushed by the sync engine) and opens the
 * download of a finished export (a fresh short-lived signed URL, online only). Light on
 * purpose: the download code is loaded on first use.
 */
import { useState } from 'preact/hooks';
import { session } from '../auth';
import type { Row } from '../db';
import { fmt, t } from '../i18n';
import { Button, Modal, toast, useLiveQuery } from '../ui';
import { IconBell } from './icons';
import { listNotifications, markAllRead, markRead, unreadCount } from './notifications';
import { parseExportNotice } from './types';
import './bell.css';

type Notice = Row<'notifications'>;

export function noticeText(n: Notice): string {
  const p = parseExportNotice(n.payload);
  const format = p.format ? t(`reports.format_${p.format === 'xlsx' ? 'xlsx' : 'csv'}`) : '';
  switch (n.kind) {
    case 'export.ready':
      return p.row_count !== null
        ? t('reports.noticeExportReadyRows', { format, rows: fmt.number(p.row_count) })
        : t('reports.noticeExportReady', { format });
    case 'export.failed':
      return t('reports.noticeExportFailed', { format });
    default:
      return t('reports.noticeGeneric');
  }
}

function expired(n: Notice, now = Date.now()): boolean {
  const p = parseExportNotice(n.payload);
  return p.expires_at !== null && Date.parse(p.expires_at) <= now;
}

function NoticeItem({ n }: { n: Notice }) {
  const [busy, setBusy] = useState(false);
  const unread = !n.read_at;
  const ready = n.kind === 'export.ready';
  const p = parseExportNotice(n.payload);
  const canDownload = ready && p.job_id !== null && p.storage_path !== null && !expired(n);

  const download = async (): Promise<void> => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      toast(t('reports.offlineShort'), 'error');
      return;
    }
    setBusy(true);
    try {
      const { downloadExport } = await import('./exportJobs');
      await downloadExport({
        job_id: p.job_id,
        storage_path: p.storage_path,
        file_name: p.file_name,
      });
      await markRead(n.id);
    } catch {
      toast(t('reports.downloadFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      class={`rnotice${unread ? ' rnotice--unread' : ''}`}
      data-testid="notification-item"
      data-kind={n.kind}
      data-unread={unread ? 'true' : 'false'}
    >
      <p class="rnotice__text">
        {unread && <span class="sr-only">{t('reports.unread')} </span>}
        {noticeText(n)}
      </p>
      <p class="rnotice__meta muted">
        {fmt.relative(n.created_at)}
        {ready && p.bytes !== null && <> · {fmt.bytes(p.bytes)}</>}
        {ready && expired(n) && <> · {t('reports.linkExpired')}</>}
      </p>
      <div class="rnotice__actions">
        {canDownload && (
          <Button
            size="sm"
            variant="primary"
            busy={busy}
            onClick={() => void download()}
            testId="notification-download"
          >
            {t('reports.download')}
          </Button>
        )}
        {unread && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void markRead(n.id)}
            testId="notification-read"
          >
            {t('reports.markRead')}
          </Button>
        )}
      </div>
    </li>
  );
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const userId = session.value?.user.id ?? '';
  const count = useLiveQuery(() => unreadCount().catch(() => 0), [userId], 0) ?? 0;
  const items = useLiveQuery(
    () =>
      open ? listNotifications().catch(() => [] as Notice[]) : Promise.resolve([] as Notice[]),
    [open, userId],
    [] as Notice[],
  );
  const label =
    count > 0 ? t('reports.notificationsUnread', { count }) : t('reports.notifications');

  return (
    <>
      <button
        type="button"
        class="icon-btn rbell"
        data-testid="notifications-bell"
        data-unread={count}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen(true)}
      >
        <IconBell size={22} />
        {count > 0 && (
          <span class="rbell__count" data-testid="notifications-count" aria-hidden="true">
            {count > 99 ? '99+' : fmt.number(count)}
          </span>
        )}
      </button>
      <Modal
        open={open}
        title={t('reports.notifications')}
        onClose={() => setOpen(false)}
        size="sm"
        testId="notifications-dialog"
        footer={
          <>
            {count > 0 && (
              <Button
                variant="ghost"
                onClick={() => void markAllRead()}
                testId="notifications-mark-all"
              >
                {t('reports.markAllRead')}
              </Button>
            )}
            <Button onClick={() => setOpen(false)} testId="notifications-close">
              {t('reports.close')}
            </Button>
          </>
        }
      >
        {items && items.length > 0 ? (
          <ul class="rnotices" aria-label={t('reports.notifications')}>
            {items.map((n) => (
              <NoticeItem key={n.id} n={n} />
            ))}
          </ul>
        ) : (
          <p class="muted" data-testid="notifications-empty">
            {t('reports.noNotifications')}
          </p>
        )}
      </Modal>
    </>
  );
}

export default NotificationsBell;
