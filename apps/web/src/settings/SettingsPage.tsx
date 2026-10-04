import PacksSection from '../map/PacksSection';
import { V2ImportSection } from '../migration/V2ImportSection';
import { AboutSection } from './AboutSection';
import { LanguageSection } from './LanguageSection';
import { SecuritySection } from './SecuritySection';
import { StorageSection } from './StorageSection';
import './settings.css';

/**
 * Settings (route `/settings`): language, storage and Wi-Fi-only uploads, offline map packs,
 * PIN and sign-out, about, and the v2 → v3 import of src/migration (brief §10).
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

      {/* v2 → v3 import (brief §10): `<section data-testid="settings-v2-import">` */}
      <V2ImportSection />

      <SecuritySection />
      <AboutSection />
    </div>
  );
}
