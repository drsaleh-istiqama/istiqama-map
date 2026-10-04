/**
 * Home area of a person: country → region → district → ward, as cascading native selects
 * (the fastest picker on low-end phones; every list comes from the synced `admin_areas`).
 * The value is the deepest area chosen, or null.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Row } from '../db';
import { pickName, t } from '../i18n';
import { Field, Select } from '../ui';
import { areaPath, listAreas, listCountries } from './queries';

type Area = Row<'admin_areas'>;

export interface AreaPickerProps {
  value: string | null;
  onChange: (areaId: string | null) => void;
  /** Base for element ids and test ids. */
  idBase: string;
  /** Country preselected when nothing is chosen yet (the user's own country). */
  defaultCountryIso?: string | null;
}

interface Chain {
  country: string;
  l1: string;
  l2: string;
  l3: string;
}

const EMPTY: Chain = { country: '', l1: '', l2: '', l3: '' };

const byName = (a: { label: string }, b: { label: string }): number =>
  a.label.localeCompare(b.label);

export function AreaPicker({ value, onChange, idBase, defaultCountryIso }: AreaPickerProps) {
  const [chain, setChain] = useState<Chain>(EMPTY);
  const [countries, setCountries] = useState<Array<Row<'countries'>>>([]);
  const [levels, setLevels] = useState<[Area[], Area[], Area[]]>([[], [], []]);

  // Initial chain from the stored value (edit) or the user's country (new person).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await listCountries();
      if (!alive) return;
      setCountries(list);
      if (value) {
        const path = await areaPath(value);
        const first = path[0];
        if (!alive || !first) return;
        setChain({
          country: first.country_id,
          l1: path[0]?.id ?? '',
          l2: path[1]?.id ?? '',
          l3: path[2]?.id ?? '',
        });
      } else if (defaultCountryIso) {
        const c = list.find((x) => x.iso2 === defaultCountryIso.toUpperCase());
        if (c) setChain({ ...EMPTY, country: c.id });
      }
    })();
    return () => {
      alive = false;
    };
    // Only on mount: afterwards the selects own the state.
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const l1 = chain.country ? await listAreas(chain.country, null, 1) : [];
      const l2 = chain.country && chain.l1 ? await listAreas(chain.country, chain.l1, 2) : [];
      const l3 = chain.country && chain.l2 ? await listAreas(chain.country, chain.l2, 3) : [];
      if (alive) setLevels([l1, l2, l3]);
    })();
    return () => {
      alive = false;
    };
  }, [chain.country, chain.l1, chain.l2]);

  const update = (next: Chain): void => {
    setChain(next);
    onChange(next.l3 || next.l2 || next.l1 || null);
  };

  const options = (rows: Area[]) =>
    rows.map((a) => ({ value: a.id, label: pickName(a) || a.code })).sort(byName);

  return (
    <fieldset class="pp-area" data-testid={`${idBase}`}>
      <legend class="field__label">{t('people.fieldHomeArea')}</legend>
      <div class="pp-area__grid">
        <Field label={t('people.areaCountry')} htmlFor={`${idBase}-country`}>
          <Select
            testId={`${idBase}-country`}
            value={chain.country}
            placeholder={t('people.choose')}
            options={countries
              .map((c) => ({ value: c.id, label: pickName(c) || c.iso2 }))
              .sort(byName)}
            onChange={(country) => update({ ...EMPTY, country })}
          />
        </Field>
        <Field label={t('people.areaLevel1')} htmlFor={`${idBase}-l1`}>
          <Select
            testId={`${idBase}-l1`}
            value={chain.l1}
            placeholder={t('people.choose')}
            disabled={!chain.country || levels[0].length === 0}
            options={options(levels[0])}
            onChange={(l1) => update({ ...chain, l1, l2: '', l3: '' })}
          />
        </Field>
        <Field label={t('people.areaLevel2')} htmlFor={`${idBase}-l2`}>
          <Select
            testId={`${idBase}-l2`}
            value={chain.l2}
            placeholder={t('people.choose')}
            disabled={!chain.l1 || levels[1].length === 0}
            options={options(levels[1])}
            onChange={(l2) => update({ ...chain, l2, l3: '' })}
          />
        </Field>
        <Field label={t('people.areaLevel3')} htmlFor={`${idBase}-l3`}>
          <Select
            testId={`${idBase}-l3`}
            value={chain.l3}
            placeholder={t('people.choose')}
            disabled={!chain.l2 || levels[2].length === 0}
            options={options(levels[2])}
            onChange={(l3) => update({ ...chain, l3 })}
          />
        </Field>
      </div>
    </fieldset>
  );
}

/** Display text of an area chain: "Ward، District، Region". */
export function areaChainText(path: readonly Area[]): string {
  return [...path]
    .reverse()
    .map((a) => pickName(a))
    .filter(Boolean)
    .join(t('people.listSeparator'));
}
