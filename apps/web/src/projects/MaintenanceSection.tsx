import { useState } from 'preact/hooks';
import {
  CURRENCIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATES,
  mutate,
  newRow,
  type MaintenancePriority,
  type MaintenanceState,
  type Row,
} from '../db';
import { fmt, t } from '../i18n';
import { Badge, Button, Field, Select, toast, type BadgeTone } from '../ui';
import { enumLabel } from './labels';
import { canAddMaintenance, canChangeMaintenance, type Actor } from './permissions';
import { kickSync } from './review';

type Entry = Row<'project_maintenance'>;

export const PRIORITY_TONES: Record<MaintenancePriority, BadgeTone> = {
  urgent: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

export const STATE_TONES: Record<MaintenanceState, BadgeTone> = {
  open: 'warning',
  in_progress: 'info',
  done: 'success',
  cancelled: 'neutral',
};

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <Badge
      tone={PRIORITY_TONES[priority as MaintenancePriority] ?? 'neutral'}
      testId="maintenance-priority"
    >
      {enumLabel('maintenance_priority', priority)}
    </Badge>
  );
}

export function MaintenanceStateBadge({ state }: { state: string }) {
  return (
    <Badge tone={STATE_TONES[state as MaintenanceState] ?? 'neutral'} testId="maintenance-state">
      {enumLabel('maintenance_state', state)}
    </Badge>
  );
}

function today(): string {
  const d = new Date();
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Changes the state of an entry; closing it stamps the resolution day. */
export async function setMaintenanceState(entry: Entry, state: MaintenanceState): Promise<void> {
  const closed = state === 'done' || state === 'cancelled';
  await mutate('project_maintenance', entry.id, {
    state,
    resolved_on: closed ? (entry.resolved_on ?? today()) : null,
  });
  kickSync();
}

interface Draft {
  description: string;
  priority: MaintenancePriority;
  reported_on: string;
  estimated_cost: string;
  currency: string;
}

const emptyDraft = (currency: string): Draft => ({
  description: '',
  priority: 'medium',
  reported_on: today(),
  estimated_cost: '',
  currency,
});

function AddEntryForm({
  projectId,
  currency,
  onDone,
}: {
  projectId: string;
  currency: string;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(currency));
  const [errors, setErrors] = useState<{ description?: string; cost?: string }>({});
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));

  const save = async (event: Event): Promise<void> => {
    event.preventDefault();
    const next: typeof errors = {};
    if (!draft.description.trim()) next.description = t('projects.maintenanceDescriptionRequired');
    const cost = draft.estimated_cost.trim() === '' ? null : Number(draft.estimated_cost);
    if (cost !== null && (!Number.isFinite(cost) || cost < 0))
      next.cost = t('projects.maintenanceCostInvalid');
    setErrors(next);
    if (next.description || next.cost) return;
    setBusy(true);
    try {
      const row = newRow('project_maintenance', {
        project_id: projectId,
        description: draft.description.trim(),
        priority: draft.priority,
        reported_on: draft.reported_on || today(),
        estimated_cost: cost,
        currency: cost === null ? null : draft.currency || null,
        state: 'open',
      });
      await mutate('project_maintenance', row.id, row, { insert: true });
      kickSync();
      toast(t('projects.maintenanceAdded'), 'success');
      onDone();
    } catch {
      toast(t('projects.actionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="pform" data-testid="maintenance-form" noValidate onSubmit={(e) => void save(e)}>
      <Field
        label={t('projects.maintenanceDescription')}
        htmlFor="mnt-description"
        required
        error={errors.description}
      >
        <textarea
          data-testid="maintenance-description"
          data-autofocus
          rows={3}
          maxLength={2000}
          value={draft.description}
          onInput={(e) => set({ description: e.currentTarget.value })}
        />
      </Field>
      <div class="pform__row">
        <Field label={t('projects.maintenancePriority')} htmlFor="mnt-priority">
          <Select
            testId="maintenance-priority-input"
            options={MAINTENANCE_PRIORITIES.map((p) => ({
              value: p,
              label: enumLabel('maintenance_priority', p),
            }))}
            value={draft.priority}
            onChange={(v) => set({ priority: (v || 'medium') as MaintenancePriority })}
          />
        </Field>
        <Field label={t('projects.maintenanceReportedOn')} htmlFor="mnt-date">
          <input
            type="date"
            class="control"
            data-testid="maintenance-date"
            value={draft.reported_on}
            onInput={(e) => set({ reported_on: e.currentTarget.value })}
          />
        </Field>
        <Field label={t('projects.maintenanceCost')} htmlFor="mnt-cost" error={errors.cost}>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            class="control"
            data-testid="maintenance-cost"
            value={draft.estimated_cost}
            onInput={(e) => set({ estimated_cost: e.currentTarget.value })}
          />
        </Field>
        <Field label={t('projects.maintenanceCurrency')} htmlFor="mnt-currency">
          <Select
            testId="maintenance-currency"
            options={CURRENCIES.map((c) => ({
              value: c,
              label: `${c} — ${enumLabel('currency', c)}`,
            }))}
            value={draft.currency}
            onChange={(v) => set({ currency: v })}
          />
        </Field>
      </div>
      <div class="prow__actions">
        <Button type="submit" variant="primary" busy={busy} testId="maintenance-save">
          {t('projects.maintenanceSave')}
        </Button>
        <Button testId="maintenance-cancel" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function EntryRow({ entry, actor }: { entry: Entry; actor: Actor }) {
  const [busy, setBusy] = useState(false);
  const editable = canChangeMaintenance(entry, actor);
  const change = async (value: string): Promise<void> => {
    if (!value || value === entry.state) return;
    setBusy(true);
    try {
      await setMaintenanceState(entry, value as MaintenanceState);
      toast(t('projects.maintenanceStateChanged'), 'success');
    } catch {
      toast(t('projects.actionFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class="prow" data-testid="maintenance-entry" data-id={entry.id} data-state={entry.state}>
      <div class="prow__head">
        <PriorityBadge priority={entry.priority} />
        <MaintenanceStateBadge state={entry.state} />
        <span class="prow__meta">{fmt.date(entry.reported_on)}</span>
        {entry._dirty === 1 && <span class="prow__meta">· {t('projects.flagUnsynced')}</span>}
      </div>
      <p class="prow__title" dir="auto">
        {entry.description}
      </p>
      <div class="prow__meta">
        {entry.estimated_cost !== null &&
          t('projects.maintenanceCostValue', {
            value: entry.currency
              ? fmt.currency(entry.estimated_cost, entry.currency)
              : fmt.number(entry.estimated_cost),
          })}
        {entry.resolved_on &&
          ` · ${t('projects.maintenanceResolvedOn', { date: fmt.date(entry.resolved_on) })}`}
      </div>
      {editable && (
        <div class="prow__actions">
          <label class="sr-only" for={`mnt-state-${entry.id}`}>
            {t('projects.maintenanceChangeState')}
          </label>
          <Select
            id={`mnt-state-${entry.id}`}
            testId="maintenance-state-select"
            options={MAINTENANCE_STATES.map((s) => ({
              value: s,
              label: enumLabel('maintenance_state', s),
            }))}
            value={entry.state}
            disabled={busy}
            onChange={(v) => void change(v)}
          />
        </div>
      )}
    </li>
  );
}

/** Maintenance history (newest first), "add entry" and state changes. */
export function MaintenanceSection({
  projectId,
  entries,
  actor,
  currency,
}: {
  projectId: string;
  entries: Entry[];
  actor: Actor;
  /** Default currency of new entries (the country's). */
  currency: string;
}) {
  const [adding, setAdding] = useState(false);
  const live = entries.filter((e) => !e.deleted_at);
  return (
    <section class="psection" aria-labelledby="sec-maintenance" data-testid="details-maintenance">
      <h2 id="sec-maintenance">
        <span>{t('projects.sectionMaintenance')}</span>
        {canAddMaintenance(actor) && !adding && (
          <Button
            size="sm"
            variant="secondary"
            testId="maintenance-add"
            onClick={() => setAdding(true)}
          >
            {t('projects.maintenanceAdd')}
          </Button>
        )}
      </h2>
      {live.length === 0 ? (
        <p class="psection__empty">{t('projects.noMaintenance')}</p>
      ) : (
        <ul class="prows">
          {live.map((e) => (
            <EntryRow key={e.id} entry={e} actor={actor} />
          ))}
        </ul>
      )}
      {adding && (
        <AddEntryForm projectId={projectId} currency={currency} onDone={() => setAdding(false)} />
      )}
    </section>
  );
}
