/**
 * The signed-in user's notifications, from the synced `notifications` rows (sync.md §3: own
 * rows only; only `read_at` is writable). Reading them works offline; "mark read" is an
 * ordinary local write (`mutate`) that the sync engine pushes.
 */
import { db, mutate, type Row } from '../db';

export const NOTIFICATIONS_SHOWN = 50;

const live = (n: Row<'notifications'>): boolean => !n.deleted_at;

/** Newest first, at most `limit`. */
export async function listNotifications(
  limit = NOTIFICATIONS_SHOWN,
): Promise<Row<'notifications'>[]> {
  const rows = await db.notifications
    .orderBy('created_at')
    .reverse()
    .limit(limit * 2)
    .toArray();
  return rows.filter(live).slice(0, limit);
}

export async function unreadCount(): Promise<number> {
  const rows = await db.notifications.where('_unread').equals(1).toArray();
  return rows.filter(live).length;
}

export async function markRead(id: string, now = new Date()): Promise<void> {
  const row = await db.notifications.get(id);
  if (!row || row.read_at) return;
  await mutate('notifications', id, { read_at: now.toISOString() });
}

export async function markAllRead(now = new Date()): Promise<number> {
  const rows = (await db.notifications.where('_unread').equals(1).toArray()).filter(live);
  for (const row of rows) await mutate('notifications', row.id, { read_at: now.toISOString() });
  return rows.length;
}
