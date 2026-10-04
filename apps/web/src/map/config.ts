/**
 * Where the map reads its resources from. Everything is our own origin or our own storage
 * (brief §1: never `tile.openstreetmap.org` or any other public tile / glyph host).
 *
 *   basemap    {VITE_TILES_URL}/basemap/east-africa.pmtiles   (public bucket "tiles", HTTP Range)
 *   packs      {VITE_TILES_URL}/<map_packs.storage_path>      (packs/<iso2>/<code>.pmtiles)
 *   glyphs     {app}/map/fonts/{fontstack}/{range}.pbf         (apps/web/public, OFL fonts),
 *              requested through istiqama-glyphs:// so they stay available offline (glyphs.ts)
 *   sprite     {app}/map/sprites/light                         (apps/web/public)
 *   projects   {VITE_SUPABASE_URL}/functions/v1/tiles/{z}/{x}/{y}  (private, user's JWT)
 */
import { env } from '../env';

/**
 * Data attribution of the basemap (ODbL), shown by the map's attribution control — and by the
 * project card while it covers that control on a phone. Plain text on purpose: a link would be
 * an external URL inside the style.
 */
export const BASEMAP_ATTRIBUTION = '© OpenStreetMap contributors · Protomaps';

/** Object name of the East Africa basemap inside the bucket `tiles`. */
export const BASEMAP_OBJECT = 'basemap/east-africa.pmtiles';

const trimEnd = (value: string): string => value.replace(/\/+$/, '');

/** Base URL of the public bucket `tiles` (no trailing slash), or '' when not configured. */
export function tilesBaseUrl(tilesUrl: string = env.tilesUrl): string {
  return trimEnd(tilesUrl ?? '');
}

/** URL of the online basemap archive, or null when VITE_TILES_URL is not set. */
export function basemapUrl(tilesUrl: string = env.tilesUrl): string | null {
  const base = tilesBaseUrl(tilesUrl);
  return base ? `${base}/${BASEMAP_OBJECT}` : null;
}

/** Download URL of an offline pack (`map_packs.storage_path` is relative to the bucket). */
export function packUrl(storagePath: string, tilesUrl: string = env.tilesUrl): string {
  return `${tilesBaseUrl(tilesUrl)}/${storagePath.replace(/^\/+/, '')}`;
}

/** `{VITE_SUPABASE_URL}/functions/v1` */
export function functionsUrl(supabaseUrl: string = env.supabaseUrl): string {
  return `${trimEnd(supabaseUrl ?? '')}/functions/v1`;
}

/** App base URL with a trailing slash (`http://127.0.0.1:4173/`). */
export function appBase(): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1';
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  return `${origin}${base.endsWith('/') ? base : `${base}/`}`;
}

/** Absolute sprite base URL (MapLibre refuses relative sprite URLs). */
export function spriteUrl(base: string = appBase()): string {
  return `${base}map/sprites/light`;
}

/** Default camera when nothing better is known: the coast of Tanzania with Zanzibar and Pemba. */
export const DEFAULT_VIEW = { center: [39.3, -5.9] as [number, number], zoom: 7 };

/** Zoom from which individual projects are drawn from the local database (brief §5). */
export const POINTS_MIN_ZOOM = 14;

/** Zoom used when flying to a single project. */
export const PROJECT_ZOOM = 16;
