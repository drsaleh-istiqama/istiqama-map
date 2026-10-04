import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../i18n';
import { syncStatus } from '../../sync';
import { Button } from '../Button';
import { IconOffline } from '../icons';
import { applyUpdate, updateAvailable } from '../pwa/register';
import { toast } from '../Toast';

/** "You are offline — keep working" (v2 parity), plus a toast when the connection returns. */
export function OfflineBanner() {
  const online = syncStatus.value.online;
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) toast(t('common.backOnline'), 'success');
    wasOnline.current = online;
  }, [online]);
  if (online) return null;
  return (
    <div class="banner banner--offline" data-testid="offline-banner">
      <IconOffline size={18} />
      <span>{t('common.offlineBanner')}</span>
    </div>
  );
}

/** A new version is installed and waiting. Nothing reloads until the user says so. */
export function UpdatePrompt() {
  const [postponed, setPostponed] = useState(false);
  if (!updateAvailable.value || postponed) return null;
  return (
    <div class="banner banner--update" role="alert" data-testid="update-prompt">
      <span>{t('common.updateAvailable')}</span>
      <span class="banner__actions">
        <Button size="sm" variant="gold" testId="update-accept" onClick={applyUpdate}>
          {t('common.updateNow')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          class="on-navy"
          testId="update-later"
          onClick={() => setPostponed(true)}
        >
          {t('common.updateLater')}
        </Button>
      </span>
    </div>
  );
}
