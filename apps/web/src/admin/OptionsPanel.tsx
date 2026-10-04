/**
 * Option lists of the community profile (brief §2.5, reference-data.md §3): values with names
 * in three languages, a sort order and an active flag, per list. The code is stable and never
 * shown to users, so it cannot be changed after creation; options are deactivated or deleted
 * softly, never renamed in meaning (profiles keep referencing them). The `other` option
 * drives the free-text box and is kept.
 */
import { useState } from 'preact/hooks';
import { t } from '../i18n';
import { Badge, Button, confirm, EmptyState, Field, IconPlus, Modal, Select, toast } from '../ui';
import { insertRow, listRows, restoreRow, softDeleteRow, updateRow } from './api';
import { adminErrorKey } from './errors';
import { listLabel } from './labels';
import { errorText, FormError, Ltr, ResourceState, useCloseGuard, useResource } from './shared';
import { OPTION_LISTS, type OptionListKey, type OptionRec } from './types';
import {
  nextSortOrder,
  validateOption,
  type Errors,
  type OptionDraft,
  type OptionField,
} from './validate';

export function OptionsPanel() {
  const data = useResource(() => listRows<OptionRec>('option_values'));
  const [list, setList] = useState<OptionListKey>(OPTION_LISTS[0]);
  const [editing, setEditing] = useState<OptionRec | 'new' | null>(null);
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

  const remove = async (option: OptionRec): Promise<void> => {
    const ok = await confirm({
      title: t('admin.deleteOptionTitle'),
      message: t('admin.deleteOptionBody', { name: option.name_ar }),
      confirmLabel: t('admin.delete'),
      danger: true,
    });
    if (ok) await run(option.id, () => softDeleteRow('option_values', option), t('admin.deleted'));
  };

  return (
    <section class="adm-panel" aria-labelledby="adm-options-title" data-testid="admin-options">
      <div class="adm-panel__head">
        <h2 id="adm-options-title">{t('admin.optionsTitle')}</h2>
        <Button
          variant="gold"
          icon={<IconPlus size={18} />}
          testId="admin-option-add"
          onClick={() => setEditing('new')}
        >
          {t('admin.addOption')}
        </Button>
      </div>
      <p class="adm-note">{t('admin.optionsIntro')}</p>
      <div class="adm-toolbar">
        <Field label={t('admin.fieldList')} htmlFor="admin-options-list">
          <Select
            testId="admin-options-list"
            value={list}
            options={OPTION_LISTS.map((key) => ({ value: key, label: listLabel(key) }))}
            onChange={(value) => setList(value as OptionListKey)}
          />
        </Field>
        <label class="adm-check">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => setShowDeleted(e.currentTarget.checked)}
          />
          {t('admin.showDeleted')}
        </label>
      </div>
      <ResourceState resource={data} testId="admin-options">
        {(all) => {
          const rows = all
            .filter((o) => o.list_key === list && (showDeleted || !o.deleted_at))
            .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
          if (rows.length === 0) return <EmptyState title={t('admin.noOptions')} />;
          return (
            <div class="adm-table-wrap">
              <table class="adm-table" data-testid="admin-options-table">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.colOrder')}</th>
                    <th scope="col">{t('admin.colName')}</th>
                    <th scope="col">{t('admin.colCode')}</th>
                    <th scope="col">{t('admin.colState')}</th>
                    <th scope="col">
                      <span class="sr-only">{t('admin.colActions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr
                      key={o.id}
                      data-testid="admin-option-row"
                      data-code={o.code}
                      class={o.deleted_at ? 'adm-row--deleted' : undefined}
                    >
                      <td>{o.sort_order}</td>
                      <td>
                        <span class="adm-names">
                          <span>{o.name_ar}</span>
                          <span class="muted">
                            {o.name_en ?? <em>{t('admin.missingTranslation')}</em>}
                            {' · '}
                            {o.name_sw ?? <em>{t('admin.missingTranslation')}</em>}
                          </span>
                        </span>
                      </td>
                      <td>
                        <Ltr class="mono">{o.code}</Ltr>
                      </td>
                      <td>
                        {o.deleted_at ? (
                          <Badge tone="danger">{t('admin.stateDeleted')}</Badge>
                        ) : o.active ? (
                          <Badge tone="success">{t('admin.stateActive')}</Badge>
                        ) : (
                          <Badge tone="inactive">{t('admin.stateInactive')}</Badge>
                        )}
                      </td>
                      <td class="adm-actions">
                        {o.deleted_at ? (
                          <Button
                            size="sm"
                            testId="admin-option-restore"
                            busy={busy === o.id}
                            onClick={() =>
                              void run(
                                o.id,
                                () => restoreRow('option_values', o),
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
                              testId="admin-option-edit"
                              aria-label={t('admin.editNamed', { name: o.name_ar })}
                              onClick={() => setEditing(o)}
                            >
                              {t('admin.edit')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              testId="admin-option-delete"
                              busy={busy === o.id}
                              disabled={o.code === 'other'}
                              title={o.code === 'other' ? t('admin.otherKept') : undefined}
                              aria-label={t('admin.deleteNamed', { name: o.name_ar })}
                              onClick={() => void remove(o)}
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
          );
        }}
      </ResourceState>
      {editing && data.data && (
        <OptionDialog
          list={list}
          option={editing === 'new' ? null : editing}
          existing={data.data}
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

export function OptionDialog({
  list,
  option,
  existing,
  onClose,
  onSaved,
}: {
  list: OptionListKey;
  option: OptionRec | null;
  existing: readonly OptionRec[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const sameList = existing.filter((o) => o.list_key === list);
  const initial: OptionDraft = {
    code: option?.code ?? '',
    name_ar: option?.name_ar ?? '',
    name_en: option?.name_en ?? '',
    name_sw: option?.name_sw ?? '',
    sort_order: String(option?.sort_order ?? nextSortOrder(sameList)),
    active: option?.active ?? true,
  };
  const [draft, setDraft] = useState<OptionDraft>(initial);
  const [errors, setErrors] = useState<Errors<OptionField>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const guard = useCloseGuard(dirty && !busy);
  const set = (patch: Partial<OptionDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const isOther = option?.code === 'other';

  const save = async (): Promise<void> => {
    if (busy) return;
    const checked = validateOption(list, draft, existing, option?.id ?? null);
    setErrors(checked.errors);
    setFailure(null);
    if (!checked.ok) return;
    setBusy(true);
    try {
      if (option) {
        const { list_key: _list, code: _code, ...patch } = checked.value;
        await updateRow('option_values', option, patch);
      } else {
        await insertRow('option_values', { ...checked.value });
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
      title={
        option
          ? t('admin.editOptionTitle', { list: listLabel(list) })
          : t('admin.addOptionTitle', { list: listLabel(list) })
      }
      onClose={onClose}
      confirmClose={guard}
      testId="admin-option-dialog"
      footer={
        <>
          <Button
            testId="admin-option-cancel"
            onClick={() => void guard().then((ok) => ok && onClose())}
          >
            {t('admin.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            testId="admin-option-save"
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
        <Field
          label={t('admin.fieldNameAr')}
          htmlFor="admin-option-name-ar"
          required
          error={errorText(errors.name_ar)}
        >
          <input
            class="control"
            dir="rtl"
            lang="ar"
            data-testid="admin-option-name-ar"
            value={draft.name_ar}
            maxLength={120}
            onInput={(e) => set({ name_ar: e.currentTarget.value })}
          />
        </Field>
        <Field
          label={t('admin.fieldNameEn')}
          htmlFor="admin-option-name-en"
          error={errorText(errors.name_en)}
          hint={t('admin.nameFallbackHint')}
        >
          <input
            class="control"
            dir="ltr"
            lang="en"
            data-testid="admin-option-name-en"
            value={draft.name_en}
            maxLength={120}
            onInput={(e) => set({ name_en: e.currentTarget.value })}
          />
        </Field>
        <Field
          label={t('admin.fieldNameSw')}
          htmlFor="admin-option-name-sw"
          error={errorText(errors.name_sw)}
          hint={t('admin.nameFallbackHint')}
        >
          <input
            class="control"
            dir="ltr"
            lang="sw"
            data-testid="admin-option-name-sw"
            value={draft.name_sw}
            maxLength={120}
            onInput={(e) => set({ name_sw: e.currentTarget.value })}
          />
        </Field>
        <div class="adm-grid2">
          <Field
            label={t('admin.fieldOptionCode')}
            htmlFor="admin-option-code"
            required
            error={errorText(errors.code)}
            hint={option ? t('admin.codeFixedHint') : t('admin.optionCodeHint')}
          >
            <input
              class="control mono"
              dir="ltr"
              data-testid="admin-option-code"
              value={draft.code}
              maxLength={60}
              disabled={option !== null}
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => set({ code: e.currentTarget.value.toLowerCase() })}
            />
          </Field>
          <Field
            label={t('admin.fieldSortOrder')}
            htmlFor="admin-option-sort"
            required
            error={errorText(errors.sort_order)}
            hint={t('admin.sortOrderHint')}
          >
            <input
              class="control"
              dir="ltr"
              inputMode="numeric"
              data-testid="admin-option-sort"
              value={draft.sort_order}
              maxLength={4}
              onInput={(e) => set({ sort_order: e.currentTarget.value })}
            />
          </Field>
        </div>
        <label class="adm-check">
          <input
            type="checkbox"
            data-testid="admin-option-active"
            checked={draft.active}
            disabled={isOther}
            onChange={(e) => set({ active: e.currentTarget.checked })}
          />
          {t('admin.fieldActive')}
        </label>
        <p class="adm-note">{isOther ? t('admin.otherKept') : t('admin.inactiveOptionNote')}</p>
        <FormError message={failure} testId="admin-option-error" />
      </form>
    </Modal>
  );
}
