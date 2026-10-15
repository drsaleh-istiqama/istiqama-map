/**
 * Entry chunk — deliberately almost empty (brief §5: FCP < 2.5 s on 3G).
 *
 * index.html already paints a styled splash (inlined critical CSS), so nothing here may hold
 * up the first paint: the application, every stylesheet and the auth stack (supabase-js,
 * Dexie) come in through the dynamic import below. Their chunks are announced as preloads in
 * index.html by vite.config.ts (`bootPreloadPlugin`), so the download starts with the HTML and
 * no extra round trip is paid; only their evaluation waits until after the first paint, split
 * into separate tasks (see `start()` in app.tsx).
 *
 * Boot guard: if the application does not start (a chunk the cached service worker can no
 * longer serve, a wedged browser storage on iOS), the splash would stay up for ever. After a
 * failure or BOOT_TIMEOUT_MS the page repairs itself once (service worker + caches dropped,
 * reload); if that is not enough, the splash offers the same repair as a button. Local data
 * (IndexedDB) and the session are not touched. Plain strings: i18n is not loaded yet here.
 */
const BOOT_TIMEOUT_MS = 20_000;
const RECOVERY_KEY = 'boot.recovered';
let started = false;

function session(op: (s: Storage) => string | null | void): string | null {
  try {
    return op(sessionStorage) ?? null;
  } catch {
    return null;
  }
}

async function repairAndReload(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* nothing to unregister */
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* no CacheStorage */
  }
  window.location.reload();
}

function bootFailed(error?: unknown): void {
  if (started) return;
  console.error('[boot] the application could not be started', error ?? 'timeout');
  if (session((s) => s.getItem(RECOVERY_KEY)) === null) {
    session((s) => s.setItem(RECOVERY_KEY, '1'));
    void repairAndReload();
    return;
  }
  const card = document.querySelector('.splash__card');
  if (!card || card.querySelector('.splash__fail')) return;
  const box = document.createElement('div');
  box.className = 'splash__fail';
  box.setAttribute('role', 'alert');
  const text = document.createElement('p');
  text.textContent = 'تعذّر تشغيل التطبيق. — The app could not start.';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'splash__retry';
  button.textContent = 'إصلاح وإعادة التحميل — Repair and reload';
  button.addEventListener('click', () => void repairAndReload());
  box.append(text, button);
  card.append(box);
}

const watchdog = setTimeout(() => bootFailed(), BOOT_TIMEOUT_MS);

import('./app')
  .then((app) => app.start())
  .then(() => {
    started = true;
    clearTimeout(watchdog);
    session((s) => s.removeItem(RECOVERY_KEY));
  })
  .catch((error: unknown) => bootFailed(error));
