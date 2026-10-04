/**
 * Page side of the PWA: service-worker registration, the "update available" flow and the
 * install prompt. The shell renders the prompts; this module only holds the state.
 */
import { signal, type Signal } from '@preact/signals';
import type { Workbox } from 'workbox-window';
import { USER_CACHES } from './swRoutes';

/** A new version is installed and waiting; nothing changes until the user accepts. */
export const updateAvailable: Signal<boolean> = signal(false);
/** The browser offered to install the app (`beforeinstallprompt`). */
export const installAvailable: Signal<boolean> = signal(false);

const UPDATE_CHECK_MS = 60 * 60 * 1000;
let workbox: Workbox | null = null;

/** Registers `sw.js` (production builds only) and watches for new versions. */
export async function registerServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return;
  const { Workbox: WorkboxWindow } = await import('workbox-window');
  const base = import.meta.env.BASE_URL;
  const wb = new WorkboxWindow(`${base}sw.js`, { scope: base });
  workbox = wb;
  wb.addEventListener('waiting', () => {
    updateAvailable.value = true;
  });
  const registration = await wb.register();
  if (!registration) return;
  const check = (): void => {
    if (navigator.onLine) registration.update().catch(() => undefined);
  };
  // Field devices keep the app open for days: look for updates hourly and when it is reopened.
  setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

/** The user accepted the update: activate the waiting worker, then reload under it. */
export function applyUpdate(): void {
  if (!workbox) return;
  workbox.addEventListener('controlling', () => window.location.reload());
  workbox.messageSkipWaiting();
  updateAvailable.value = false;
}

/** Empties the caches that hold per-user content (thumbnails, project tiles). Call on sign-out. */
export async function purgeUserCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await Promise.all(USER_CACHES.map((name) => caches.delete(name).catch(() => false)));
}

// --- Install prompt (v2 parity: "install the app" button) --------------------------------------

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

/** Starts listening for the browser's install offer. `onInstalled` runs when the app was installed. */
export function watchInstallPrompt(onInstalled?: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onPrompt = (event: Event): void => {
    // Keep the browser's mini-infobar away; the shell shows its own button.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    installAvailable.value = true;
  };
  const onDone = (): void => {
    deferredPrompt = null;
    installAvailable.value = false;
    onInstalled?.();
  };
  window.addEventListener('beforeinstallprompt', onPrompt);
  window.addEventListener('appinstalled', onDone);
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt);
    window.removeEventListener('appinstalled', onDone);
  };
}

/** Shows the browser's install dialog. Resolves true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferredPrompt;
  if (!event) return false;
  deferredPrompt = null;
  installAvailable.value = false;
  await event.prompt();
  const choice = await event.userChoice;
  return choice.outcome === 'accepted';
}
