/**
 * Administration console (route `/admin/*`, brief §2.6, §3, §1, §15). Sub-pages are paths
 * inside the same view: `/admin/users[/<id>]`, `/admin/countries`, `/admin/branches`,
 * `/admin/options`, `/admin/fx`, `/admin/settings`, `/admin/packs`, `/admin/sync`.
 *
 * Head office (hq_admin at aal2): everything. Country manager (aal2): the users of the own
 * country (sessions and devices) and the sync status of the country. Anybody else never gets
 * here through the navigation, and the page refuses them as well — the server decides again
 * on every call (RLS, admin RPCs).
 */
import { can } from '../auth';
import { t } from '../i18n';
import { useRoute } from '../routes';
import { EmptyState, IconAdmin, IconOffline, Link } from '../ui';
import { BranchesPanel } from './BranchesPanel';
import { CountriesPanel } from './CountriesPanel';
import { FxPanel } from './FxPanel';
import { MapPacksPanel } from './MapPacksPanel';
import { OptionsPanel } from './OptionsPanel';
import { SettingsPanel } from './SettingsPanel';
import { SyncStatusPanel } from './SyncStatusPanel';
import { UsersPanel } from './UsersPanel';
import { useOnline } from './useOnline';
import './admin.css';

export type AdminTab =
  'users' | 'countries' | 'branches' | 'options' | 'fx' | 'settings' | 'packs' | 'sync';

export const HQ_TABS: readonly AdminTab[] = [
  'users',
  'countries',
  'branches',
  'options',
  'fx',
  'settings',
  'packs',
  'sync',
];
export const MANAGER_TABS: readonly AdminTab[] = ['users', 'sync'];

export function tabsFor(caps: { admin: boolean; manage: boolean }): readonly AdminTab[] {
  if (caps.admin) return HQ_TABS;
  if (caps.manage) return MANAGER_TABS;
  return [];
}

/** `users/0190…` → { tab: 'users', id: '0190…' }; unknown or empty → users. */
export function parseAdminPath(
  rest: string,
  allowed: readonly AdminTab[],
): { tab: AdminTab; id: string | null } {
  const [first, second] = rest.split('/').filter(Boolean);
  const tab = (allowed as readonly string[]).includes(first ?? '') ? (first as AdminTab) : 'users';
  const id =
    tab === 'users' && second && /^[0-9a-f-]{36}$/i.test(second) ? second.toLowerCase() : null;
  return { tab, id };
}

function manageFlag(): boolean {
  // `manage` is an extension of the auth module; read it defensively (contract shape only has `admin`).
  return (can as { manage?: { value: boolean } }).manage?.value ?? false;
}

export default function AdminPage() {
  const hq = can.admin.value;
  const tabs = tabsFor({ admin: hq, manage: manageFlag() });
  const route = useRoute();
  const online = useOnline();

  if (tabs.length === 0) {
    return (
      <div class="page adm" data-testid="admin-forbidden">
        <EmptyState
          icon={<IconAdmin size={40} />}
          title={t('admin.forbiddenTitle')}
          message={t('admin.forbiddenBody')}
        />
      </div>
    );
  }

  const { tab, id } = parseAdminPath(route.params['*'] ?? '', tabs);

  return (
    <div class="page adm" data-testid="admin-page" data-role={hq ? 'hq' : 'manager'}>
      <nav class="adm-tabs" aria-label={t('admin.sectionsLabel')}>
        <ul>
          {tabs.map((key) => (
            <li key={key}>
              <Link
                href={`/admin/${key}`}
                class={key === tab ? 'adm-tabs__link adm-tabs__link--active' : 'adm-tabs__link'}
                aria-current={key === tab ? 'page' : undefined}
                testId={`admin-tab-${key}`}
              >
                {t(`admin.tab_${key}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {!hq && (
        <p class="adm-note" data-testid="admin-manager-note">
          {t('admin.managerNote')}
        </p>
      )}
      {!online && (
        <div class="adm-banner adm-banner--offline" role="status" data-testid="admin-offline">
          <IconOffline size={20} />
          <span>{t('admin.offlineBanner')}</span>
        </div>
      )}
      <div class="adm-body">
        {tab === 'users' && <UsersPanel hq={hq} selectedId={id} />}
        {tab === 'countries' && <CountriesPanel />}
        {tab === 'branches' && <BranchesPanel />}
        {tab === 'options' && <OptionsPanel />}
        {tab === 'fx' && <FxPanel />}
        {tab === 'settings' && <SettingsPanel />}
        {tab === 'packs' && <MapPacksPanel />}
        {tab === 'sync' && <SyncStatusPanel />}
      </div>
    </div>
  );
}
