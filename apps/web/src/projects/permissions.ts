/**
 * What the signed-in user may do with a project, mirrored from the server rules
 * (docs/contracts/sync.md §1 role classes + §4.3 workflow rules). These checks only hide or
 * show actions — the server enforces them (a forbidden push comes back `rejected`).
 */
import { can, me, session } from '../auth';
import type { RecordState, Row } from '../db';

export interface Actor {
  userId: string | null;
  write: boolean;
  review: boolean;
  seePeople: boolean;
  seeRestricted: boolean;
}

export const NO_ACTOR: Readonly<Actor> = Object.freeze({
  userId: null,
  write: false,
  review: false,
  seePeople: false,
  seeRestricted: false,
});

/** The current user's capabilities (reading the signals subscribes the calling component). */
export function currentActor(): Actor {
  return {
    userId: me.value?.user_id ?? session.value?.user?.id ?? null,
    write: can.write.value,
    review: can.review.value,
    seePeople: can.seePeople.value,
    seeRestricted: can.seeRestricted.value,
  };
}

type ProjectLike = Pick<Row<'projects'>, 'created_by' | 'record_state'>;
type OwnedRow = Pick<Row<'project_maintenance'>, 'created_by'>;

const isCreator = (row: { created_by: string | null }, actor: Actor): boolean =>
  actor.userId !== null && row.created_by === actor.userId;

/** Project update class `creator`: the creator (with write scope) or a reviewer in scope. */
export function canEditProject(project: ProjectLike, actor: Actor): boolean {
  return actor.write && (actor.review || isCreator(project, actor));
}

/**
 * Delete: a reviewer in any state; a creator without review rights only while the record is
 * `draft` or `returned` (sync.md §4.3).
 */
export function canDeleteProject(project: ProjectLike, actor: Actor): boolean {
  if (!actor.write) return false;
  if (actor.review) return true;
  return (
    isCreator(project, actor) &&
    (project.record_state === 'draft' || project.record_state === 'returned')
  );
}

const APPROVE_FROM: readonly RecordState[] = ['draft', 'submitted', 'returned'];
const RETURN_FROM: readonly RecordState[] = ['submitted', 'approved'];

export function canApprove(project: ProjectLike, actor: Actor): boolean {
  return actor.review && APPROVE_FROM.includes(project.record_state);
}

export function canReturn(project: ProjectLike, actor: Actor): boolean {
  return actor.review && RETURN_FROM.includes(project.record_state);
}

/** "Submit for review": the creator of a draft / returned record that has a location. */
export function canSubmit(
  project: ProjectLike & Pick<Row<'projects'>, 'lon' | 'lat'>,
  actor: Actor,
): boolean {
  return (
    canEditProject(project, actor) &&
    (project.record_state === 'draft' || project.record_state === 'returned') &&
    typeof project.lon === 'number' &&
    typeof project.lat === 'number'
  );
}

/** Maintenance insert class `writer`. */
export function canAddMaintenance(actor: Actor): boolean {
  return actor.write;
}

/** Maintenance update class `creator`: the creator of the entry or a reviewer. */
export function canChangeMaintenance(entry: OwnedRow, actor: Actor): boolean {
  return actor.write && (actor.review || isCreator(entry, actor));
}
