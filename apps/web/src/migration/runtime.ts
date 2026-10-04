/**
 * The real dependencies of the migration runner: session and scope (src/auth), sync and
 * transport (src/sync), the photo pipeline (src/photos), geofill (the project form's
 * `locatePoint`: server `locate_point`, else the cached level 1–2 shapes), the v2 keys
 * (src/lib/prefs). Loaded lazily with the migration UI — never by the shell.
 */
import { DIAL_COUNTRIES, me, session, supabase, toE164 } from '../auth';
import { t } from '../i18n';
import { readLegacyV2, removeLegacyV2, type LegacyV2Key } from '../lib/prefs';
import { uuidv7 } from '../lib/uuidv7';
import { addPhoto } from '../photos';
import { locatePoint } from '../projects/form/geo';
import { syncNow, transport } from '../sync';
import { fileMergeSuggestion } from './merge';
import type { RunnerDeps } from './runner';
import type { GeoHint } from './v2map';

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function localDate(d = new Date()): string {
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `external_id`s among `keys` that the server already has for this user (RLS-visible rows). */
async function serverExternalIds(keys: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const { data, error } = await supabase
      .from('projects')
      .select('external_id')
      .in('external_id', chunk);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ external_id: string | null }>) {
      if (row.external_id) found.add(row.external_id);
    }
  }
  return found;
}

const rpc = <T>(fn: string, args?: Record<string, unknown>): Promise<T> =>
  transport.rpc<T>(fn, args);

async function locate(
  p: { lon: number; lat: number },
  prefer: readonly string[],
): Promise<GeoHint | null> {
  const res = await locatePoint(p, { rpc, online: isOnline(), preferCountries: prefer });
  if (res.source === 'none') return null;
  return {
    countryId: res.countryId,
    areaPath: res.areaPath,
    adminAreaId: res.adminAreaId,
    localities: res.localities.map((l) => ({
      id: l.id,
      name_ar: l.name_ar,
      name_latin: l.name_latin,
    })),
  };
}

export const runtimeDeps: RunnerDeps = {
  userId: () => me.peek()?.user_id ?? session.peek()?.user.id ?? null,
  online: isOnline,
  syncNow,
  serverExternalIds,
  locate,
  addPhoto: (projectId, file, meta) => addPhoto(projectId, file, meta),
  writeScope: () => {
    const write = me.peek()?.scopes?.write;
    return { countries: write?.countries ?? [], branches: write?.branches ?? [] };
  },
  phone: (raw, iso2) => {
    const dial = DIAL_COUNTRIES.find((c) => c.iso2 === iso2)?.dial ?? '';
    return dial || raw.trim().startsWith('+') || raw.trim().startsWith('00')
      ? toE164(raw, dial)
      : null;
  },
  texts: {
    fallbackName: (id) => t('migration.fallbackName', { id }),
    salaryReviewNote: (currencies) =>
      t('migration.salaryReviewNote', { currencies: currencies.join(', ') }),
  },
  readLegacy: (key) => readLegacyV2(key as LegacyV2Key),
  removeLegacy: (key) => removeLegacyV2(key as LegacyV2Key),
  newId: () => uuidv7(),
  today: () => localDate(),
  requestMerge: fileMergeSuggestion,
};
