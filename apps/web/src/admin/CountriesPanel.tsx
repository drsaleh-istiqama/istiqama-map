/**
 * Countries (brief §0: a new country is added from the console without new code; §2.1).
 * ISO codes, names in the three languages, default currency, active flag. Codes cannot be
 * changed after creation (project codes, photo paths and boundary ids derive from them).
 * Deletion is soft; a country that still has live branches is deactivated instead.
 */
import { useState } from 'preact/hooks';
import { pickName, t } from '../i18n';
import { Badge, Button, confirm, EmptyState, Field, IconPlus, Modal, toast } from '../ui';
import { insertRow, listRows, restoreRow, softDeleteRow, updateRow } from './api';
import { adminErrorKey } from './errors';
import { CurrencyInput } from './CurrencyInput';
import { errorText, FormError, Ltr, ResourceState, useCloseGuard, useResource } from './shared';
import type { BranchRec, CountryRec } from './types';
import { validateCountry, type CountryDraft, type CountryField, type Errors } from './validate';

interface Data {
  countries: CountryRec[];
  branches: BranchRec[];
}

async function load(): Promise<Data> {
  const [countries, branches] = await Promise.all([
    listRows<CountryRec>('countries'),
    listRows<BranchRec>('branches'),
  ]);
  return { countries, branches };
}

export function CountriesPanel() {
  const data = useResource(load);
  const [editing, setEditing] = useState<CountryRec | 'new' | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (country: CountryRec, branches: BranchRec[]): Promise<void> => {
    const live = branches.filter((b) => b.country_id === country.id && !b.deleted_at).length;
    if (live > 0) {
      toast(t('admin.countryHasBranches', { count: live }), 'error');
      return;
    }
    const ok = await confirm({
      title: t('admin.deleteCountryTitle'),
      message: t('admin.deleteCountryBody', { name: pickName(country) }),
      confirmLabel: t('admin.delete'),
      danger: true,
    });
    if (!ok) return;
    setBusy(country.id);
    try {
      await softDeleteRow('countries', country);
      toast(t('admin.deleted'), 'success');
      await data.reload();
    } catch (e) {
      toast(t(adminErrorKey(e)), 'error');
      await data.reload();
    } finally {
      setBusy(null);
    }
  };

  const restore = async (country: CountryRec): Promise<void> => {
    setBusy(country.id);
    try {
      await restoreRow('countries', country);
      toast(t('admin.restored'), 'success');
      await data.reload();
    } catch (e) {
      toast(t(adminErrorKey(e)), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section class="adm-panel" aria-labelledby="adm-countries-title" data-testid="admin-countries">
      <div class="adm-panel__head">
        <h2 id="adm-countries-title">{t('admin.countriesTitle')}</h2>
        <Button
          variant="gold"
          icon={<IconPlus size={18} />}
          testId="admin-country-add"
          onClick={() => setEditing('new')}
        >
          {t('admin.addCountry')}
        </Button>
      </div>
      <p class="adm-note">{t('admin.countriesIntro')}</p>
      <label class="adm-check">
        <input
          type="checkbox"
          data-testid="admin-show-deleted"
          checked={showDeleted}
          onChange={(e) => setShowDeleted(e.currentTarget.checked)}
        />
        {t('admin.showDeleted')}
      </label>
      <ResourceState resource={data} testId="admin-countries">
        {({ countries, branches }) => {
          const rows = countries.filter((c) => showDeleted || !c.deleted_at);
          if (rows.length === 0) return <EmptyState title={t('admin.noCountries')} />;
          return (
            <div class="adm-table-wrap">
              <table class="adm-table" data-testid="admin-countries-table">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.colCode')}</th>
                    <th scope="col">{t('admin.colName')}</th>
                    <th scope="col">{t('admin.colCurrency')}</th>
                    <th scope="col">{t('admin.colBranches')}</th>
                    <th scope="col">{t('admin.colState')}</th>
                    <th scope="col">
                      <span class="sr-only">{t('admin.colActions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const branchCount = branches.filter(
                      (b) => b.country_id === c.id && !b.deleted_at,
                    ).length;
                    return (
                      <tr
                        key={c.id}
                        data-testid="admin-country-row"
                        data-iso2={c.iso2}
                        class={c.deleted_at ? 'adm-row--deleted' : undefined}
                      >
                        <td>
                          <Ltr class="mono">
                            {c.iso2}
                            {c.iso3 ? ` / ${c.iso3}` : ''}
                          </Ltr>
                        </td>
                        <td>
                          <span class="adm-names">
                            <span>{c.name_ar}</span>
                            <span class="muted">
                              {c.name_en}
                              {c.name_sw ? ` · ${c.name_sw}` : ''}
                            </span>
                          </span>
                        </td>
                        <td>
                          <Ltr class="mono">{c.default_currency ?? '—'}</Ltr>
                        </td>
                        <td>{branchCount}</td>
                        <td>
                          {c.deleted_at ? (
                            <Badge tone="danger">{t('admin.stateDeleted')}</Badge>
                          ) : c.active ? (
                            <Badge tone="success">{t('admin.stateActive')}</Badge>
                          ) : (
                            <Badge tone="inactive">{t('admin.stateInactive')}</Badge>
                          )}
                        </td>
                        <td class="adm-actions">
                          {c.deleted_at ? (
                            <Button
                              size="sm"
                              testId="admin-country-restore"
                              busy={busy === c.id}
                              onClick={() => void restore(c)}
                            >
                              {t('admin.restore')}
                            </Button>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                testId="admin-country-edit"
                                aria-label={t('admin.editNamed', { name: pickName(c) })}
                                onClick={() => setEditing(c)}
                              >
                                {t('admin.edit')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                testId="admin-country-delete"
                                busy={busy === c.id}
                                aria-label={t('admin.deleteNamed', { name: pickName(c) })}
                                onClick={() => void remove(c, branches)}
                              >
                                {t('admin.delete')}
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }}
      </ResourceState>
      {editing && data.data && (
        <CountryDialog
          country={editing === 'new' ? null : editing}
          existing={data.data.countries}
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

function toDraft(c: CountryRec | null): CountryDraft {
  return {
    iso2: c?.iso2 ?? '',
    iso3: c?.iso3 ?? '',
    name_ar: c?.name_ar ?? '',
    name_en: c?.name_en ?? '',
    name_sw: c?.name_sw ?? '',
    default_currency: c?.default_currency ?? '',
    active: c?.active ?? true,
  };
}

export function CountryDialog({
  country,
  existing,
  onClose,
  onSaved,
}: {
  country: CountryRec | null;
  existing: readonly CountryRec[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = toDraft(country);
  const [draft, setDraft] = useState<CountryDraft>(initial);
  const [errors, setErrors] = useState<Errors<CountryField>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const guard = useCloseGuard(dirty && !busy);
  const set = (patch: Partial<CountryDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const editing = country !== null;

  const save = async (): Promise<void> => {
    if (busy) return;
    const checked = validateCountry(draft, existing, country?.id ?? null);
    setErrors(checked.errors);
    setFailure(null);
    if (!checked.ok) return;
    setBusy(true);
    try {
      if (country) {
        const { iso2: _iso2, iso3: _iso3, ...patch } = checked.value;
        await updateRow('countries', country, patch);
      } else {
        await insertRow('countries', { ...checked.value });
      }
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
      title={editing ? t('admin.editCountryTitle') : t('admin.addCountryTitle')}
      onClose={onClose}
      confirmClose={guard}
      testId="admin-country-dialog"
      footer={
        <>
          <Button
            testId="admin-country-cancel"
            onClick={() => void guard().then((ok) => ok && onClose())}
          >
            {t('admin.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            testId="admin-country-save"
            onClick={() => void save()}
          >
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
        <div class="adm-grid2">
          <Field
            label={t('admin.fieldIso2')}
            htmlFor="admin-country-iso2"
            required
            error={errorText(errors.iso2)}
            hint={editing ? t('admin.codeFixedHint') : t('admin.iso2Hint')}
          >
            <input
              class="control mono"
              dir="ltr"
              data-testid="admin-country-iso2"
              value={draft.iso2}
              maxLength={2}
              disabled={editing}
              autocomplete="off"
              autocapitalize="characters"
              onInput={(e) => set({ iso2: e.currentTarget.value.toUpperCase() })}
            />
          </Field>
          <Field
            label={t('admin.fieldIso3')}
            htmlFor="admin-country-iso3"
            required
            error={errorText(errors.iso3)}
            hint={editing ? t('admin.codeFixedHint') : t('admin.iso3Hint')}
          >
            <input
              class="control mono"
              dir="ltr"
              data-testid="admin-country-iso3"
              value={draft.iso3}
              maxLength={3}
              disabled={editing}
              autocomplete="off"
              autocapitalize="characters"
              onInput={(e) => set({ iso3: e.currentTarget.value.toUpperCase() })}
            />
          </Field>
        </div>
        <Field
          label={t('admin.fieldNameAr')}
          htmlFor="admin-country-name-ar"
          required
          error={errorText(errors.name_ar)}
        >
          <input
            class="control"
            dir="rtl"
            lang="ar"
            data-testid="admin-country-name-ar"
            value={draft.name_ar}
            maxLength={120}
            onInput={(e) => set({ name_ar: e.currentTarget.value })}
          />
        </Field>
        <Field
          label={t('admin.fieldNameEn')}
          htmlFor="admin-country-name-en"
          required
          error={errorText(errors.name_en)}
        >
          <input
            class="control"
            dir="ltr"
            lang="en"
            data-testid="admin-country-name-en"
            value={draft.name_en}
            maxLength={120}
            onInput={(e) => set({ name_en: e.currentTarget.value })}
          />
        </Field>
        <Field
          label={t('admin.fieldNameSw')}
          htmlFor="admin-country-name-sw"
          error={errorText(errors.name_sw)}
          hint={t('admin.nameFallbackHint')}
        >
          <input
            class="control"
            dir="ltr"
            lang="sw"
            data-testid="admin-country-name-sw"
            value={draft.name_sw}
            maxLength={120}
            onInput={(e) => set({ name_sw: e.currentTarget.value })}
          />
        </Field>
        <Field
          label={t('admin.fieldCurrency')}
          htmlFor="admin-country-currency"
          required
          error={errorText(errors.default_currency)}
          hint={t('admin.currencyHint')}
        >
          <CurrencyInput
            testId="admin-country-currency"
            value={draft.default_currency}
            onChange={(default_currency) => set({ default_currency })}
          />
        </Field>
        <label class="adm-check">
          <input
            type="checkbox"
            data-testid="admin-country-active"
            checked={draft.active}
            onChange={(e) => set({ active: e.currentTarget.checked })}
          />
          {t('admin.fieldActive')}
        </label>
        {!draft.active && <p class="adm-note">{t('admin.inactiveCountryNote')}</p>}
        <FormError message={failure} testId="admin-country-error" />
      </form>
    </Modal>
  );
}
