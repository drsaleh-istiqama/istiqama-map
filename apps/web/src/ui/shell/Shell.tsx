import { useEffect, useRef, useState } from 'preact/hooks';
import { can, me, session } from '../../auth';
import { isLocale, savedLocale, setLocale, t } from '../../i18n';
import { navigate, setScrollContainer, useRoute } from '../../routes';
import { startSync, stopSync } from '../../sync';
import { loadAppSettings } from '../appSettings';
import { useMediaQuery } from '../hooks';
import { installAvailable, promptInstall, watchInstallPrompt } from '../pwa/register';
import { toast } from '../Toast';
import { OfflineBanner, UpdatePrompt } from './Banners';
import { visibleNav } from './nav';
import { BottomNav, MoreSheet, Sidebar } from './Navigation';
import { RouteOutlet } from './RouteOutlet';
import { Topbar } from './Topbar';
import { useMaintenanceCount } from './useMaintenanceCount';
import './shell.css';

/** From this width the sidebar replaces the bottom bar. */
export const DESKTOP_QUERY = '(min-width: 900px)';

interface ContextLike {
  user_id?: string;
  profile?: { preferred_language?: string | null } | null;
}

/**
 * Application chrome for a signed-in user: sidebar + top bar on desktop, top bar + bottom
 * navigation + "more" sheet on phones, the permanent sync badge, offline / update banners
 * and the routed view. Exactly one navigation is rendered at a time, so test ids are unique.
 */
export function Shell() {
  const match = useRoute();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [moreOpen, setMoreOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  const context = me.value as ContextLike | null;
  const userId = context?.user_id ?? null;
  const profileLanguage = context?.profile?.preferred_language ?? null;
  const signedIn = Boolean(session.value);

  // `manage` is an extension of the auth module (country managers administer their own
  // country's users and devices); read defensively so the contract shape alone also works.
  const manage = (can as { manage?: { value: boolean } }).manage?.value ?? false;
  const nav = visibleNav({
    write: can.write.value,
    review: can.review.value,
    seePeople: can.seePeople.value,
    admin: can.admin.value || manage,
  });
  const activeId = match.route?.nav ?? null;
  const maintenanceCount = useMaintenanceCount(match.path);
  const title = match.route ? t(match.route.titleKey) : t('common.notFoundTitle');
  const bare = match.route?.bare === true;

  // The sync engine runs while the signed-in shell is on screen.
  useEffect(() => {
    startSync();
    return stopSync;
  }, []);

  useEffect(() => watchInstallPrompt(() => toast(t('common.installed'), 'success')), []);

  // Server settings (demo badge) once per signed-in user; the cached copy is used offline.
  useEffect(() => {
    if (userId) void loadAppSettings();
  }, [userId]);

  // First sign-in on this device: follow the language of the user's profile.
  useEffect(() => {
    if (!savedLocale() && isLocale(profileLanguage))
      setLocale(profileLanguage).catch(() => undefined);
  }, [profileLanguage]);

  // A signed-in user has nothing to do on /login.
  useEffect(() => {
    if (match.path === '/login' && signedIn) navigate('/map', { replace: true });
  }, [match.path, signedIn]);

  useEffect(() => {
    setScrollContainer(bare ? null : mainRef.current);
    return () => setScrollContainer(null);
  }, [bare, desktop]);

  // On navigation: close the sheet, retitle the document, move focus to the new content.
  useEffect(() => {
    setMoreOpen(false);
    document.title = `${title} — ${t('common.appName')}`;
    if (firstRender.current) firstRender.current = false;
    else mainRef.current?.focus({ preventScroll: true });
  }, [match.path, title]);

  if (bare) {
    return (
      <main id="main" class="shell-bare">
        <RouteOutlet match={match} />
      </main>
    );
  }

  const onInstall = installAvailable.value ? (): void => void promptInstall() : undefined;
  const navigation = { nav, activeId, maintenanceCount };

  return (
    <div class={desktop ? 'shell shell--desktop' : 'shell shell--mobile'}>
      <a
        class="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        {t('common.skipToContent')}
      </a>
      {desktop && <Sidebar {...navigation} />}
      <div class="shell__banners">
        <OfflineBanner />
        <UpdatePrompt />
      </div>
      <Topbar
        title={title}
        desktop={desktop}
        canAdd={can.write.value}
        onInstall={onInstall}
        moreOpen={moreOpen}
        onOpenMore={() => setMoreOpen(true)}
      />
      <main id="main" ref={mainRef} class="shell__main" tabIndex={-1}>
        <RouteOutlet match={match} />
      </main>
      {!desktop && <BottomNav {...navigation} />}
      {!desktop && (
        <MoreSheet
          {...navigation}
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          onInstall={onInstall}
        />
      )}
    </div>
  );
}
