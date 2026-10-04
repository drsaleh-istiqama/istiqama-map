/**
 * Exchange rates (brief §2.4: salaries are never added across currencies without
 * conversion). One row per currency and effective date; reports use the latest rate on or
 * before today. While `app_settings['fx.placeholder']` is set the rates are the indicative
 * values of migration 0062 and every USD figure is approximate: the panel says so and lets
 * the head office clear the flag once real rates are entered (reference-data.md §4).
 */
import { useState } from 'preact/hooks';
import { fmt, t } from '../i18n';
import {
  Badge,
  Button,
  confirm,
  EmptyState,
  Field,
  IconAlert,
  IconPlus,
  Modal,
  toast,
} from '../ui';
import { insertRow, listRows, softDeleteRow, updateRow } from './api';
import { CurrencyInput } from './CurrencyInput';
import { adminErrorKey } from './errors';
import { clearFxPlaceholder, fxPlaceholderActive } from './settingsSchema';
import { errorText, FormError, Ltr, ResourceState, useCloseGuard, useResource } from './shared';
import type { FxRateRec, SettingRec } from './types';
import { validateFxRate, type Errors, type FxDraft, type FxField } from './validate';

interface Data {
  rates: FxRateRec[];
  flag: SettingRec | null;
}

async function load(): Promise<Data> {
  const [rates, settings] = await Promise.all([
    listRows<FxRateRec>('fx_rates'),
    listRows<SettingRec>('app_settings'),
  ]);
  return { rates, flag: settings.find((s) => s.key === 'fx.placeholder' && !s.deleted_at) ?? null };
}

function today(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** Id of the rate in force today per currency (latest effective date ≤ today). */
export function ratesInForce(rates: readonly FxRateRec[], on = today()): Set<string> {
  const best = new Map<string, FxRateRec>();
  for (const r of rates) {
    if (r.deleted_at || r.effective_date > on) continue;
    const current = best.get(r.currency);
    if (!current || r.effective_date > current.effective_date) best.set(r.currency, r);
  }
  return new Set([...best.values()].map((r) => r.id));
}

/** "1 USD = 2,631.58 TZS" helper text. */
function inverse(rate: number): string {
  return rate > 0 ? fmt.number(Math.round((1 / rate) * 100) / 100) : '—';
}

export function FxPanel() {
  const data = useResource(load);
  const [editing, setEditing] = useState<FxRateRec | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const clearFlag = async (flag: SettingRec): Promise<void> => {
    const ok = await confirm({
      title: t('admin.fxClearTitle'),
      message: t('admin.fxClearBody'),
      confirmLabel: t('admin.fxClear'),
    });
    if (!ok) return;
    setBusy('flag');
    try {
      await updateRow('app_settings', flag, { value: clearFxPlaceholder(flag.value) });
      toast(t('admin.fxCleared'), 'success');
    } catch (e) {
      toast(t(adminErrorKey(e)), 'error');
    } finally {
      setBusy(null);
      await data.reload();
    }
  };

  const remove = async (rate: FxRateRec): Promise<void> => {
    const ok = await confirm({
      title: t('admin.deleteRateTitle'),
      message: t('admin.deleteRateBody', {
        currency: rate.currency,
        date: fmt.date(rate.effective_date),
      }),
      confirmLabel: t('admin.delete'),
      danger: true,
    });
    if (!ok) return;
    setBusy(rate.id);
    try {
      await softDeleteRow('fx_rates', rate);
      toast(t('admin.deleted'), 'success');
    } catch (e) {
      toast(t(adminErrorKey(e)), 'error');
    } finally {
      setBusy(null);
      await data.reload();
    }
  };

  return (
    <section class="adm-panel" aria-labelledby="adm-fx-title" data-testid="admin-fx">
      <div class="adm-panel__head">
        <h2 id="adm-fx-title">{t('admin.fxTitle')}</h2>
        <Button
          variant="gold"
          icon={<IconPlus size={18} />}
          testId="admin-fx-add"
          onClick={() => setEditing('new')}
        >
          {t('admin.addRate')}
        </Button>
      </div>
      <ResourceState resource={data} testId="admin-fx">
        {({ rates, flag }) => {
          const live = rates.filter((r) => !r.deleted_at);
          const inForce = ratesInForce(live);
          const placeholder = flag !== null && fxPlaceholderActive(flag.value);
          return (
            <>
              {placeholder && flag && (
                <div
                  class="adm-banner adm-banner--warning"
                  role="note"
                  data-testid="admin-fx-placeholder"
                >
                  <IconAlert size={20} />
                  <div>
                    <strong>{t('admin.fxPlaceholderTitle')}</strong>
                    <p>{t('admin.fxPlaceholderBody')}</p>
                    <Button
                      size="sm"
                      variant="primary"
                      testId="admin-fx-clear"
                      busy={busy === 'flag'}
                      onClick={() => void clearFlag(flag)}
                    >
                      {t('admin.fxClear')}
                    </Button>
                  </div>
                </div>
              )}
              <p class="adm-note">{t('admin.fxIntro')}</p>
              {live.length === 0 ? (
                <EmptyState title={t('admin.noRates')} />
              ) : (
                <div class="adm-table-wrap">
                  <table class="adm-table" data-testid="admin-fx-table">
                    <thead>
                      <tr>
                        <th scope="col">{t('admin.colCurrency')}</th>
                        <th scope="col">{t('admin.colRate')}</th>
                        <th scope="col">{t('admin.colInverse')}</th>
                        <th scope="col">{t('admin.colEffective')}</th>
                        <th scope="col">
                          <span class="sr-only">{t('admin.colActions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {live.map((r) => (
                        <tr
                          key={r.id}
                          data-testid="admin-fx-row"
                          data-currency={r.currency}
                          data-date={r.effective_date}
                        >
                          <td>
                            <Ltr class="mono">{r.currency}</Ltr>{' '}
                            <span class="muted">{t(`enum.currency.${r.currency}`)}</span>
                          </td>
                          <td>
                            <Ltr class="mono">{String(r.usd_per_unit)}</Ltr>
                          </td>
                          <td>
                            <Ltr>
                              {t('admin.inverseRate', {
                                value: inverse(Number(r.usd_per_unit)),
                                currency: r.currency,
                              })}
                            </Ltr>
                          </td>
                          <td>
                            {fmt.date(r.effective_date)}{' '}
                            {inForce.has(r.id) && (
                              <Badge tone="success">{t('admin.inForce')}</Badge>
                            )}
                          </td>
                          <td class="adm-actions">
                            <Button size="sm" testId="admin-fx-edit" onClick={() => setEditing(r)}>
                              {t('admin.edit')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              testId="admin-fx-delete"
                              busy={busy === r.id}
                              onClick={() => void remove(r)}
                            >
                              {t('admin.delete')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </ResourceState>
      {editing && data.data && (
        <FxDialog
          rate={editing === 'new' ? null : editing}
          existing={data.data.rates}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void data.reload();
          }}
        />
      )}
    </section>
  );
}

export function FxDialog({
  rate,
  existing,
  onClose,
  onSaved,
}: {
  rate: FxRateRec | null;
  existing: readonly FxRateRec[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial: FxDraft = {
    currency: rate?.currency ?? '',
    usd_per_unit: rate ? String(rate.usd_per_unit) : '',
    effective_date: rate?.effective_date ?? today(),
  };
  const [draft, setDraft] = useState<FxDraft>(initial);
  const [errors, setErrors] = useState<Errors<FxField>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const guard = useCloseGuard(dirty && !busy);
  const set = (patch: Partial<FxDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const preview = Number(draft.usd_per_unit.replace(',', '.'));

  const save = async (): Promise<void> => {
    if (busy) return;
    const checked = validateFxRate(draft, existing, rate?.id ?? null);
    setErrors(checked.errors);
    setFailure(null);
    if (!checked.ok) return;
    setBusy(true);
    try {
      if (rate) await updateRow('fx_rates', rate, { ...checked.value });
      else await insertRow('fx_rates', { ...checked.value });
      toast(t('admin.saved'), 'success');
      onSaved();
    } catch (e) {
      setFailure(t(adminErrorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={rate ? t('admin.editRateTitle') : t('admin.addRateTitle')}
      onClose={onClose}
      confirmClose={guard}
      testId="admin-fx-dialog"
      footer={
        <>
          <Button
            testId="admin-fx-cancel"
            onClick={() => void guard().then((ok) => ok && onClose())}
          >
            {t('admin.cancel')}
          </Button>
          <Button variant="primary" busy={busy} testId="admin-fx-save" onClick={() => void save()}>
            {t('admin.save')}
          </Button>
        </>
      }
    >
      <form
        class="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field
          label={t('admin.fieldCurrency')}
          htmlFor="admin-fx-currency"
          required
          error={errorText(errors.currency)}
        >
          <CurrencyInput
            testId="admin-fx-currency"
            value={draft.currency}
            onChange={(currency) => set({ currency })}
          />
        </Field>
        <Field
          label={t('admin.fieldUsdPerUnit')}
          htmlFor="admin-fx-rate"
          required
          error={errorText(errors.usd_per_unit)}
          hint={
            preview > 0 && draft.currency
              ? t('admin.rateHintWithInverse', {
                  currency: draft.currency,
                  inverse: inverse(preview),
                })
              : t('admin.rateHint')
          }
        >
          <input
            class="control mono"
            dir="ltr"
            inputMode="decimal"
            data-testid="admin-fx-rate"
            value={draft.usd_per_unit}
            maxLength={22}
            onInput={(e) => set({ usd_per_unit: e.currentTarget.value })}
          />
        </Field>
        <Field
          label={t('admin.fieldEffectiveDate')}
          htmlFor="admin-fx-date"
          required
          error={errorText(errors.effective_date)}
          hint={t('admin.effectiveHint')}
        >
          <input
            class="control"
            type="date"
            dir="ltr"
            data-testid="admin-fx-date"
            value={draft.effective_date}
            onInput={(e) => set({ effective_date: e.currentTarget.value })}
          />
        </Field>
        <FormError message={failure} testId="admin-fx-error" />
      </form>
    </Modal>
  );
}
