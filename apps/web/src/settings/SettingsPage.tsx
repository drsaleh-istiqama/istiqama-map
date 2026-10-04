import { t } from '../i18n';
import PacksSection from '../map/PacksSection';
import { AboutSection } from './AboutSection';
import { LanguageSection } from './LanguageSection';
import { SecuritySection } from './SecuritySection';
import { StorageSection } from './StorageSection';
import './settings.css';

/**
 * Settings (route `/settings`): language, storage and Wi-Fi-only uploads, offline map packs,
 * PIN and sign-out, about. The v2 import section is a placeholder the migration team fills in.
 *
 * `PacksSection` (src/map) renders its own `<section data-testid="settings-map-packs">`; it
 * imports only types from `pmtiles`, so it stays inside this lazy route chunk.
 */
export default function SettingsPage() {
  return (
    <div class="page settings" data-testid="settings-page">
      <LanguageSection />
      <StorageSection />

      <PacksSection />

      {/* ============================================================================
          PLACEHOLDER — MIGRATION TEAM: v2 → v3 import (brief §10).
          Replace the paragraph with the migration panel (`v2-migrate-accept`,
          `v2-import-file`). Keep the <section> and its test id.
          ============================================================================ */}
      <section
        class="card card--placeholder"
        aria-labelledby="settings-v2-import"
        data-testid="settings-v2-import"
      >
        <h2 id="settings-v2-import">{t('settings.v2ImportTitle')}</h2>
        <p class="muted">{t('settings.v2ImportPlaceholder')}</p>
      </section>

      <SecuritySection />
      <AboutSection />
    </div>
  );
}
