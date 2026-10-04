/**
 * Offline map packs (brief §4.7): the `map_packs` rows devices list under Settings. A pack is
 * produced by the `scripts/build-pmtiles` script (extract → upload with the service key →
 * row), never from the browser; the panel shows its rows, lets the head office hide or show
 * a pack, and gives the command to build a new one.
 */
import { useState } from 'preact/hooks';
import { fmt, pickName, t } from '../i18n';
import { Badge, Button, EmptyState, toast } from '../ui';
import { listRows, updateRow } from './api';
import { adminErrorKey } from './errors';
import { countryName } from './labels';
import { Ltr, ResourceState, useResource, When } from './shared';
import type { CountryRec, MapPackRec } from './types';

/** Commands of scripts/build-pmtiles/README.md §2 (shown, never run from here). */
export const PACK_COMMANDS = [
  'npm run pmtiles:build -- list --country TZ --level 1',
  'npm run pmtiles:build -- --country TZ --area "North Pemba"',
  'npm run pmtiles:build -- --country TZ --area Tanga --maxzoom 13 --dry-run',
] as const;

interface Data {
  packs: MapPackRec[];
  countries: CountryRec[];
}

async function load(): Promise<Data> {
  const [packs, countries] = await Promise.all([
    listRows<MapPackRec>('map_packs'),
    listRows<CountryRec>('countries'),
  ]);
  return { packs, countries };
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('admin.copied'), 'success');
  } catch {
    toast(t('admin.copyFailed'), 'error');
  }
}

export function MapPacksPanel() {
  const data = useResource(load);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (pack: MapPackRec): Promise<void> => {
    setBusy(pack.id);
    try {
      await updateRow('map_packs', pack, { active: !pack.active });
      toast(pack.active ? t('admin.packHidden') : t('admin.packShown'), 'success');
    } catch (e) {
      toast(t(adminErrorKey(e)), 'error');
    } finally {
      setBusy(null);
      await data.reload();
    }
  };

  return (
    <section class="adm-panel" aria-labelledby="adm-packs-title" data-testid="admin-packs">
      <div class="adm-panel__head">
        <h2 id="adm-packs-title">{t('admin.packsTitle')}</h2>
      </div>
      <div class="card adm-howto" data-testid="admin-packs-howto">
        <h3>{t('admin.packsHowTitle')}</h3>
        <p>{t('admin.packsHowBody')}</p>
        <ul class="adm-commands">
          {PACK_COMMANDS.map((command) => (
            <li key={command}>
              <code dir="ltr" class="adm-command" data-testid="admin-packs-command">
                {command}
              </code>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('admin.copyCommand')}
                onClick={() => void copy(command)}
              >
                {t('admin.copy')}
              </Button>
            </li>
          ))}
        </ul>
        <p class="muted adm-small">{t('admin.packsHowNote')}</p>
      </div>
      <ResourceState resource={data} testId="admin-packs">
        {({ packs, countries }) => {
          const live = packs.filter((p) => !p.deleted_at);
          if (live.length === 0)
            return (
              <EmptyState
                title={t('admin.noPacks')}
                message={t('admin.noPacksBody')}
                testId="admin-packs-empty"
              />
            );
          const byId = new Map(countries.map((c) => [c.id, c]));
          return (
            <div class="adm-table-wrap">
              <table class="adm-table" data-testid="admin-packs-table">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.colName')}</th>
                    <th scope="col">{t('admin.colCountry')}</th>
                    <th scope="col">{t('admin.colSize')}</th>
                    <th scope="col">{t('admin.colZoom')}</th>
                    <th scope="col">{t('admin.colUpdated')}</th>
                    <th scope="col">{t('admin.colState')}</th>
                    <th scope="col">
                      <span class="sr-only">{t('admin.colActions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((p) => (
                    <tr key={p.id} data-testid="admin-pack-row" data-code={p.code}>
                      <td>
                        <span class="adm-names">
                          <span>{pickName(p)}</span>
                          <Ltr class="mono muted">{p.code}</Ltr>
                        </span>
                      </td>
                      <td>{p.country_id ? countryName(byId.get(p.country_id)) : '—'}</td>
                      <td>{fmt.bytes(p.bytes)}</td>
                      <td>
                        <Ltr>
                          {p.min_zoom ?? '?'}–{p.max_zoom ?? '?'}
                        </Ltr>
                      </td>
                      <td>
                        <When at={p.updated_at} />
                      </td>
                      <td>
                        {p.active ? (
                          <Badge tone="success">{t('admin.stateActive')}</Badge>
                        ) : (
                          <Badge tone="inactive">{t('admin.stateHidden')}</Badge>
                        )}
                      </td>
                      <td class="adm-actions">
                        <Button
                          size="sm"
                          testId="admin-pack-toggle"
                          busy={busy === p.id}
                          onClick={() => void toggle(p)}
                        >
                          {p.active ? t('admin.hidePack') : t('admin.showPack')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </ResourceState>
    </section>
  );
}
