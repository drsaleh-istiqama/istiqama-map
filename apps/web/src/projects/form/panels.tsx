/**
 * Pieces around the form: the completeness indicator (brief §7.5), the duplicate dialog
 * (§7.3) and the list of unfinished entries (§7.4).
 */
import { fmt, pickName, t } from '../../i18n';
import type { DuplicateHit, ProjectBundle } from '../../db';
import { missingCompletenessKeys, projectCompleteness } from '../../lib/completeness';
import { Button, Modal, confirm } from '../../ui';
import { StatusBadge, TypeIcon, typeLabel } from '../labels';
import type { DraftSummary } from './drafts';

// ---------------------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------------------

export function Completeness({ bundle }: { bundle: ProjectBundle }) {
  const pct = projectCompleteness(bundle);
  const missing = missingCompletenessKeys(bundle);
  return (
    <div class="pf-complete" data-testid="form-completeness" data-value={String(pct)}>
      <div class="pf-complete__row">
        <span class="pf-complete__label">{t('form.completeness', { pct: fmt.number(pct) })}</span>
        <div
          class="meter pf-complete__meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t('form.completenessLabel')}
        >
          <div class="meter__fill" style={{ inlineSize: `${pct}%` }} />
        </div>
      </div>
      {missing.length > 0 && (
        <details class="pf-complete__missing">
          <summary data-testid="form-missing-toggle">
            {t('form.missingTitle', { count: missing.length })}
          </summary>
          <ul data-testid="form-missing">
            {missing.map((k) => (
              <li key={k} data-key={k}>
                {t(`form.missing_${k}`)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** One-line meter for the sticky action bar (the full block with the list is in the form). */
export function CompletenessMeter({ bundle }: { bundle: ProjectBundle }) {
  const pct = projectCompleteness(bundle);
  return (
    <div class="pf-complete__row pf-complete--compact" aria-hidden="true">
      <span class="pf-complete__label">{t('form.completeness', { pct: fmt.number(pct) })}</span>
      <div class="meter pf-complete__meter">
        <div class="meter__fill" style={{ inlineSize: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------------------

function reasonText(hit: DuplicateHit): string {
  const parts: string[] = [];
  if ((hit.reason === 'nearby' || hit.reason === 'both') && hit.distance_m !== null) {
    parts.push(t('form.dupNearby', { m: fmt.number(Math.round(hit.distance_m)) }));
  } else if (hit.reason === 'nearby' || hit.reason === 'both') {
    parts.push(t('form.dupNearbyNoDistance'));
  }
  if (hit.reason === 'similar_name' || hit.reason === 'both') parts.push(t('form.dupSimilarName'));
  return parts.join(t('form.listSep'));
}

export function DuplicateDialog({
  hits,
  onOpen,
  onDifferent,
  onCancel,
}: {
  hits: DuplicateHit[];
  onOpen: (hit: DuplicateHit) => void;
  onDifferent: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open
      size="lg"
      title={t('form.dupTitle')}
      testId="form-dup-dialog"
      onClose={onCancel}
      footer={
        <>
          <Button testId="form-dup-cancel" onClick={onCancel}>
            {t('form.dupBack')}
          </Button>
          <Button
            variant="primary"
            testId="form-dup-different"
            data-autofocus
            onClick={onDifferent}
          >
            {t('form.dupDifferent')}
          </Button>
        </>
      }
    >
      <p>{t('form.dupIntro')}</p>
      <ul class="pf-dups pf-dialog">
        {hits.map((hit) => (
          <li key={hit.id} class="pf-dup" data-testid="form-dup-row">
            <TypeIcon type={hit.type} size={24} />
            <div class="pf-dup__text">
              <strong>{pickName(hit)}</strong>
              <span class="muted">
                {typeLabel(hit.type)}
                {hit.code && (
                  <>
                    {' · '}
                    <span class="ltr">{hit.code}</span>
                  </>
                )}
              </span>
              <span class="pf-dup__reason">{reasonText(hit)}</span>
            </div>
            <StatusBadge status={hit.status} />
            <Button size="sm" testId="form-dup-open" data-id={hit.id} onClick={() => onOpen(hit)}>
              {t('form.dupSame')}
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------
// Unfinished entries
// ---------------------------------------------------------------------------------------

export function DraftsPanel({
  items,
  onResume,
  onDiscard,
}: {
  items: DraftSummary[];
  onResume: (d: DraftSummary) => void;
  onDiscard: (d: DraftSummary) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section class="card pf-drafts" aria-labelledby="pf-drafts-title" data-testid="form-drafts">
      <h2 id="pf-drafts-title">{t('form.draftsTitle', { count: items.length })}</h2>
      <ul class="pf-drafts__list">
        {items.map((d) => {
          const p = d.draft.working.project;
          const name = pickName(p) || t('form.untitled');
          return (
            <li key={d.key} class="pf-drafts__item" data-testid="form-draft-row">
              <TypeIcon type={p.type} size={20} />
              <div class="pf-drafts__text">
                <strong>{name}</strong>
                <span class="muted">
                  {d.draft.mode === 'edit' ? t('form.draftEdit') : t('form.draftNew')}
                  {' · '}
                  {fmt.relative(new Date(d.updatedAt))}
                </span>
              </div>
              <Button
                size="sm"
                variant="primary"
                testId="form-draft-resume"
                onClick={() => onResume(d)}
              >
                {t('form.draftResume')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                testId="form-draft-discard"
                onClick={async () => {
                  const ok = await confirm({
                    title: t('form.draftDiscardTitle'),
                    message: t('form.draftDiscardBody', { name }),
                    confirmLabel: t('form.discard'),
                    danger: true,
                  });
                  if (ok) onDiscard(d);
                }}
              >
                {t('form.discard')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
