/**
 * The `istiqama-basemap://` protocol: ONE MapLibre source for the basemap that reads, per
 * tile, an installed offline pack first and the online East Africa archive second (brief §1,
 * §4.7). Both are PMTiles archives read through the pmtiles decoder — packs through a local
 * byte-range source (OPFS / IndexedDB), the online archive through HTTP Range requests to our
 * own storage.
 *
 *   istiqama-basemap://tilejson/<rev>      → TileJSON (zoom range of what is reachable now)
 *   istiqama-basemap://tiles/{z}/{x}/{y}   → MVT bytes (empty tile when nothing has it)
 *
 * Without a connection no request is started (contract §1): tiles come from packs only, and
 * the status tells the map to show "basemap unavailable offline" where no pack covers it.
 * Pure logic: archives are injected, MapLibre only sees `handle()`.
 */
import { signal, type Signal } from '@preact/signals';

export interface HeaderLike {
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface ArchiveLike {
  getHeader(): Promise<HeaderLike>;
  getZxy(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<{ data: ArrayBuffer } | undefined>;
}

export interface PackArchive {
  code: string;
  archive: ArchiveLike;
  /** [minLon, minLat, maxLon, maxLat] of the pack, or null = unknown (always tried). */
  bbox: [number, number, number, number] | null;
  minZoom: number;
  maxZoom: number;
}

export type BasemapState = 'idle' | 'online' | 'pack' | 'unavailable';

export interface BasemapStatus {
  state: BasemapState;
  /** Why the online archive is not used: offline, not configured, or failing. */
  remote: 'ok' | 'offline' | 'missing' | 'error' | 'unknown';
  /** Tiles served since the last reset, by origin. */
  fromPacks: number;
  fromRemote: number;
  /** Tiles nobody could deliver (blank areas). */
  missing: number;
}

export interface BasemapRequest {
  url: string;
  type?: string;
}

export const PROTOCOL = 'istiqama-basemap';
const DEFAULT_MAX_ZOOM = 15;
const REMOTE_RETRY_MS = 60_000;

/** Bounding box of a web-mercator tile in degrees. */
export function tileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (i: number): number => (i / n) * 360 - 180;
  const lat = (j: number): number =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

function intersects(a: [number, number, number, number], b: [number, number, number, number]) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

const TILE_RE = /^istiqama-basemap:\/\/tiles\/(\d+)\/(\d+)\/(\d+)/;

export interface BasemapProvider {
  readonly status: Signal<BasemapStatus>;
  setRemote(archive: ArchiveLike | null): void;
  setPacks(packs: PackArchive[]): void;
  packs(): readonly PackArchive[];
  /** MapLibre `addProtocol` handler. */
  handle(request: BasemapRequest, abort?: AbortController): Promise<{ data: unknown }>;
  /** Forget remote failures and counters (connection back, packs changed). */
  reset(): void;
}

export function createBasemapProvider(deps: {
  online: () => boolean;
  now?: () => number;
}): BasemapProvider {
  const now = deps.now ?? Date.now;
  let remote: ArchiveLike | null = null;
  let remoteHeader: HeaderLike | null = null;
  let remoteFailedAt: number | null = null;
  let packs: PackArchive[] = [];
  const status = signal<BasemapStatus>({
    state: 'idle',
    remote: 'unknown',
    fromPacks: 0,
    fromRemote: 0,
    missing: 0,
  });

  const update = (patch: Partial<BasemapStatus>): void => {
    const next = { ...status.peek(), ...patch };
    next.state =
      next.missing > 0 && next.remote !== 'ok'
        ? 'unavailable'
        : next.fromRemote > 0
          ? 'online'
          : next.fromPacks > 0
            ? 'pack'
            : next.remote === 'ok'
              ? 'online'
              : next.state === 'unavailable'
                ? 'unavailable'
                : 'idle';
    status.value = next;
  };

  /** The online archive, unless offline, absent or failing recently. */
  const usableRemote = (): ArchiveLike | null => {
    if (!remote) {
      update({ remote: 'missing' });
      return null;
    }
    if (!deps.online()) {
      update({ remote: 'offline' });
      return null;
    }
    if (remoteFailedAt !== null && now() - remoteFailedAt < REMOTE_RETRY_MS) return null;
    return remote;
  };

  const remoteFailed = (): void => {
    remoteFailedAt = now();
    update({ remote: 'error' });
  };

  async function tileJson(): Promise<Record<string, unknown>> {
    const r = usableRemote();
    if (r && !remoteHeader) {
      try {
        remoteHeader = await r.getHeader();
        update({ remote: 'ok' });
      } catch {
        remoteFailed();
      }
    }
    const packMax = packs.length ? Math.max(...packs.map((p) => p.maxZoom)) : null;
    const remoteMax = remoteHeader?.maxZoom ?? null;
    const online = deps.online() && remoteHeader !== null && remoteFailedAt === null;
    // Online: everything the archives have. Offline: the packs' own maximum, so that MapLibre
    // over-zooms the deepest pack tile instead of asking for tiles nobody has.
    const maxzoom = online
      ? Math.max(remoteMax ?? 0, packMax ?? 0) || DEFAULT_MAX_ZOOM
      : (packMax ?? remoteMax ?? DEFAULT_MAX_ZOOM);
    return {
      tilejson: '3.0.0',
      tiles: [`${PROTOCOL}://tiles/{z}/{x}/{y}`],
      minzoom: 0,
      maxzoom,
    };
  }

  async function tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array> {
    const bounds = tileBounds(z, x, y);
    for (const pack of packs) {
      if (z < pack.minZoom || z > pack.maxZoom) continue;
      if (pack.bbox && !intersects(pack.bbox, bounds)) continue;
      try {
        const hit = await pack.archive.getZxy(z, x, y, signal);
        if (hit) {
          update({ fromPacks: status.peek().fromPacks + 1 });
          return new Uint8Array(hit.data);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // A damaged pack must not break the map: try the next source.
      }
    }
    const r = usableRemote();
    if (r) {
      try {
        const hit = await r.getZxy(z, x, y, signal);
        update({ fromRemote: status.peek().fromRemote + 1, remote: 'ok' });
        // Absent from the archive = nothing there (open sea): an empty tile, not a failure.
        return hit ? new Uint8Array(hit.data) : new Uint8Array(0);
      } catch (error) {
        if (signal?.aborted) throw error;
        remoteFailed();
      }
    }
    update({ missing: status.peek().missing + 1 });
    return new Uint8Array(0);
  }

  return {
    status,
    setRemote(archive) {
      remote = archive;
      remoteHeader = null;
      remoteFailedAt = null;
    },
    setPacks(next) {
      packs = [...next];
    },
    packs: () => packs,
    async handle(request, abort) {
      if (request.url.startsWith(`${PROTOCOL}://tilejson`)) return { data: await tileJson() };
      const m = TILE_RE.exec(request.url);
      if (!m) throw new Error(`unknown basemap URL ${request.url}`);
      const data = await tile(Number(m[1]), Number(m[2]), Number(m[3]), abort?.signal);
      return { data };
    },
    reset() {
      remoteFailedAt = null;
      remoteHeader = null;
      status.value = { state: 'idle', remote: 'unknown', fromPacks: 0, fromRemote: 0, missing: 0 };
    },
  };
}
