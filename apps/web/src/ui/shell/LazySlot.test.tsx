import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { h, type ComponentType } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_V2_KEYS } from '../../lib/prefs';
import { v2MigrationWanted, V2_IMPORT_ROUTES } from './integrations';
import { LazySlot, type ComponentLoader } from './LazySlot';

afterEach(cleanup);

const marker = (id: string) => () => h('span', { 'data-testid': id });

describe('<LazySlot>', () => {
  it('shows the fallback, then the loaded component with its props', async () => {
    let resolve!: (c: ComponentType<{ label: string }>) => void;
    const load: ComponentLoader<{ label: string }> = () =>
      new Promise((r) => {
        resolve = r;
      });
    render(
      <LazySlot load={load} props={{ label: 'x' }} fallback={<span data-testid="waiting" />} />,
    );
    expect(screen.getByTestId('waiting')).toBeTruthy();
    resolve(({ label }) => h('b', { 'data-testid': 'loaded' }, label));
    expect((await screen.findByTestId('loaded')).textContent).toBe('x');
    expect(screen.queryByTestId('waiting')).toBeNull();
  });

  it('a remount shows an already loaded component at once (no flash)', async () => {
    const load: ComponentLoader = vi.fn(async () => marker('once'));
    render(<LazySlot load={load} />);
    await screen.findByTestId('once');
    cleanup();
    render(<LazySlot load={load} />);
    expect(screen.getByTestId('once')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a module that is missing, fails to load or throws while rendering never takes the page down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = (): never => {
      throw new Error('boom');
    };
    render(
      <div>
        <LazySlot load={async () => null} fallback={<i data-testid="fb-null" />} />
        <LazySlot
          load={() => Promise.reject(new Error('offline'))}
          fallback={<i data-testid="fb-rejected" />}
        />
        <LazySlot load={async () => Broken} fallback={<i data-testid="fb-throws" />} />
        <span data-testid="rest-of-page" />
      </div>,
    );
    await waitFor(() => expect(warn).toHaveBeenCalled());
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(screen.getByTestId('fb-null')).toBeTruthy();
    expect(screen.getByTestId('fb-rejected')).toBeTruthy();
    expect(screen.getByTestId('fb-throws')).toBeTruthy();
    expect(screen.getByTestId('rest-of-page')).toBeTruthy();
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('shell integrations', () => {
  afterEach(() => {
    for (const key of LEGACY_V2_KEYS) localStorage.removeItem(key);
  });

  it('offers the v2 migration only on a device that holds one of the v2 keys', () => {
    expect(v2MigrationWanted()).toBe(false);
    localStorage.setItem('unrelated', '1');
    expect(v2MigrationWanted()).toBe(false);
    for (const key of LEGACY_V2_KEYS) {
      localStorage.setItem(key, '{}');
      expect(v2MigrationWanted()).toBe(true);
      localStorage.removeItem(key);
    }
    localStorage.removeItem('unrelated');
  });

  it('pages that import a v2 export file', () => {
    expect(V2_IMPORT_ROUTES.test('/settings')).toBe(true);
    expect(V2_IMPORT_ROUTES.test('/import')).toBe(true);
    expect(V2_IMPORT_ROUTES.test('/import/history')).toBe(true);
    expect(V2_IMPORT_ROUTES.test('/importer')).toBe(false);
    expect(V2_IMPORT_ROUTES.test('/map')).toBe(false);
  });

  it('the loaders resolve to the real components of their modules', async () => {
    const { loadNotificationsBell, loadV2MigrationPrompt } = await import('./integrations');
    const bell = await import('../../reports/NotificationsBell');
    const prompt = await import('../../migration/V2MigrationPrompt');
    expect(await loadNotificationsBell()).toBe(bell.NotificationsBell);
    expect(await loadV2MigrationPrompt()).toBe(prompt.default);
  }, 30_000);
});
