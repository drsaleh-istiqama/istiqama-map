import type { ComponentChildren } from 'preact';
import { t } from '../../i18n';
import type { NavId } from '../../routes';
import { Button } from '../Button';
import { IconDownload } from '../icons';
import { Link } from '../Link';
import { Modal } from '../Modal';
import { AccountCard } from './AccountCard';
import { BrandMark } from './BrandMark';
import type { NavItem, VisibleNav } from './nav';

interface NavLinkProps {
  item: NavItem;
  active: boolean;
  /** Short label under the icon (bottom bar) instead of the full label. */
  compact?: boolean;
  /** Open-maintenance count shown on the maintenance entry. */
  count?: number;
  onNavigate?: () => void;
}

function NavLink({ item, active, compact, count, onNavigate }: NavLinkProps) {
  const Icon = item.icon;
  const label = t(item.labelKey);
  const classes = [
    'nav__link',
    active && 'nav__link--active',
    compact && item.id === 'add' && 'nav__link--add',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Link
      href={item.path}
      class={classes}
      testId={item.testId}
      aria-current={active ? 'page' : undefined}
      title={compact ? label : undefined}
      onClick={onNavigate}
    >
      <span class="nav__icon">
        <Icon size={compact ? 24 : 22} />
      </span>
      <span class="nav__label">{compact ? t(item.shortLabelKey) : label}</span>
      {count !== undefined && count > 0 && (
        <span class="nav__count" title={t('nav.maintenanceOpen', { count })}>
          <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
          <span class="sr-only">{t('nav.maintenanceOpen', { count })}</span>
        </span>
      )}
    </Link>
  );
}

function countFor(item: NavItem, maintenanceCount: number): number | undefined {
  return item.id === 'maintenance' ? maintenanceCount : undefined;
}

export interface NavigationProps {
  nav: VisibleNav;
  activeId: NavId | null;
  maintenanceCount: number;
}

/** Desktop: every destination in one list. "Add project" is the gold button of the top bar. */
export function Sidebar({ nav, activeId, maintenanceCount }: NavigationProps) {
  const items = [...nav.primary, ...nav.more].filter((item) => item.id !== 'add');
  return (
    <aside class="sidebar on-navy">
      <div class="sidebar__brand">
        <BrandMark size={40} />
        <span>
          <strong>{t('common.appShortName')}</strong>
          <small>{t('common.appTagline')}</small>
        </span>
      </div>
      <nav class="nav nav--side" aria-label={t('nav.main')}>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <NavLink
                item={item}
                active={item.id === activeId}
                count={countFor(item, maintenanceCount)}
              />
            </li>
          ))}
        </ul>
      </nav>
      <AccountCard />
    </aside>
  );
}

/** Phones: map, projects, add (+), maintenance, reports — nothing else (brief §12). */
export function BottomNav({ nav, activeId, maintenanceCount }: NavigationProps) {
  return (
    <nav class="nav nav--bottom" aria-label={t('nav.main')} data-testid="bottom-nav">
      <ul>
        {nav.primary.map((item) => (
          <li key={item.id}>
            <NavLink
              item={item}
              active={item.id === activeId}
              compact
              count={countFor(item, maintenanceCount)}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface MoreSheetProps extends NavigationProps {
  open: boolean;
  onClose: () => void;
  /** Present when the browser offered to install the app. */
  onInstall?: () => void;
  children?: ComponentChildren;
}

/** Phones: the remaining destinations, the account card and the install button. */
export function MoreSheet({
  nav,
  activeId,
  maintenanceCount,
  open,
  onClose,
  onInstall,
}: MoreSheetProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('nav.more')}
      variant="sheet"
      closeOnBackdrop
      testId="more-sheet"
    >
      <AccountCard onNavigate={onClose} />
      <nav class="nav nav--sheet" aria-label={t('nav.more')}>
        <ul>
          {nav.more.map((item) => (
            <li key={item.id}>
              <NavLink
                item={item}
                active={item.id === activeId}
                count={countFor(item, maintenanceCount)}
                onNavigate={onClose}
              />
            </li>
          ))}
        </ul>
      </nav>
      {onInstall && (
        <Button block icon={<IconDownload size={20} />} testId="install-app" onClick={onInstall}>
          {t('common.install')}
        </Button>
      )}
    </Modal>
  );
}
