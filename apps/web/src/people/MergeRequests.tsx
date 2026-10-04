/**
 * Merge trail for reviewers (brief §2.4: "keeps the trace of the merge and can be undone"):
 * pending requests to approve or reject, executed merges with "revert", and the decided
 * ones. Rows come from the synced `person_merge_requests` table.
 */
import { useEffect, useState } from 'preact/hooks';
import { fmt, t } from '../i18n';
import { Badge, Button, confirm, EmptyState, toast, type BadgeTone } from '../ui';
import { syncNow } from '../sync';
import { fullName, primaryName } from './display';
import {
  cachedNames,
  personsByIds,
  rememberNames,
  type MergeRequest,
  type PersonNames,
} from './queries';
import { fetchPersonNames, isOnline, revertPersonMerge, rpcErrorKey } from './rpc';

const STATE_TONE: Record<MergeRequest['state'], BadgeTone> = {
  pending: 'warning',
  merged: 'success',
  rejected: 'neutral',
  reverted: 'info',
};

/** Names of the persons of some requests: device first, then this session, then the server. */
export function useRequestNames(requests: readonly MergeRequest[]): Map<string, PersonNames> {
  const [names, setNames] = useState<Map<string, PersonNames>>(new Map());
  const key = requests.map((r) => `${r.id}:${r.state}`).join(',');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const ids = [...new Set(requests.flatMap((r) => [r.source_person_id, r.target_person_id]))];
      const out = new Map<string, PersonNames>();
      for (const [id, p] of await personsByIds(ids)) out.set(id, p);
      const missing: string[] = [];
      for (const id of ids) {
        if (out.has(id)) continue;
        const cached = cachedNames(id);
        if (cached) out.set(id, cached);
        else missing.push(id);
      }
      if (alive) setNames(new Map(out));
      if (missing.length > 0) {
        const fetched = await fetchPersonNames(missing);
        rememberNames([...fetched].map(([id, n]) => ({ id, ...n })));
        for (const [id, n] of fetched) out.set(id, n);
        if (alive) setNames(new Map(out));
      }
    })();
    return () => {
      alive = false;
    };
  }, [key]);
  return names;
}

export interface MergeRequestListProps {
  requests: readonly MergeRequest[];
  /** Open the side-by-side review of a pending request. */
  onReview: (request: MergeRequest) => void;
  onOpenPerson?: (personId: string) => void;
  canReview: boolean;
  testId?: string;
}

export function MergeRequestList({
  requests,
  onReview,
  onOpenPerson,
  canReview,
  testId = 'merge-requests',
}: MergeRequestListProps) {
  const names = useRequestNames(requests);
  const [busy, setBusy] = useState<string | null>(null);

  const label = (id: string): string => {
    const n = names.get(id);
    return n ? fullName(n) : t('people.unknownPerson');
  };

  const revert = async (r: MergeRequest): Promise<void> => {
    if (!isOnline()) {
      toast(t('people.offlineError'), 'error');
      return;
    }
    const ok = await confirm({
      title: t('people.confirmRevertTitle'),
      message: t('people.confirmRevertMessage', {
        source: label(r.source_person_id),
        target: label(r.target_person_id),
      }),
      confirmLabel: t('people.revert'),
      danger: true,
    });
    if (!ok) return;
    setBusy(r.id);
    try {
      const res = await revertPersonMerge(r.id);
      toast(
        res.skipped_staff > 0
          ? `${t('people.reverted', { restored: res.restored_staff + res.restored_collapsed })} ${t('people.revertSkipped', { count: res.skipped_staff })}`
          : t('people.reverted', { restored: res.restored_staff + res.restored_collapsed }),
        'success',
      );
      void syncNow().catch(() => undefined);
    } catch (e) {
      toast(t(rpcErrorKey(e)), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (requests.length === 0) {
    return (
      <EmptyState
        title={t('people.requestsEmpty')}
        message={t('people.requestsEmptyBody')}
        testId={`${testId}-empty`}
      />
    );
  }

  return (
    <ul class="mreq" data-testid={testId}>
      {requests.map((r) => {
        const source = names.get(r.source_person_id);
        const target = names.get(r.target_person_id);
        return (
          <li
            key={r.id}
            class="mreq__item"
            data-testid="merge-request-row"
            data-request-id={r.id}
            data-state={r.state}
          >
            <div class="mreq__main">
              <span class="mreq__pair">
                {t('people.requestPair', {
                  source: source ? primaryName(source) : t('people.unknownPerson'),
                  target: target ? primaryName(target) : t('people.unknownPerson'),
                })}
              </span>
              <span class="mreq__meta">
                <Badge tone={STATE_TONE[r.state]}>{t(`people.state_${r.state}`)}</Badge>{' '}
                {r.decided_at
                  ? t('people.decidedAt', { time: fmt.dateTime(r.decided_at) })
                  : t('people.requestedAt', { time: fmt.dateTime(r.created_at) })}
              </span>
              {r.reason && (
                <span class="mreq__meta">{t('people.reasonShown', { reason: r.reason })}</span>
              )}
            </div>
            <div class="mreq__actions">
              {onOpenPerson && r.state !== 'merged' && (
                <Button
                  size="sm"
                  variant="ghost"
                  testId="merge-open-source"
                  onClick={() => onOpenPerson(r.source_person_id)}
                >
                  {t('people.openSource')}
                </Button>
              )}
              {canReview && r.state === 'pending' && (
                <Button
                  size="sm"
                  variant="primary"
                  testId="merge-review"
                  onClick={() => onReview(r)}
                >
                  {t('people.review')}
                </Button>
              )}
              {canReview && r.state === 'merged' && (
                <Button
                  size="sm"
                  variant="danger"
                  testId="merge-revert"
                  busy={busy === r.id}
                  onClick={() => void revert(r)}
                >
                  {t('people.revert')}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
