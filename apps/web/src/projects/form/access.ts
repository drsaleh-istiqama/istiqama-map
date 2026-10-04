/**
 * What the signed-in user may do in the form. Only hides or shows controls — the server
 * enforces the rules (a forbidden push comes back `rejected`).
 */
import { can, me, session } from '../../auth';
import type { Row } from '../../db';

export interface FormAccess {
  userId: string | null;
  fullName: string | null;
  /** Create projects / edit own ones (writer). */
  write: boolean;
  /** Reviewer in scope (branch supervisor, country manager, HQ). */
  review: boolean;
  /**
   * May enter restricted data (salaries, sensitive community data). Every writer may write
   * restricted rows — blind for those who cannot read them (sync.md §4.4) — so this follows
   * the write capability; viewers never see these fields.
   */
  restrictedWrite: boolean;
  /** Reads restricted data (country manager / HQ at aal2): stored values are shown. */
  restrictedRead: boolean;
  /** Write scope branches and countries (defaults for a new project). */
  branches: string[];
  countries: string[];
}

/** Reading the signals subscribes the calling component. */
export function formAccess(): FormAccess {
  const ctx = me.value;
  const write = can.write.value;
  return {
    userId: ctx?.user_id ?? session.value?.user?.id ?? null,
    fullName: ctx?.profile?.full_name ?? null,
    write,
    review: can.review.value,
    restrictedWrite: write,
    restrictedRead: can.seeRestricted.value,
    branches: ctx?.scopes?.write?.branches ?? [],
    countries: ctx?.scopes?.write?.countries ?? [],
  };
}

/**
 * Did this user create the record? A row created on this device and not acknowledged yet
 * (`version` 0) whose `created_by` is still empty counts as the current user's: the server
 * stamps the real creator when the insert is pushed.
 */
export function isMine(
  project: Pick<Row<'projects'>, 'created_by' | 'version'>,
  access: Pick<FormAccess, 'userId'>,
): boolean {
  if (access.userId !== null && project.created_by === access.userId) return true;
  return (project.created_by === null || project.created_by === undefined) && project.version === 0;
}

/** May this user edit this project at all (creator with write scope, or a reviewer)? */
export function canEdit(
  project: Pick<Row<'projects'>, 'created_by' | 'version'>,
  access: FormAccess,
): boolean {
  if (!access.write) return false;
  return access.review || isMine(project, access);
}
