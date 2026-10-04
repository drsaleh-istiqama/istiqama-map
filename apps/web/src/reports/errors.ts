/** User-facing text for a failed report / export call. */
import { t } from '../i18n';
import { errorKey, isSyncError } from '../sync';
import { ReportsApiError } from './api';

export function reportErrorText(error: unknown): string {
  if (isSyncError(error)) {
    if (error.kind === 'forbidden') return t('reports.errorForbidden');
    if (error.kind === 'not_found') return t('reports.errorNotFound');
    if (error.kind === 'rate_limited') return t('reports.errorRateLimited');
    return t(errorKey(error));
  }
  if (error instanceof ReportsApiError) {
    if (/^PT429$|rate/i.test(error.code) || /rate.?limit/i.test(error.message))
      return t('reports.errorRateLimited');
    if (/^PT403$|^42501$/.test(error.code)) return t('reports.errorForbidden');
    if (/^PT404$|^PGRST116$/.test(error.code)) return t('reports.errorNotFound');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    return t('reports.offlineShort');
  return t('reports.errorGeneric');
}
