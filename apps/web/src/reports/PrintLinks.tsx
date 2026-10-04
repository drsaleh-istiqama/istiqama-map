/**
 * "Printable reports" (brief §9.4): open the print view of a country periodic report, a
 * donor report or a project card. Projects and donors are found in the local index
 * (`searchLocal`), so this works for 100,000 projects without loading a list.
 */
import { useEffect, useState } from 'preact/hooks';
import { searchLocal, type SearchHit } from '../db';
import { pickName, t } from '../i18n';
import { typeLabel } from '../projects/labels';
import { navigate } from '../routes';
import { Button, useDebounced } from '../ui';
import { IconPrint } from './icons';
import { printPath } from './paths';
import type { ScopeOption } from './scope';

type Hit = Extract<SearchHit, { kind: 'project' } | { kind: 'donor' }>;

export function PrintLinks({
  countries,
  initialCountry,
}: {
  countries: ScopeOption[];
  initialCountry: string | null;
}) {
  const [country, setCountry] = useState<string>(initialCountry ?? countries[0]?.id ?? '');
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 250);
  const [hits, setHits] = useState<Hit[]>([]);

  useEffect(() => {
    if (initialCountry) setCountry(initialCountry);
  }, [initialCountry]);

  useEffect(() => {
    let alive = true;
    if (query.length < 2) {
      setHits([]);
      return;
    }
    searchLocal(query, 20)
      .then((all) => {
        if (!alive) return;
        setHits(
          all.filter((h): h is Hit => h.kind === 'project' || h.kind === 'donor').slice(0, 8),
        );
      })
      .catch(() => alive && setHits([]));
    return () => {
      alive = false;
    };
  }, [query]);

  return (
    <section class="card rcard" aria-labelledby="rs-print" data-testid="print-links">
      <h2 id="rs-print" class="rcard__title">
        {t('reports.sectionPrint')}
      </h2>
      <p class="rnote">{t('reports.printHint')}</p>
      {countries.length > 0 && (
        <div class="rprint-row">
          <div class="field rprint-row__grow">
            <label class="field__label" for="print-country-select">
              {t('reports.printCountry')}
            </label>
            <select
              id="print-country-select"
              class="control select"
              data-testid="print-country-select"
              value={country}
              onChange={(e) => setCountry(e.currentTarget.value)}
            >
              {countries.map((o) => (
                <option key={o.key} value={o.id ?? ''}>
                  {o.country ? pickName(o.country) : t('reports.scopeUnknown')}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="secondary"
            icon={<IconPrint />}
            disabled={!country}
            onClick={() => navigate(printPath('country', country))}
            testId="print-country"
          >
            {t('reports.open')}
          </Button>
        </div>
      )}
      <div class="field">
        <label class="field__label" for="print-search">
          {t('reports.printFind')}
        </label>
        <input
          id="print-search"
          class="control"
          type="search"
          autocomplete="off"
          data-testid="print-search"
          placeholder={t('reports.printFindPlaceholder')}
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
      </div>
      {hits.length > 0 && (
        <ul class="rprint-hits" aria-label={t('reports.printFind')}>
          {hits.map((hit) => (
            <li key={`${hit.kind}:${hit.id}`}>
              <button
                type="button"
                class="rprint-hit"
                data-testid={`print-hit-${hit.kind}`}
                onClick={() => navigate(printPath(hit.kind, hit.id))}
              >
                <IconPrint size={18} />
                <span class="rprint-hit__name">
                  <bdi>{pickName(hit) || (hit.kind === 'project' ? hit.code : '')}</bdi>
                </span>
                <span class="rprint-hit__kind muted">
                  {hit.kind === 'project'
                    ? `${t('reports.printProjectCard')} · ${typeLabel(hit.type)}`
                    : t('reports.printDonorReport')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.length >= 2 && hits.length === 0 && <p class="muted">{t('reports.printNoHits')}</p>}
    </section>
  );
}
