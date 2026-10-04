import { t } from '../i18n';
import { AboutSection } from './AboutSection';
import { LanguageSection } from './LanguageSection';
import { SecuritySection } from './SecuritySection';
import { StorageSection } from './StorageSection';
import './settings.css';

/**
 * Settings (route `/settings`): language, storage and Wi-Fi-only uploads, PIN and sign-out,
 * about. Two sections are placeholders that other teams fill in.
 */
export default function SettingsPage() {
  return (
    <div class="page settings" data-testid="settings-page">
      <LanguageSection />
      <StorageSection />

      {/* ============================================================================
          PLACEHOLDER — MAP TEAM: offline map packs (brief §4.7).
          Replace the paragraph with the pack manager (list of `map_packs`, size before
          download, progress, delete). Keep the <section> and its test id.
          ============================================================================ */}
      <section
        class="card card--placeholder"
        aria-labelledby="settings-map-packs"
        data-testid="settings-map-packs"
      >
        <h2 id="settings-map-packs">{t('settings.mapPacksTitle')}</h2>
        <p class="muted">{t('settings.mapPacksPlaceholder')}</p>
      </section>

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
