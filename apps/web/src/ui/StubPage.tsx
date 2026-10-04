import { t } from '../i18n';
import { EmptyState } from './EmptyState';

/** Placeholder body of a route whose feature module is not built yet. */
export function StubPage({ name }: { name: string }) {
  return (
    <EmptyState
      testId={`stub-${name}`}
      title={t('common.stubTitle')}
      message={t('common.stubBody')}
    />
  );
}
