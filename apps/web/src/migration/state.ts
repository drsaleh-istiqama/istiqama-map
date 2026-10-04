/**
 * Progress of a migration run, kept in the local `meta` store so that an interrupted run
 * (closed tab, crash, lost connection) resumes where it stopped: the same ids for the shared
 * rows (projects, persons, donors, localities), projects already saved are not saved again,
 * photos continue at the next one. The record is written in the SAME transaction as the rows
 * it describes. It stays after the end (small) so that the report can be shown again.
 */
import { getMeta, listMeta, setMeta } from '../db';
import type { V2SourceKind } from './v2types';

export const STATE_PREFIX = 'migration.v2.run:';

export interface ProjectProgress {
  projectId: string;
  name: string;
  /** The bundle is stored on the device. */
  saved: boolean;
  /** Photos handled (added or failed), in plan order. */
  photosDone: number;
  photosTotal: number;
  /** Photos given up for good (not an image, damaged, limit of 10 reached). */
  photosFailed: number;
  /** Plan positions of photos that failed for a passing reason (retried by the next run). */
  retry?: number[];
}

export interface RunState {
  v: 1;
  source: V2SourceKind;
  fingerprint: string;
  userId: string | null;
  fileName?: string;
  startedAt: number;
  updatedAt: number;
  /** Stable ids of shared rows: `project:<key>`, `person:<norm>`, `donor:<norm>`, `locality:<…>`. */
  ids: Record<string, string>;
  /** By project key (`external_id`). */
  projects: Record<string, ProjectProgress>;
  /** Rows created outside a project bundle or shared by several (checked for the push). */
  rows: { persons: string[]; donors: string[]; localities: string[] };
  /** Projects whose save failed (key → message), retried by the next run. */
  failures: Record<string, string>;
  /** Every planned project is stored on the device. */
  savedAt: number | null;
  /** Every queued operation of the migrated rows was acknowledged by the server. */
  pushedAt: number | null;
  /** The v2 localStorage keys were removed (v2_local only). */
  keysRemovedAt: number | null;
  /**
   * Same-name persons of one country the plan proposes to a reviewer (`request_person_merge`
   * after the upload). Absent in runs stored before suggestions existed.
   */
  mergeSuggestions?: Array<{ sourceId: string; targetId: string; name: string }>;
  /** `<source>|<target>` of the suggestions already filed (or refused for good). */
  mergeFiled?: string[];
}

export const stateKey = (source: V2SourceKind, fingerprint: string): string =>
  `${STATE_PREFIX}${source}:${fingerprint}`;

export function newRunState(
  source: V2SourceKind,
  fingerprint: string,
  userId: string | null,
  fileName?: string,
): RunState {
  const now = Date.now();
  return {
    v: 1,
    source,
    fingerprint,
    userId,
    ...(fileName ? { fileName } : {}),
    startedAt: now,
    updatedAt: now,
    ids: {},
    projects: {},
    rows: { persons: [], donors: [], localities: [] },
    failures: {},
    savedAt: null,
    pushedAt: null,
    keysRemovedAt: null,
  };
}

function isRunState(v: unknown): v is RunState {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as RunState).v === 1 &&
    typeof (v as RunState).fingerprint === 'string' &&
    typeof (v as RunState).ids === 'object'
  );
}

export async function loadRunState(
  source: V2SourceKind,
  fingerprint: string,
): Promise<RunState | undefined> {
  const v = await getMeta<unknown>(stateKey(source, fingerprint));
  return isRunState(v) ? v : undefined;
}

export async function saveRunState(state: RunState): Promise<void> {
  state.updatedAt = Date.now();
  await setMeta(stateKey(state.source, state.fingerprint), state);
}

/** Every stored run, newest first. */
export async function listRunStates(): Promise<RunState[]> {
  const all = await listMeta<unknown>(STATE_PREFIX);
  return all
    .map((e) => e.value)
    .filter(isRunState)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Runs that saved everything locally but whose upload was not confirmed yet. */
export async function unfinishedRuns(userId: string | null): Promise<RunState[]> {
  return (await listRunStates()).filter(
    (s) =>
      (s.userId === null || userId === null || s.userId === userId) &&
      (s.savedAt === null ||
        s.pushedAt === null ||
        (s.source === 'v2_local' && s.keysRemovedAt === null) ||
        unfiledSuggestions(s).length > 0),
  );
}

/** Merge suggestions of a run not filed yet. */
export function unfiledSuggestions(
  s: RunState,
): Array<{ sourceId: string; targetId: string; name: string }> {
  const filed = new Set(s.mergeFiled ?? []);
  return (s.mergeSuggestions ?? []).filter((x) => !filed.has(`${x.sourceId}|${x.targetId}`));
}

export function addUnique(list: string[], ids: Iterable<string>): void {
  for (const id of ids) if (!list.includes(id)) list.push(id);
}
