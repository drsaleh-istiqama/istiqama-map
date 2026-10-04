import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, type MapPackRow, type PackRecord } from '../db';
import { createOpfsStore } from './packStore';
import { createPackManager, type LocalPackRecord, type PackManager } from './packs';
import { sha256Hex } from './sha256';
import { FakeDirectory } from './testing/fakeOpfs';
import { FakeServer } from './testing/fakeServer';
import { buildPmtiles, bytesOf } from './testing/pmtilesFixture';

const BASE = 'http://127.0.0.1:54321/storage/v1/object/public/tiles';

const state = vi.hoisted(() => ({ manager: null as PackManager | null, online: true }));

vi.mock('./packsRuntime', () => ({ packManager: () => state.manager }));
vi.mock('../sync', async () => {
  const { signal } = await import('@preact/signals');
  return { syncStatus: signal({ online: true, pendingOps: 0, pendingPhotos: 0 }) };
});

const { default: PacksSection } = await import('./PacksSection');

function archive(): Uint8Array {
  return buildPmtiles(
    Array.from({ length: 5 }, (_, i) => ({ z: 10, x: 620 + i, y: 520, data: bytesOf(3000, i) })),
    { bounds: [39, -6, 40, -5] },
  );
}

function row(file: Uint8Array): MapPackRow {
  return {
    id: '0190aaaa-0000-7000-8000-0000000000aa',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    created_by: null,
    updated_by: null,
    version: 1,
    deleted_at: null,
    code: 'TZ-PN',
    name_ar: 'شمال بيمبا',
    name_en: 'North Pemba',
    name_sw: 'Pemba Kaskazini',
    country_id: null,
    admin_area_id: null,
    storage_path: 'packs/TZ/TZ-PN.pmtiles',
    bytes: file.length,
    min_zoom: 0,
    max_zoom: 10,
    min_lon: 39,
    min_lat: -6,
    max_lon: 40,
    max_lat: -5,
    tiles_version: '20261003',
    sha256: sha256Hex(file),
    active: true,
  } as MapPackRow;
}

let server: FakeServer;
let file: Uint8Array;

beforeEach(async () => {
  await db.map_packs.clear();
  await db.packs.clear();
  server = new FakeServer();
  file = archive();
  server.files.set(`${BASE}/packs/TZ/TZ-PN.pmtiles`, file);
  const root = new FakeDirectory();
  const store = createOpfsStore(async () => root);
  state.manager = createPackManager({
    fetch: server.fetch,
    store: async () => store,
    records: {
      get: async (code) => (await db.packs.get(code)) as LocalPackRecord | undefined,
      put: async (r) => void (await db.packs.put(r as PackRecord)),
      delete: async (code) => db.packs.delete(code),
      list: async () => (await db.packs.toArray()) as LocalPackRecord[],
    },
    online: () => true,
    estimate: async () => ({ usage: 0, quota: 1e10 }),
    persist: async () => true,
    url: (path) => `${BASE}/${path}`,
    chunkBytes: 4096,
    reserveBytes: 0,
  });
});

afterEach(cleanup);

describe('<PacksSection /> (Settings)', () => {
  it('says so when no pack is published', async () => {
    render(<PacksSection />);
    expect(await screen.findByTestId('map-packs-empty')).toBeTruthy();
    expect(screen.getByTestId('settings-map-packs')).toBeTruthy();
  });

  it('shows the size before downloading, downloads, then offers delete', async () => {
    await db.map_packs.put(row(file));
    render(<PacksSection />);
    const item = await screen.findByTestId('map-pack-TZ-PN');
    expect(item.getAttribute('data-status')).toBe('available');
    const download = screen.getByTestId('map-pack-TZ-PN-download');
    // The size is in the button label before anything is fetched.
    expect(download.textContent).toMatch(/\d/);
    expect(server.requests).toHaveLength(0);

    fireEvent.click(download);
    await waitFor(() =>
      expect(screen.getByTestId('map-pack-TZ-PN').getAttribute('data-status')).toBe('installed'),
    );
    expect(server.requests.length).toBe(Math.ceil(file.length / 4096));
    expect(screen.queryByTestId('map-pack-TZ-PN-download')).toBeNull();
    // Delete appears once the verification step has finished.
    expect(await screen.findByTestId('map-pack-TZ-PN-delete')).toBeTruthy();
    expect(screen.getByTestId('map-packs-usage').textContent).toMatch(/\d/);
  });

  it('a partial download shows progress and a resume button', async () => {
    await db.map_packs.put(row(file));
    server.beforeAnswer = (n) => {
      if (n === 3) throw new TypeError('Failed to fetch');
    };
    render(<PacksSection />);
    fireEvent.click(await screen.findByTestId('map-pack-TZ-PN-download'));
    await waitFor(() =>
      expect(screen.getByTestId('map-pack-TZ-PN').getAttribute('data-status')).toBe('partial'),
    );
    expect((await screen.findByRole('alert')).textContent?.length).toBeGreaterThan(0);
    const progress = screen.getByTestId('map-pack-TZ-PN-progress');
    expect(Number(progress.getAttribute('aria-valuenow'))).toBeGreaterThan(0);

    server.beforeAnswer = null;
    fireEvent.click(screen.getByTestId('map-pack-TZ-PN-download'));
    await waitFor(() =>
      expect(screen.getByTestId('map-pack-TZ-PN').getAttribute('data-status')).toBe('installed'),
    );
  });
});
