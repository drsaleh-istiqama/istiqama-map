/**
 * Files one same-name suggestion of a v2 migration as `request_person_merge` (people-admin
 * contract §4): a reviewer decides, nothing is merged here (brief §2.4, §10). Shared by the
 * runner's runtime and by the background completion of runs (finalize.ts).
 */
import { t } from '../i18n';
import { toSyncError, transport } from '../sync';

/**
 * Resolves true when the request is filed (or the server refuses it for good: forbidden,
 * not found, already merged…), false when it should be tried again after a later sync.
 */
export async function fileMergeSuggestion(
  sourceId: string,
  targetId: string,
  name: string,
): Promise<boolean> {
  try {
    await transport.rpc('request_person_merge', {
      p_source: sourceId,
      p_target: targetId,
      p_reason: t('migration.mergeReason', { name }),
    });
    return true;
  } catch (e) {
    const err = toSyncError(e);
    return !(err.retryable || err.fatalForSession || err.kind === 'aborted');
  }
}
