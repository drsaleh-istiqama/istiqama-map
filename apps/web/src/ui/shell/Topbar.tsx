import { t } from '../../i18n';
import { navigate } from '../../routes';
import { isStagingServer } from '../appSettings';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { IconDownload, IconMore, IconPlus } from '../icons';
import { SyncBadge } from '../SyncBadge';
import { BrandMark } from './BrandMark';
import { loadNotificationsBell } from './integrations';
import { LazySlot } from './LazySlot';

export interface TopbarProps {
  title: string;
  desktop: boolean;
  /** The user may create projects (desktop "add project" button). */
  canAdd: boolean;
  /** Present when the browser offered to install the app. */
  onInstall?: () => void;
  moreOpen: boolean;
  onOpenMore: () => void;
}

export function Topbar({ title, desktop, canAdd, onInstall, moreOpen, onOpenMore }: TopbarProps) {
  return (
    <header class="topbar">
      {!desktop && <BrandMark size={32} />}
      {/* Phones: the badge sits under the title, so the title keeps the width it needs. */}
      <div class="topbar__heading">
        <h1 class="topbar__title" data-testid="view-title" title={title}>
          {title}
        </h1>
        {/* Only when the SERVER says it is a staging environment (brief §7.8) */}
        {isStagingServer() && (
          <Badge tone="gold" testId="env-badge">
            {t('common.demoBadge')}
          </Badge>
        )}
      </div>
      <div class="topbar__actions">
        <SyncBadge />
        <LazySlot load={loadNotificationsBell} />
        {desktop && onInstall && (
          <Button
            size="sm"
            icon={<IconDownload size={18} />}
            testId="install-app"
            onClick={onInstall}
          >
            {t('common.install')}
          </Button>
        )}
        {desktop && canAdd && (
          <Button
            variant="gold"
            icon={<IconPlus size={20} />}
            testId="add-project"
            onClick={() => navigate('/projects/new')}
          >
            {t('nav.add')}
          </Button>
        )}
        {!desktop && (
          <button
            type="button"
            class="icon-btn"
            data-testid="nav-more"
            aria-label={t('nav.more')}
            aria-haspopup="dialog"
            aria-expanded={moreOpen ? 'true' : 'false'}
            onClick={onOpenMore}
          >
            <IconMore />
          </button>
        )}
      </div>
    </header>
  );
}
