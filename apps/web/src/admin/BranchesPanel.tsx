/**
 * Branches (brief §2.2, §15): code, names in three languages, country and the geographic
 * scope (`admin_area_ids`) chosen in a searchable tree of the synced administrative areas.
 * A branch's country is fixed once created (role grants and projects are scoped by it).
 */
import { useState } from 'preact/hooks';
import { pickName, t } from '../i18n';
import { Badge, Button, confirm, EmptyState, Field, IconPlus, Modal, Select, toast } from '../ui';
import { AreaTreePicker } from './AreaTreePicker';
import { insertRow, listRows, restoreRow, softDeleteRow, updateRow } from './api';
import { adminErrorKey } from './errors';
import { countryName } from './labels';
import { errorText, FormError, Ltr, ResourceState, useCloseGuard, useResource } from './shared';
import type { BranchRec, CountryRec } from './types';
import { validateBranch, type BranchDraft, type BranchField, type Errors } from './validate';

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

export function BranchesPanel() {
  const data = useResource(load);
  const [editing, setEditing] = useState<BranchRec | 'new' | null>(null);
  const [countryFilter, setCountryFilter] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (id: string, work: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(id);
    try {
      await work();
      toast(done, 'success');
    } catch (e) {
      toast(t(adminErrorKey(e)), 'error');
    } finally {
      setBusy(null);
      await data.reload();
    }
  };

  const remove = async (branch: BranchRec): Promise<void> => {
    const ok = await confirm({
      title: t('admin.deleteBranchTitle'),
      message: t('admin.deleteBranchBody', { name: pickName(branch) }),
      confirmLabel: t('admin.delete'),
      danger: true,
    });
    if (ok) await run(branch.id, () => softDeleteRow('branches', branch), t('admin.deleted'));
  };

  return (
    <section class="adm-panel" aria-labelledby="adm-branches-title" data-testid="admin-branches">
      <div class="adm-panel__head">
        <h2 id="adm-branches-title">{t('admin.branchesTitle')}</h2>
        <Button
          variant="gold"
          icon={<IconPlus size={18} />}
          testId="admin-branch-add"
          onClick={() => setEditing('new')}
        >
          {t('admin.addBranch')}
        </Button>
      </div>
      <ResourceState resource={data} testId="admin-branches">
        {({ countries, branches }) => {
          const byId = new Map(countries.map((c) => [c.id, c]));
          const rows = branches.filter(
            (b) =>
              (showDeleted || !b.deleted_at) && (!countryFilter || b.country_id === countryFilter),
          );
          return (
            <>
              <div class="adm-toolbar">
                <Select
                  testId="admin-branches-country"
                  aria-label={t('admin.filterCountry')}
                  value={countryFilter}
                  placeholder={t('admin.allCountries')}
                  options={countries
                    .filter((c) => !c.deleted_at)
                    .map((c) => ({ value: c.id, label: countryName(c) }))
                    .sort((a, b) => a.label.localeCompare(b.label))}
                  onChange={setCountryFilter}
                />
                <label class="adm-check">
                  <input
                    type="checkbox"
                    checked={showDeleted}
                    onChange={(e) => setShowDeleted(e.currentTarget.checked)}
                  />
                  {t('admin.showDeleted')}
                </label>
              </div>
              {rows.length === 0 ? (
                <EmptyState title={t('admin.noBranches')} testId="admin-branches-empty" />
              ) : (
                <div class="adm-table-wrap">
                  <table class="adm-table" data-testid="admin-branches-table">
                    <thead>
                      <tr>
                        <th scope="col">{t('admin.colCode')}</th>
                        <th scope="col">{t('admin.colName')}</th>
                        <th scope="col">{t('admin.colCountry')}</th>
                        <th scope="col">{t('admin.colAreas')}</th>
                        <th scope="col">{t('admin.colState')}</th>
                        <th scope="col">
                          <span class="sr-only">{t('admin.colActions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((b) => (
                        <tr
                          key={b.id}
                          data-testid="admin-branch-row"
                          data-code={b.code}
                          class={b.deleted_at ? 'adm-row--deleted' : undefined}
                        >
                          <td>
                            <Ltr class="mono">{b.code}</Ltr>
                          </td>
                          <td>
                            <span class="adm-names">
                              <span>{b.name_ar}</span>
                              {(b.name_en || b.name_sw) && (
                                <span class="muted">
                                  {[b.name_en, b.name_sw].filter(Boolean).join(' · ')}
                                </span>
                              )}
                            </span>
                          </td>
                          <td>{countryName(byId.get(b.country_id))}</td>
                          <td>{b.admin_area_ids.length}</td>
                          <td>
                            {b.deleted_at ? (
                              <Badge tone="danger">{t('admin.stateDeleted')}</Badge>
                            ) : b.active ? (
                              <Badge tone="success">{t('admin.stateActive')}</Badge>
                            ) : (
                              <Badge tone="inactive">{t('admin.stateInactive')}</Badge>
                            )}
                          </td>
                          <td class="adm-actions">
                            {b.deleted_at ? (
                              <Button
                                size="sm"
                                testId="admin-branch-restore"
                                busy={busy === b.id}
                                onClick={() =>
                                  void run(
                                    b.id,
                                    () => restoreRow('branches', b),
                                    t('admin.restored'),
                                  )
                                }
                              >
                                {t('admin.restore')}
                              </Button>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  testId="admin-branch-edit"
                                  aria-label={t('admin.editNamed', { name: pickName(b) })}
                                  onClick={() => setEditing(b)}
                                >
                                  {t('admin.edit')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  testId="admin-branch-delete"
                                  busy={busy === b.id}
                                  aria-label={t('admin.deleteNamed', { name: pickName(b) })}
                                  onClick={() => void remove(b)}
                                >
                                  {t('admin.delete')}
                                </Button>
                              </>
                            )}
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
        <BranchDialog
          branch={editing === 'new' ? null : editing}
          countries={data.data.countries}
          existing={data.data.branches}
          defaultCountry={countryFilter}
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

export function BranchDialog({
  branch,
  countries,
  existing,
  defaultCountry,
  onClose,
  onSaved,
}: {
  branch: BranchRec | null;
  countries: readonly CountryRec[];
  existing: readonly BranchRec[];
  defaultCountry: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial: BranchDraft = {
    country_id: branch?.country_id ?? defaultCountry,
    code: branch?.code ?? '',
    name_ar: branch?.name_ar ?? '',
    name_en: branch?.name_en ?? '',
    name_sw: branch?.name_sw ?? '',
    admin_area_ids: branch?.admin_area_ids ?? [],
    active: branch?.active ?? true,
  };
  const [draft, setDraft] = useState<BranchDraft>(initial);
  const [errors, setErrors] = useState<Errors<BranchField>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const guard = useCloseGuard(dirty && !busy);
  const set = (patch: Partial<BranchDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  const save = async (): Promise<void> => {
    if (busy) return;
    const checked = validateBranch(draft, existing, branch?.id ?? null);
    setErrors(checked.errors);
    setFailure(null);
    if (!checked.ok) return;
    setBusy(true);
    try {
      if (branch) {
        const { country_id: _country, ...patch } = checked.value;
        await updateRow('branches', branch, patch);
      } else {
        await insertRow('branches', { ...checked.value });
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
      size="lg"
      title={branch ? t('admin.editBranchTitle') : t('admin.addBranchTitle')}
      onClose={onClose}
      confirmClose={guard}
      testId="admin-branch-dialog"
      footer={
        <>
          <Button
            testId="admin-branch-cancel"
            onClick={() => void guard().then((ok) => ok && onClose())}
          >
            {t('admin.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            testId="admin-branch-save"
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
            label={t('admin.fieldCountry')}
            htmlFor="admin-branch-country"
            required
            error={errorText(errors.country_id)}
            hint={branch ? t('admin.countryFixedHint') : undefined}
          >
            <Select
              testId="admin-branch-country"
              value={draft.country_id}
              disabled={branch !== null}
              placeholder={t('admin.choose')}
              options={countries
                .filter((c) => !c.deleted_at || c.id === draft.country_id)
                .map((c) => ({ value: c.id, label: countryName(c) }))
                .sort((a, b) => a.label.localeCompare(b.label))}
              onChange={(country_id) => set({ country_id, admin_area_ids: [] })}
            />
          </Field>
          <Field
            label={t('admin.fieldBranchCode')}
            htmlFor="admin-branch-code"
            required
            error={errorText(errors.code)}
            hint={t('admin.branchCodeHint')}
          >
            <input
              class="control mono"
              dir="ltr"
              data-testid="admin-branch-code"
              value={draft.code}
              maxLength={20}
              autocomplete="off"
              autocapitalize="characters"
              onInput={(e) => set({ code: e.currentTarget.value.toUpperCase() })}
            />
          </Field>
        </div>
        <Field
          label={t('admin.fieldNameAr')}
          htmlFor="admin-branch-name-ar"
          required
          error={errorText(errors.name_ar)}
        >
          <input
            class="control"
            dir="rtl"
            lang="ar"
            data-testid="admin-branch-name-ar"
            value={draft.name_ar}
            maxLength={120}
            onInput={(e) => set({ name_ar: e.currentTarget.value })}
          />
        </Field>
        <div class="adm-grid2">
          <Field
            label={t('admin.fieldNameEn')}
            htmlFor="admin-branch-name-en"
            error={errorText(errors.name_en)}
          >
            <input
              class="control"
              dir="ltr"
              lang="en"
              data-testid="admin-branch-name-en"
              value={draft.name_en}
              maxLength={120}
              onInput={(e) => set({ name_en: e.currentTarget.value })}
            />
          </Field>
          <Field
            label={t('admin.fieldNameSw')}
            htmlFor="admin-branch-name-sw"
            error={errorText(errors.name_sw)}
          >
            <input
              class="control"
              dir="ltr"
              lang="sw"
              data-testid="admin-branch-name-sw"
              value={draft.name_sw}
              maxLength={120}
              onInput={(e) => set({ name_sw: e.currentTarget.value })}
            />
          </Field>
        </div>
        <div class="field">
          <span class="field__label" id="admin-branch-areas-label">
            {t('admin.fieldAreas')}
          </span>
          <p class="field__hint">{t('admin.areasHint')}</p>
          <AreaTreePicker
            countryId={draft.country_id}
            value={draft.admin_area_ids}
            onChange={(admin_area_ids) => set({ admin_area_ids })}
            idBase="admin-branch-areas"
            labelledBy="admin-branch-areas-label"
          />
        </div>
        <label class="adm-check">
          <input
            type="checkbox"
            data-testid="admin-branch-active"
            checked={draft.active}
            onChange={(e) => set({ active: e.currentTarget.checked })}
          />
          {t('admin.fieldActive')}
        </label>
        <FormError message={failure} testId="admin-branch-error" />
      </form>
    </Modal>
  );
}
