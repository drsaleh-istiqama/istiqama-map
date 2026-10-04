import { useRef, useState } from 'preact/hooks';
import { db } from '../db';
import { fmt, t } from '../i18n';
import { useViewFilters } from '../routes';
import { EmptyState, IconLock, useLiveQuery } from '../ui';
import { ConflictsPanel } from './ConflictsPanel';
import { FailedOpsPanel } from './FailedOpsPanel';
import { LocalitiesPanel } from './LocalitiesPanel';
import { currentActor } from './permissions';
import { listOpenConflicts, listProposedLocalities } from './queries';
import { SubmittedPanel } from './SubmittedPanel';
import './projects.css';

export const REVIEW_TABS = ['submitted', 'conflicts', 'localities', 'failed'] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

const isTab = (v: unknown): v is ReviewTab =>
  typeof v === 'string' && (REVIEW_TABS as readonly string[]).includes(v);

/** Badge numbers of the tabs (index counts and small reads only). */
async function tabCounts(
  seeRestricted: boolean,
): Promise<Record<Exclude<ReviewTab, 'submitted'>, number>> {
  const [conflicts, localities, failed] = await Promise.all([
    listOpenConflicts(seeRestricted).then((r) => r.length),
    listProposedLocalities().then((r) => r.length),
    db.failed_ops.count(),
  ]);
  return { conflicts, localities, failed };
}

/**
 * Review queue (route `/review`, reviewers only): submitted records of the reviewer's scope,
 * field conflicts, proposed villages and this device's rejected operations.
 */
export default function ReviewPage() {
  const actor = currentActor();
  const [state, setState] = useViewFilters<{ tab: ReviewTab }>('review', { tab: 'submitted' });
  const tab: ReviewTab = isTab(state.tab) ? state.tab : 'submitted';
  const [submitted, setSubmitted] = useState<number | null>(null);
  const counts = useLiveQuery(() => tabCounts(actor.seeRestricted), [actor.seeRestricted]);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  if (!actor.review) {
    return (
      <div class="ppage" data-testid="review-page">
        <EmptyState
          testId="review-forbidden"
          icon={<IconLock size={40} />}
          title={t('projects.reviewForbidden')}
          message={t('projects.reviewForbiddenHint')}
        />
      </div>
    );
  }

  const countOf = (k: ReviewTab): number | null =>
    k === 'submitted' ? submitted : counts ? counts[k] : null;

  const onKeyDown = (event: KeyboardEvent): void => {
    const index = REVIEW_TABS.indexOf(tab);
    const rtl = document.documentElement.dir === 'rtl';
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = rtl ? index + 1 : index - 1;
    else if (event.key === 'ArrowRight') next = rtl ? index - 1 : index + 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = REVIEW_TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = REVIEW_TABS[(next + REVIEW_TABS.length) % REVIEW_TABS.length]!;
    setState({ tab: target });
    tabRefs.current[target]?.focus();
  };

  // The submitted queue is a virtual list: the page then fills the main area like the register.
  const fill = tab === 'submitted';
  return (
    <div class={fill ? 'ppage ppage--fill' : 'ppage'} data-testid="review-page">
      <div class="ptabs" role="tablist" aria-label={t('projects.reviewTabs')} onKeyDown={onKeyDown}>
        {REVIEW_TABS.map((k) => {
          const n = countOf(k);
          const selected = k === tab;
          return (
            <button
              key={k}
              ref={(el) => {
                tabRefs.current[k] = el;
              }}
              type="button"
              role="tab"
              id={`review-tab-${k}`}
              aria-selected={selected ? 'true' : 'false'}
              aria-controls={`review-panel-${k}`}
              tabIndex={selected ? 0 : -1}
              class={selected ? 'chip chip--on' : 'chip'}
              data-testid={`review-tab-${k}`}
              onClick={() => setState({ tab: k })}
            >
              {t(`projects.reviewTab_${k}`)}
              {n !== null && n > 0 && <span class="pcount">{fmt.number(n)}</span>}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`review-panel-${tab}`}
        aria-labelledby={`review-tab-${tab}`}
        class={fill ? 'pfill' : 'pstack'}
      >
        {/* The submitted list stays mounted so its count is known for the tab badge. */}
        <div class="pfill" hidden={tab !== 'submitted'}>
          <SubmittedPanel actor={actor} onCount={setSubmitted} />
        </div>
        {tab === 'conflicts' && <ConflictsPanel actor={actor} />}
        {tab === 'localities' && <LocalitiesPanel />}
        {tab === 'failed' && <FailedOpsPanel />}
      </div>
    </div>
  );
}
