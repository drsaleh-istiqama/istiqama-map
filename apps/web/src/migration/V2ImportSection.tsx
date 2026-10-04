/**
 * Settings section "data of the previous version" (brief §10). Replaces the placeholder of
 * src/settings/SettingsPage.tsx — keep its <section> test id:
 *
 *   import V2ImportSection from '../migration/V2ImportSection';
 *   …
 *   <V2ImportSection />
 */
import { t } from '../i18n';
import { V2MigrationPanel } from './V2MigrationPanel';

export function V2ImportSection() {
  return (
    <section class="card" aria-labelledby="settings-v2-import" data-testid="settings-v2-import">
      <h2 id="settings-v2-import">{t('migration.sectionTitle')}</h2>
      <V2MigrationPanel />
    </section>
  );
}

export default V2ImportSection;
