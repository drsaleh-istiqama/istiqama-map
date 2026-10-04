/**
 * Public API of the local database (docs/contracts/web.md §3.4). Other modules import from
 * `src/db` only — never from the files behind it.
 */

// --- schema, row types, registry -------------------------------------------------------
export { db, DB_NAME, SCHEMA, SCHEMA_VERSION, IstiqamaDexie } from './dexie';
export type {
  DeleteSnapshot,
  DraftRecord,
  FailedOp,
  MetaRecord,
  OutboxOp,
  PackRecord,
  PhotoBlobKind,
  PhotoBlobRecord,
  RestrictedLocalRecord,
  SchemaStep,
} from './dexie';
export * from './types';
export {
  SYNC_TABLES,
  TABLE_NAMES,
  TABLE_COLUMNS,
  STD_COLUMNS,
  STD_SERVER_COLUMNS,
  CLIENT_INSERT_COLUMNS,
  RESTRICTED_TABLES,
  PROJECT_CHILD_TABLES,
  COMPLETENESS_CHILD_TABLES,
  canPush,
  isRestrictedTable,
  isTableName,
  tableDef,
  wireColumns,
  writableColumns,
} from './tables';
export type { Audience, PushClass, ScopeKind, SyncTableDef } from './tables';

// --- write path ------------------------------------------------------------------------
export { mutate, softDelete, newRow, DbError, opsForRow, failedOpsForRow } from './write';
export type { DbErrorCode } from './write';

// --- sync engine helpers ---------------------------------------------------------------
export {
  ackOp,
  clearConflictFlag,
  discardFailedOp,
  listFailedOps,
  markInflight,
  pendingOps,
  queueCounts,
  rebaseQueuedOps,
  requeueInflight,
  retryFailedOps,
  toPushOp,
} from './ack';
export type { AckOutcome, QueueCounts } from './ack';
export { applyPage, applyServerRows, resetScopedData, wipeAllLocalData } from './apply';
export type { ApplyStats, PullPageInput, ResetSummary } from './apply';
export { syncPort, watchQueues } from './syncPort';
export type { SyncOp, SyncPort } from './syncPort';

// --- photos ----------------------------------------------------------------------------
export {
  dropPhotoBlob,
  dropPhotoBlobs,
  photoBlob,
  photoBlobBytes,
  pruneOrphanPhotoBlobs,
  putPhotoBlob,
} from './blobs';

// --- queries ---------------------------------------------------------------------------
export { loadProjectBundle, saveProjectBundle, publicRow } from './bundle';
export type { ProjectBundle } from './bundle';
export {
  badgeCounts,
  listIncompleteProjects,
  listOpenMaintenance,
  listPersons,
  listProjects,
  projectsInBounds,
} from './list';
export type {
  BadgeCounts,
  ListCursor,
  MaintenanceCursor,
  MaintenanceListItem,
  PersonCursor,
  ProjectFilter,
  ProjectListItem,
  ProjectPage,
  ProjectSort,
} from './list';
export { searchLocal } from './search';
export type { SearchHit, SearchKind, SearchProjectRef } from './search';
export {
  findLocalDuplicates,
  findLocalPersonCandidates,
  normalizePhone,
  SAME_VILLAGE_RADIUS_M,
} from './match';
export type { DuplicateHit, PersonCandidate } from './match';

// --- key/value -------------------------------------------------------------------------
export {
  DEFAULT_SETTINGS,
  deleteMeta,
  drafts,
  getAppSetting,
  getLocalSession,
  getMeta,
  getNumberSetting,
  listMeta,
  saveAppSettings,
  setLocalSession,
  setMeta,
  updateMeta,
} from './meta';
export type { LocalSession } from './meta';
