/**
 * Public application settings (`app_settings` rows with `is_public = true`,
 * docs/contracts/reference-data.md §5).
 *
 * The rows are fetched through PostgREST once per signed-in user and handed to the local
 * cache of `src/db` (`saveAppSettings`), from which every module reads them offline
 * (`getAppSetting`). The shell itself needs one of them: `app.environment` — the "demo
 * data" badge appears only when the SERVER says the environment is staging (brief §7.8,
 * §12), never because of a build flag.
 */
import { signal, type Signal } from '@preact/signals';
import { supabase } from '../auth';
import { getAppSetting, saveAppSettings } from '../db';

export const ENVIRONMENT_SETTING = 'app.environment';

/** Value of `app.environment` on the server this device talks to; null = not declared (production). */
export const serverEnvironment: Signal<string | null> = signal(null);

/** True only when the server declares itself a staging environment. */
export function isStagingServer(): boolean {
  return serverEnvironment.value === 'staging';
}

/** An offline start armed a one-shot refresh for the next 'online' event. */
let retryArmed = false;

async function readCached(): Promise<void> {
  const value = await getAppSetting<unknown>(ENVIRONMENT_SETTING, null);
  serverEnvironment.value = typeof value === 'string' ? value : null;
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Without a connection no request is made; the refresh runs once the network is back. */
function refreshWhenOnline(): void {
  if (retryArmed || typeof window === 'undefined') return;
  retryArmed = true;
  window.addEventListener(
    'online',
    () => {
      retryArmed = false;
      void loadAppSettings();
    },
    { once: true },
  );
}

/**
 * Shows the cached settings at once, then refreshes them from the server when it can be
 * reached. Offline or failing: the cached copy stays in use.
 */
export async function loadAppSettings(): Promise<void> {
  try {
    await readCached();
    if (isOffline()) {
      refreshWhenOnline();
      return;
    }
    const { data, error } = await supabase
      .from('app_settings')
      .select('key,value')
      .eq('is_public', true);
    if (error || !Array.isArray(data)) return;
    const rows = (data as Array<{ key?: unknown; value?: unknown }>).flatMap((row) =>
      typeof row.key === 'string' ? [{ key: row.key, value: row.value }] : [],
    );
    await saveAppSettings(rows);
    await readCached();
  } catch {
    // Offline or local database unavailable: keep what is shown.
  }
}
