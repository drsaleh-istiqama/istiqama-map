/**
 * Browser wiring of the basemap protocol: the online archive on our storage, the installed
 * offline packs, and a revision signal that tells every mounted map to ask for the basemap
 * again (pack installed or deleted, connection lost or back).
 */
import { computed, effect, signal, type ReadonlySignal } from '@preact/signals';
import { FetchSource, PMTiles } from 'pmtiles';
import { createBasemapProvider, type BasemapProvider, type PackArchive } from './basemapProtocol';
import { basemapUrl } from './config';
import { LocalPackSource, packSourceKey } from './localSource';
import { packManager } from './packsRuntime';

const isOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Bumped whenever the reachable basemap changes; maps re-request the TileJSON. */
export const basemapRevision = signal(1);

let provider: BasemapProvider | null = null;

/**
 * `state|remote` of the basemap. The provider's status changes with every tile (counters);
 * this only changes when what the user should see changes, so the map view does not
 * re-render per tile on a slow phone.
 */
export const basemapView: ReadonlySignal<string> = computed(() => {
  const s = basemapProvider().status.value;
  return `${s.state}|${s.remote}`;
});
const archives = new Map<string, PackArchive>();

async function refreshPacks(p: BasemapProvider): Promise<void> {
  try {
    const installed = await packManager().installed();
    const next: PackArchive[] = [];
    const keep = new Set<string>();
    for (const { record, file } of installed) {
      const key = packSourceKey(record.code, record.sha256);
      keep.add(key);
      let archive = archives.get(key);
      if (!archive) {
        archive = {
          code: record.code,
          archive: new PMTiles(new LocalPackSource(key, file)),
          bbox: record.bbox,
          minZoom: record.minZoom ?? 0,
          maxZoom: record.maxZoom ?? 15,
        };
        archives.set(key, archive);
      }
      next.push(archive);
    }
    for (const key of [...archives.keys()]) if (!keep.has(key)) archives.delete(key);
    // Deeper packs first: a detailed district pack wins over a coarse country-wide one.
    next.sort((a, b) => b.maxZoom - a.maxZoom);
    p.setPacks(next);
  } catch {
    p.setPacks([]);
  }
}

/** The single provider of this page (created on first use). */
export function basemapProvider(): BasemapProvider {
  if (provider) return provider;
  const p = createBasemapProvider({ online: isOnline });
  provider = p;
  const url = basemapUrl();
  p.setRemote(url ? new PMTiles(new FetchSource(url)) : null);

  let first = true;
  effect(() => {
    void packManager().revision.value; // subscribe
    void refreshPacks(p).then(() => {
      if (first) first = false;
      else {
        p.reset();
        basemapRevision.value++;
      }
    });
  });
  if (typeof window !== 'undefined') {
    const changed = (): void => {
      p.reset();
      basemapRevision.value++;
    };
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
  }
  return p;
}

/** Resolves once the installed packs are known (the first TileJSON must include them). */
export async function basemapReady(): Promise<BasemapProvider> {
  const p = basemapProvider();
  await refreshPacks(p);
  return p;
}
