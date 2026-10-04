import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetched = vi.fn();
const cache = new Map<string, unknown>();

vi.mock('../auth', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        eq: async () => {
          fetched(table);
          return { data: [{ key: 'app.environment', value: 'staging' }], error: null };
        },
      }),
    }),
  },
}));

vi.mock('../db', () => ({
  getAppSetting: async (key: string, fallback: unknown) =>
    cache.has(key) ? cache.get(key) : fallback,
  saveAppSettings: async (rows: Array<{ key: string; value: unknown }>) => {
    for (const row of rows) cache.set(row.key, row.value);
  },
}));

describe('loadAppSettings', () => {
  beforeEach(() => {
    vi.resetModules();
    fetched.mockReset();
    cache.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('online: fetches the public settings and exposes app.environment', async () => {
    const m = await import('./appSettings');
    await m.loadAppSettings();
    expect(fetched).toHaveBeenCalledWith('app_settings');
    expect(m.serverEnvironment.value).toBe('staging');
    expect(m.isStagingServer()).toBe(true);
  });

  it('offline: shows the cached value without a request, refreshes once back online', async () => {
    cache.set('app.environment', 'production');
    vi.stubGlobal('navigator', { onLine: false });
    const m = await import('./appSettings');
    await m.loadAppSettings();
    await m.loadAppSettings(); // a second offline start must not arm a second refresh
    expect(fetched).not.toHaveBeenCalled();
    expect(m.serverEnvironment.value).toBe('production');

    vi.stubGlobal('navigator', { onLine: true });
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(m.serverEnvironment.value).toBe('staging'));
    expect(fetched).toHaveBeenCalledTimes(1);
  });
});
