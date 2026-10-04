import type { SearchProjectRef } from '../db';
import { fmt, pickName, t } from '../i18n';
import { Link, Spinner } from '../ui';
import { enumLabel, TypeIcon } from './labels';
import type { MergedHit, SearchState } from './search';

function ProjectRefLink({ p }: { p: SearchProjectRef }) {
  return (
    <li>
      <Link href={`/projects/${p.id}`} class="phits__project" testId="search-hit-project">
        <TypeIcon type={p.type} size={18} />
        <bdi>{pickName(p) || p.code}</bdi>
        {p.role && <span class="muted"> · {enumLabel('staff_role', p.role)}</span>}
      </Link>
    </li>
  );
}

function HitBody({ hit, onLocality }: { hit: MergedHit; onLocality: (name: string) => void }) {
  switch (hit.kind) {
    case 'project':
      return (
        <Link href={`/projects/${hit.id}`} class="phits__project" testId="search-hit-project">
          <TypeIcon type={hit.type} size={18} />
          <bdi>{pickName(hit) || hit.code}</bdi>
          {hit.code && (
            <span class="ltr muted" dir="ltr">
              {hit.code}
            </span>
          )}
          {!hit.local && <span class="phits__note">{t('projects.hitNotOnDevice')}</span>}
        </Link>
      );
    case 'locality': {
      const name = pickName(hit);
      return (
        <button type="button" class="phits__locality" onClick={() => onLocality(name)}>
          <span class="phits__kind">{t('projects.hitLocality')}</span>
          <bdi>{name}</bdi>
          {hit.status === 'proposed' && (
            <span class="muted"> · {t('projects.localityProposed')}</span>
          )}
        </button>
      );
    }
    case 'staff':
    case 'donor':
      return (
        <div>
          <div class="phits__head">
            <span class="phits__kind">
              {hit.kind === 'staff' ? t('projects.hitStaff') : t('projects.hitDonor')}
            </span>
            <bdi class="phits__name">{pickName(hit)}</bdi>
            <span class="muted">
              {' '}
              · {t('projects.hitProjectsCount', { count: fmt.number(hit.projects_count) })}
            </span>
          </div>
          <ul class="phits__projects">
            {hit.projects.map((p) => (
              <ProjectRefLink key={p.id} p={p} />
            ))}
          </ul>
        </div>
      );
  }
}

/**
 * Hits that the register itself does not show: people (staff), donors and localities with the
 * projects they lead to, and projects the server found that are not on this device yet.
 */
export function SearchHits({
  state,
  onLocality,
}: {
  state: SearchState;
  onLocality: (name: string) => void;
}) {
  const extra = state.hits.filter((h) => h.kind !== 'project' || !h.local);
  if (extra.length === 0 && !state.pending) return null;
  return (
    <section class="phits" data-testid="search-hits" aria-label={t('projects.hitsTitle')}>
      {extra.length > 0 && (
        <ul class="phits__list">
          {extra.map((hit) => (
            <li
              key={`${hit.kind}:${hit.id}`}
              class="phits__item"
              data-testid="search-hit"
              data-kind={hit.kind}
            >
              <HitBody hit={hit} onLocality={onLocality} />
            </li>
          ))}
        </ul>
      )}
      {state.pending && (
        <p class="phits__pending muted">
          <Spinner size={16} /> {t('projects.searchingServer')}
        </p>
      )}
    </section>
  );
}
