/**
 * Step 5 (brief §7.10): the status, always visible. Switching to "needs maintenance" opens a
 * new `project_maintenance` entry (date, description, priority, estimated cost + currency,
 * state). The entry being typed lives in the draft (`extras.pendingMaintenance`), so the
 * autosave keeps it and the dialog comes back after back / reload (§7.4).
 */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { fmt, t } from '../../../i18n';
import {
  CURRENCIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATES,
  OPEN_MAINTENANCE_STATES,
  PROJECT_STATUSES,
  newRow,
  type Row,
} from '../../../db';
import { Button, Field, Modal, confirm } from '../../../ui';
import { StatusBadge, enumLabel, statusLabel } from '../../labels';
import { useForm } from '../context';
import { DateInput, EnumSelect, F, NumberInput, TextArea } from '../controls';
import { isLive, pendingMaintenanceChanged, today } from '../model';
import { validateMaintenance } from '../validate';

type Maint = Row<'project_maintenance'>;

export function StatusSection() {
  const { draft, api, env } = useForm();
  const p = draft.working.project;
  const pending = draft.extras.pendingMaintenance ?? null;
  const originalIds = new Set((draft.original?.maintenance ?? []).map((m) => m.id));
  const live = draft.working.maintenance.filter(isLive);
  const added = live.filter((m) => !originalIds.has(m.id));
  const openExisting = live.filter(
    (m) => originalIds.has(m.id) && OPEN_MAINTENANCE_STATES.includes(m.state),
  );
  const hasOpen = live.some((m) => OPEN_MAINTENANCE_STATES.includes(m.state));

  const blankEntry = (): Maint =>
    newRow('project_maintenance', {
      project_id: p.id,
      reported_on: today(),
      priority: 'medium',
      state: 'open',
      currency: env.currency,
    } as Partial<Maint>);

  const openDialog = (entry: Maint): void =>
    api.setExtras({ pendingMaintenance: { base: entry, row: entry } });
  const closeDialog = (): void => api.setExtras({ pendingMaintenance: null });
  const patchPending = (patch: Partial<Maint>): void =>
    api.update((d) => {
      const pm = d.extras.pendingMaintenance;
      if (!pm) return d;
      return {
        ...d,
        extras: { ...d.extras, pendingMaintenance: { ...pm, row: { ...pm.row, ...patch } } },
      };
    });
  const savePending = (row: Maint): void =>
    // One change: the entry joins the list and the dialog state goes, in the same autosave.
    api.update((d) => {
      const exists = d.working.maintenance.some((m) => m.id === row.id);
      return {
        ...d,
        working: {
          ...d.working,
          maintenance: exists
            ? d.working.maintenance.map((m) => (m.id === row.id ? { ...m, ...row } : m))
            : [...d.working.maintenance, row],
        },
        extras: { ...d.extras, pendingMaintenance: null },
      };
    });

  const onStatus = (code: string | null): void => {
    if (!code) return;
    const before = p.status;
    api.setProject({ status: code as Row<'projects'>['status'] });
    api.clearError('status');
    if (code === 'maintenance' && before !== 'maintenance' && !hasOpen && !pending)
      openDialog(blankEntry());
  };

  return (
    <div class="pf-step pf-status">
      <F k="status" label={t('form.status')} required hint={t('form.statusHint')}>
        <EnumSelect
          enumKey="project_status"
          codes={PROJECT_STATUSES}
          value={p.status}
          testId="form-status"
          onValue={onStatus}
        />
      </F>
      <div class="pf-status__badge" aria-hidden="true">
        <StatusBadge status={p.status} />
      </div>

      {(p.status === 'maintenance' || live.length > 0) && (
        <div class="pf-maint" data-testid="form-maintenance">
          {openExisting.length > 0 && (
            <p class="muted">{t('form.maintOpenExisting', { count: openExisting.length })}</p>
          )}
          {added.length > 0 && (
            <ul class="pf-maint__list">
              {added.map((m) => (
                <li key={m.id} class="pf-maint__item" data-testid="form-maintenance-entry">
                  <div class="pf-maint__text">
                    <strong>{m.description}</strong>
                    <span class="muted">
                      {enumLabel('maintenance_priority', m.priority)} · {fmt.date(m.reported_on)}
                      {typeof m.estimated_cost === 'number' && m.currency
                        ? ` · ${fmt.currency(m.estimated_cost, m.currency)}`
                        : ''}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    testId="form-maintenance-edit"
                    onClick={() => openDialog({ ...m })}
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    testId="form-maintenance-remove"
                    onClick={async () => {
                      const ok = await confirm({
                        title: t('form.maintRemoveTitle'),
                        message: m.description,
                        confirmLabel: t('common.delete'),
                        danger: true,
                      });
                      if (ok) api.removeRow('maintenance', m.id);
                    }}
                  >
                    {t('common.delete')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {p.status === 'maintenance' && !hasOpen && (
            <p class="pf-note pf-note--warn">{t('form.maintMissing')}</p>
          )}
          <Button size="sm" testId="form-maintenance-add" onClick={() => openDialog(blankEntry())}>
            {t('form.maintAdd')}
          </Button>
        </div>
      )}

      {pending && (
        <MaintenanceDialog
          entry={pending.base}
          row={pending.row}
          isNew={!live.some((m) => m.id === pending.base.id)}
          statusName={statusLabel('maintenance')}
          onPatch={patchPending}
          onCancel={closeDialog}
          onSave={savePending}
        />
      )}
    </div>
  );
}

async function confirmDiscard(): Promise<boolean> {
  return confirm({
    title: t('form.maintDiscardTitle'),
    message: t('form.maintDiscardBody'),
    confirmLabel: t('form.discard'),
    danger: true,
  });
}

/**
 * New / edited maintenance entry. Controlled: `row` (what is typed) is held by the caller in
 * the autosaved draft. Esc, the close button and "Cancel" ask before dropping input.
 */
export function MaintenanceDialog({
  entry,
  row,
  isNew,
  onPatch,
  onSave,
  onCancel,
}: {
  /** The entry as the dialog opened. */
  entry: Maint;
  row: Maint;
  isNew: boolean;
  statusName: string;
  onPatch: (patch: Partial<Maint>) => void;
  onSave: (row: Maint) => void;
  onCancel: () => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<Maint>): void => onPatch(patch);
  const changed = pendingMaintenanceChanged({ base: entry, row });

  const submit = (): void => {
    const found = validateMaintenance(row);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      document.getElementById(`pf-maint-${first}`)?.focus();
      return;
    }
    onSave({ ...row, description: row.description.trim() });
  };

  const err = (k: string): string | null => (errors[k] ? t(errors[k]!) : null);

  return (
    <Modal
      open
      title={isNew ? t('form.maintNewTitle') : t('form.maintEditTitle')}
      testId="form-maintenance-dialog"
      onClose={onCancel}
      confirmClose={async () => !changed || confirmDiscard()}
      footer={
        <>
          <Button
            testId="form-maint-cancel"
            onClick={async () => {
              if (!changed || (await confirmDiscard())) onCancel();
            }}
          >
            {t('ui.cancel')}
          </Button>
          <Button variant="primary" testId="form-maint-save" onClick={submit}>
            {t('form.maintSave')}
          </Button>
        </>
      }
    >
      <p class="muted">{t('form.maintIntro')}</p>
      <MaintField
        id="description"
        label={t('form.maintDescription')}
        required
        error={err('description')}
      >
        <TextArea
          value={row.description}
          testId="form-maint-description"
          onValue={(v) => set({ description: v })}
        />
      </MaintField>
      <div class="pf-grid2">
        <MaintField
          id="reported_on"
          label={t('form.maintDate')}
          required
          error={err('reported_on')}
        >
          <DateInput
            value={row.reported_on}
            testId="form-maint-date"
            onValue={(v) => set({ reported_on: v ?? '' })}
          />
        </MaintField>
        <MaintField id="priority" label={t('form.maintPriority')} required>
          <EnumSelect
            enumKey="maintenance_priority"
            codes={MAINTENANCE_PRIORITIES}
            value={row.priority}
            testId="form-maint-priority"
            onValue={(v) => v && set({ priority: v as Maint['priority'] })}
          />
        </MaintField>
        <MaintField id="estimated_cost" label={t('form.maintCost')} error={err('estimated_cost')}>
          <NumberInput
            decimal
            value={row.estimated_cost}
            testId="form-maint-cost"
            onValue={(v) => set({ estimated_cost: v })}
          />
        </MaintField>
        <MaintField id="currency" label={t('form.currency')}>
          <EnumSelect
            enumKey="currency"
            codes={CURRENCIES}
            value={row.currency}
            testId="form-maint-currency"
            onValue={(v) => set({ currency: v })}
          />
        </MaintField>
        <MaintField id="state" label={t('form.maintState')} required>
          <EnumSelect
            enumKey="maintenance_state"
            codes={MAINTENANCE_STATES}
            value={row.state}
            testId="form-maint-state"
            onValue={(v) => v && set({ state: v as Maint['state'] })}
          />
        </MaintField>
      </div>
    </Modal>
  );
}

function MaintField({
  id,
  label,
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string | null;
  children: ComponentChildren;
}) {
  return (
    <Field label={label} htmlFor={`pf-maint-${id}`} required={required} error={error ?? null}>
      {children}
    </Field>
  );
}
