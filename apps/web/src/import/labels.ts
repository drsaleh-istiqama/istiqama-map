/**
 * User-facing texts of the import wizard: issue codes (contract §5 "translate by code"),
 * function / RPC failures, row states. Unknown codes fall back to the server's English text
 * so that a new server code is still readable.
 */
import { t } from '../i18n';
import { errorKey, isSyncError } from '../sync';
import { ImportApiError } from './api';
import type { ImportIssue, TemplateColumn } from './types';

/** `t(key)` or `fallback` when the key has no text in any language. */
export function tOr(
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
): string {
  const s = t(key, params);
  return s === key ? fallback : s;
}

/** Label of a template column (its header in the interface language), else the key. */
export function fieldLabel(field: string | null, columns: readonly TemplateColumn[]): string {
  if (!field) return '';
  return columns.find((c) => c.key === field)?.header ?? field;
}

export function issueText(issue: ImportIssue): string {
  const params: Record<string, string | number> = {};
  if (issue.rowNo !== undefined) params.row = issue.rowNo;
  return tOr(`import.code_${issue.code}`, issue.message || issue.code, params);
}

export function rowStateLabel(state: string): string {
  return tOr(`import.state_${state}`, state);
}

export function batchStateLabel(state: string): string {
  return tOr(`import.batch_${state}`, state);
}

export function sourceKindLabel(kind: string): string {
  return tOr(`import.source_${kind}`, kind);
}

/** Text for a failed import call (upload, preview, set action, commit, rollback, history). */
export function importErrorText(error: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return t('import.offline');
  if (error instanceof ImportApiError) {
    const byMessage = tOr(`import.err_${error.message}`, '');
    if (byMessage) return byMessage;
    if (error.code === 'network') return t('import.err_network');
    if (/^PT429$/.test(error.code) || error.status === 429) return t('import.err_rate_limited');
    if (/^PT403$|^42501$/.test(error.code) || error.status === 403)
      return t('import.err_forbidden');
    if (/^PT404$/.test(error.code) || error.status === 404) return t('import.err_not_found');
    if (/^PT413$/.test(error.code) || error.status === 413) return t('import.err_file_too_large');
    if (/^PT415$/.test(error.code) || error.status === 415)
      return t('import.err_unsupported_file_type');
    return t('import.err_generic');
  }
  if (isSyncError(error)) {
    if (error.kind === 'forbidden') return t('import.err_forbidden');
    if (error.kind === 'not_found') return t('import.err_not_found');
    if (error.kind === 'rate_limited') return t('import.err_rate_limited');
    if (error.kind === 'conflict') return t('import.err_wrong_state');
    if (error.kind === 'invalid') {
      const specific = tOr(`import.err_${error.message}`, '');
      return specific || t('import.err_invalid');
    }
    return t(errorKey(error));
  }
  return t('import.err_generic');
}
