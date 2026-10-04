/**
 * Step 4 (brief §7.1–7.2): country and administrative area, filled automatically from the
 * point (ProjectForm runs the geofill) and correctable by hand; the locality — an approved or
 * proposed locality of the area, or a new name that becomes a `proposed` locality (§2.1).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fmt, pickName, t } from '../../../i18n';
import type { Row } from '../../../db';
import { uuidv7 } from '../../../lib/uuidv7';
import { Button, IconAlert, Select, type SelectOption } from '../../../ui';
import { useForm } from '../context';
import { F, TextInput } from '../controls';
import { checkPoint, type AreaPath, type GeoCheck } from '../geo';
import { listAreas, listLocalities, getLocality, type LocalityChoice } from '../queries';

const NEW_LOCALITY = '__new__';

const deepest = (path: AreaPath): string | null => path[2] ?? path[1] ?? path[0];

function AreaSelect({
  level,
  countryId,
  parentId,
  value,
  onChange,
}: {
  level: 1 | 2 | 3;
  countryId: string | null;
  parentId: string | null;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [rows, setRows] = useState<Row<'admin_areas'>[]>([]);
  useEffect(() => {
    let alive = true;
    void listAreas(countryId, level, parentId).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [countryId, level, parentId]);
  if (!countryId || (level > 1 && !parentId) || (rows.length === 0 && !value)) return null;
  const key = level === 1 ? 'area' : `area${level}`;
  const options: SelectOption[] = rows.map((r) => ({ value: r.id, label: pickName(r) }));
  if (value && !rows.some((r) => r.id === value))
    options.push({ value, label: t('form.unknownArea') });
  return (
    <F k={key} label={t(`form.areaLevel${level}`)} required={level === 1}>
      <Select
        options={options}
        value={value}
        placeholder={t('form.choose')}
        testId={level === 1 ? 'form-area' : `form-area-${level}`}
        onChange={(v) => onChange(v === '' ? null : v)}
      />
    </F>
  );
}

export function PlaceSection() {
  const { draft, api, env } = useForm();
  const p = draft.working.project;
  const path = draft.extras.areaPath;
  const point =
    typeof p.lon === 'number' &&
    typeof p.lat === 'number' &&
    Number.isFinite(p.lon) &&
    Number.isFinite(p.lat)
      ? { lon: p.lon, lat: p.lat }
      : null;
  const [check, setCheck] = useState<GeoCheck | null>(null);

  useEffect(() => {
    let alive = true;
    if (!point || !p.country_id) {
      setCheck(null);
      return;
    }
    void checkPoint(point, { countryId: p.country_id, areaPath: path }, env.located).then(
      (c) => alive && setCheck(c),
    );
    return () => {
      alive = false;
    };
  }, [point?.lon, point?.lat, p.country_id, path[0], path[1], path[2], env.located]);

  const setCountry = (id: string | null): void => {
    api.update((d) => ({
      ...d,
      working: {
        ...d.working,
        project: { ...d.working.project, country_id: id, admin_area_id: null, locality_id: null },
      },
      extras: { ...d.extras, areaPath: [null, null, null], manualArea: true, newLocality: null },
    }));
    api.clearError('country');
  };

  const setArea = (level: 1 | 2 | 3, id: string | null): void => {
    const next: AreaPath = [
      level === 1 ? id : path[0],
      level === 2 ? id : level > 2 ? path[1] : null,
      level === 3 ? id : null,
    ];
    api.update((d) => ({
      ...d,
      working: { ...d.working, project: { ...d.working.project, admin_area_id: deepest(next) } },
      extras: { ...d.extras, areaPath: next, manualArea: true },
    }));
    api.clearError('area');
  };

  const refill = (): void => {
    api.setExtras({ geofillFor: null, manualArea: false });
  };

  const countryOptions: SelectOption[] = env.countries.map((c) => ({
    value: c.id,
    label: pickName(c),
  }));
  const filledAutomatically =
    !!point &&
    !!draft.extras.geofillFor &&
    draft.extras.geofillFor.lon === point.lon &&
    draft.extras.geofillFor.lat === point.lat &&
    !draft.extras.manualArea;

  return (
    <div class="pf-step pf-place">
      {env.locating && (
        <p class="muted pf-note" role="status" data-testid="form-geofill-busy">
          {t('form.geofillBusy')}
        </p>
      )}
      {filledAutomatically && (
        <p class="pf-note pf-note--info" data-testid="form-area-auto">
          {t('form.geofillDone')}
        </p>
      )}
      {draft.extras.manualArea && point && (
        <p class="pf-note">
          <span>{t('form.areaCorrected')}</span>{' '}
          <Button variant="ghost" size="sm" testId="form-area-refill" onClick={refill}>
            {t('form.areaRefill')}
          </Button>
        </p>
      )}
      <F k="country" label={t('form.country')} required>
        <Select
          options={countryOptions}
          value={p.country_id}
          placeholder={t('form.choose')}
          testId="form-country"
          onChange={(v) => setCountry(v === '' ? null : v)}
        />
      </F>
      <AreaSelect
        level={1}
        countryId={p.country_id}
        parentId={null}
        value={path[0]}
        onChange={(v) => setArea(1, v)}
      />
      <AreaSelect
        level={2}
        countryId={p.country_id}
        parentId={path[0]}
        value={path[1]}
        onChange={(v) => setArea(2, v)}
      />
      <AreaSelect
        level={3}
        countryId={p.country_id}
        parentId={path[1]}
        value={path[2]}
        onChange={(v) => setArea(3, v)}
      />

      {check && (check.country === 'outside' || check.area === 'outside') && (
        <p class="pf-note pf-note--warn" role="alert" data-testid="form-geo-warning">
          <IconAlert size={18} />
          <span>
            {check.country === 'outside' ? t('form.geoOutsideCountry') : t('form.geoOutsideArea')}
          </span>
        </p>
      )}

      <LocalityField point={point} />
    </div>
  );
}

/**
 * The point must stay unchanged this long before the nearby localities are read again: typing
 * coordinates digit by digit and every improving GPS fix move the point (brief §12.2 — no
 * re-reading with every keystroke). Same delay as the geofill in ProjectForm.
 */
export const LOCALITY_SETTLE_MS = 500;

function LocalityField({ point }: { point: { lon: number; lat: number } | null }) {
  const { draft, api, env } = useForm();
  const p = draft.working.project;
  const nl = draft.extras.newLocality;
  const path = draft.extras.areaPath;
  const [nearby, setNearby] = useState<LocalityChoice[]>([]);
  const [chosen, setChosen] = useState<LocalityChoice | null>(null);
  const lastPoint = useRef<string | null>(null);

  // Localities of the chosen areas and around the point: read once the point settled; a new
  // country or area (a deliberate choice) is read at once.
  useEffect(() => {
    let alive = true;
    const pointKey = point ? `${point.lon},${point.lat}` : '';
    const moved = lastPoint.current !== null && pointKey !== lastPoint.current && !!point;
    lastPoint.current = pointKey;
    const timer = setTimeout(
      () => {
        void listLocalities({ countryId: p.country_id, areaIds: path, point }).then(
          (rows) => alive && setNearby(rows),
          (error: unknown) => console.warn('[form] could not list localities', error),
        );
      },
      moved ? LOCALITY_SETTLE_MS : 0,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [p.country_id, path[0], path[1], path[2], point?.lon, point?.lat]);

  // The stored choice keeps its label even when it lies outside the list (one read by id).
  useEffect(() => {
    let alive = true;
    const id = p.locality_id;
    if (!id || id === nl?.id) {
      setChosen(null);
      return;
    }
    void getLocality(id).then((row) => {
      if (!alive) return;
      setChosen(
        row
          ? {
              id: row.id,
              name_ar: row.name_ar,
              name_latin: row.name_latin,
              status: row.status,
              admin_area_id: row.admin_area_id,
              distance_m: null,
            }
          : null,
      );
    });
    return () => {
      alive = false;
    };
  }, [p.locality_id, nl?.id]);

  const choices = useMemo(() => {
    const merged = new Map(nearby.map((l) => [l.id, l]));
    for (const l of env.located?.localities ?? []) if (!merged.has(l.id)) merged.set(l.id, l);
    if (chosen && !merged.has(chosen.id)) merged.set(chosen.id, chosen);
    return [...merged.values()];
  }, [nearby, env.located, chosen]);

  const isNew = !!nl && p.locality_id === nl.id;
  const options: SelectOption[] = choices.map((c) => ({
    value: c.id,
    label: [
      pickName(c),
      c.status === 'proposed' ? `(${t('form.localityProposed')})` : '',
      c.distance_m !== null ? `· ${fmt.number(c.distance_m)} ${t('form.metres')}` : '',
    ]
      .filter(Boolean)
      .join(' '),
  }));
  options.push({ value: NEW_LOCALITY, label: t('form.localityNew') });

  const onSelect = (v: string): void => {
    if (v === NEW_LOCALITY) {
      const fresh = nl ?? { id: uuidv7(), name_ar: '', name_latin: '' };
      api.update((d) => ({
        ...d,
        working: { ...d.working, project: { ...d.working.project, locality_id: fresh.id } },
        extras: { ...d.extras, newLocality: fresh },
      }));
    } else {
      api.update((d) => ({
        ...d,
        working: {
          ...d.working,
          project: { ...d.working.project, locality_id: v === '' ? null : v },
        },
        extras: { ...d.extras, newLocality: null },
      }));
    }
    api.clearError('locality');
  };

  const setNew = (patch: Partial<{ name_ar: string; name_latin: string }>): void => {
    if (!nl) return;
    api.setExtras({ newLocality: { ...nl, ...patch } });
    api.clearError('locality');
  };

  return (
    <div class="pf-locality">
      <F k="locality" label={t('form.locality')} hint={t('form.localityHint')}>
        <Select
          options={options}
          value={isNew ? NEW_LOCALITY : p.locality_id}
          placeholder={t('form.localityNone')}
          testId="form-locality"
          onChange={onSelect}
          disabled={!p.country_id}
        />
      </F>
      {isNew && nl && (
        <div class="pf-grid2 pf-locality__new">
          <F k="locality_new_ar" label={t('form.localityNameAr')}>
            <TextInput
              value={nl.name_ar}
              dir="auto"
              testId="form-locality-new-ar"
              onValue={(v) => setNew({ name_ar: v })}
            />
          </F>
          <F k="locality_new_latin" label={t('form.localityNameLatin')}>
            <TextInput
              value={nl.name_latin}
              dir="ltr"
              testId="form-locality-new-latin"
              onValue={(v) => setNew({ name_latin: v })}
            />
          </F>
          <p class="muted pf-note">{t('form.localityNewHint')}</p>
        </div>
      )}
    </div>
  );
}
