/**
 * Entry chunk — deliberately almost empty (brief §5: FCP < 2.5 s on 3G).
 *
 * index.html already paints a styled splash (inlined critical CSS), so nothing here may hold
 * up the first paint: the application, every stylesheet and the auth stack (supabase-js,
 * Dexie) come in through the dynamic import below. Their chunks are announced as preloads in
 * index.html by vite.config.ts (`bootPreloadPlugin`), so the download starts with the HTML and
 * no extra round trip is paid; only their evaluation waits until after the first paint, split
 * into separate tasks (see `start()` in app.tsx).
 */
import('./app')
  .then((app) => app.start())
  .catch((error: unknown) => {
    console.error('[boot] the application could not be started', error);
  });
