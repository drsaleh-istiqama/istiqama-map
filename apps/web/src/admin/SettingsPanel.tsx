/**
 * Application settings (reference-data.md §5): the public numbers every device reads after
 * sign-in — duplicate radius, GPS warning, PIN lock, photo sizes, sync batch sizes, … —
 * edited with their limits. Changes reach devices on their next settings refresh; settings
 * the server still compiles in as constants are marked. JSON settings that other screens or
 * scripts own are shown read-only.
 */
import { useState } from 'preact/hooks';
import { fmt, t } from '../i18n';
import { Badge, Button, toast } from '../ui';
import { insertRow, listRows, updateRow } from './api';
import { adminErrorKey } from './errors';
import {
  currentNumber,
  READ_ONLY_SETTINGS,
  SETTING_DEFS,
  settingLabelKey,
  validateSettingInput,
  type SettingDef,
} from './settingsSchema';
import { errorText, Ltr, ResourceState, useResource } from './shared';
import type { SettingRec } from './types';
import type { FieldError } from './validate';

export function SettingsPanel() {
  const data = useResource(() => listRows<SettingRec>('app_settings'));

  return (
    <section class="adm-panel" aria-labelledby="adm-settings-title" data-testid="admin-settings">
      <div class="adm-panel__head">
        <h2 id="adm-settings-title">{t('admin.settingsTitle')}</h2>
      </div>
      <p class="adm-note">{t('admin.settingsIntro')}</p>
      <ResourceState resource={data} testId="admin-settings">
        {(rows) => {
          const live = rows.filter((r) => !r.deleted_at);
          const byKey = new Map(live.map((r) => [r.key, r]));
          const others = live.filter(
            (r) => r.is_public && !SETTING_DEFS.some((d) => d.key === r.key),
          );
          return (
            <>
              <ul class="adm-settings" data-testid="admin-settings-list">
                {SETTING_DEFS.map((def) => (
                  <SettingRow
                    key={def.key}
                    def={def}
                    row={byKey.get(def.key) ?? null}
                    onSaved={() => void data.reload()}
                  />
                ))}
              </ul>
              {others.length > 0 && (
                <>
                  <h3 class="adm-subtitle">{t('admin.otherSettings')}</h3>
                  <dl class="kv adm-kv" data-testid="admin-settings-readonly">
                    {others.map((r) => (
                      <div key={r.key} class="adm-kv__pair">
                        <dt>
                          <Ltr class="mono">{r.key}</Ltr>
                          {READ_ONLY_SETTINGS.includes(
                            r.key as (typeof READ_ONLY_SETTINGS)[number],
                          ) && (
                            <span class="muted adm-small">
                              {' '}
                              — {t(`admin.readonly_${r.key.replace(/[^a-z0-9]+/g, '_')}`)}
                            </span>
                          )}
                        </dt>
                        <dd>
                          <code class="adm-json" dir="ltr">
                            {JSON.stringify(r.value).slice(0, 300)}
                          </code>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </>
          );
        }}
      </ResourceState>
    </section>
  );
}

function SettingRow({
  def,
  row,
  onSaved,
}: {
  def: SettingDef;
  row: SettingRec | null;
  onSaved: () => void;
}) {
  const stored = currentNumber(def, row?.value);
  const [input, setInput] = useState(String(stored));
  const [error, setError] = useState<FieldError | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `admin-setting-${def.key.replace(/[^a-z0-9]+/g, '-')}`;
  const changed = input.trim() !== String(stored);

  const save = async (): Promise<void> => {
    if (busy) return;
    const checked = validateSettingInput(def, input);
    if (checked.error) {
      setError(checked.error);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (row) await updateRow('app_settings', row, { value: checked.value });
      else await insertRow('app_settings', { key: def.key, value: checked.value, is_public: true });
      toast(t('admin.settingSaved'), 'success');
      onSaved();
    } catch (e) {
      setError({ key: adminErrorKey(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li class="adm-setting" data-testid="admin-setting-row" data-key={def.key}>
      <form
        class={error ? 'field field--invalid adm-setting__form' : 'field adm-setting__form'}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label class="field__label" for={id}>
          {t(settingLabelKey(def.key))}
        </label>
        <div class="adm-setting__line">
          <input
            id={id}
            class="control adm-setting__input"
            dir="ltr"
            inputMode={def.integer ? 'numeric' : 'decimal'}
            data-testid={id}
            value={input}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
            onInput={(e) => setInput(e.currentTarget.value)}
          />
          <span class="muted">{t(`admin.unit_${def.unit}`)}</span>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!changed}
            busy={busy}
            testId={`${id}-save`}
          >
            {t('admin.save')}
          </Button>
        </div>
        <p class="field__hint" id={`${id}-hint`}>
          {t('admin.settingRange', {
            min: fmt.number(def.min),
            max: fmt.number(def.max),
            fallback: fmt.number(def.fallback),
          })}
          {def.serverConstant && (
            <>
              {' '}
              <Badge tone="warning">{t('admin.serverConstant')}</Badge>
            </>
          )}
          {!row && (
            <>
              {' '}
              <Badge tone="neutral">{t('admin.settingDefault')}</Badge>
            </>
          )}
        </p>
        {error && (
          <p class="field__error" id={`${id}-error`} role="alert" data-testid={`${id}-error`}>
            {errorText(error)}
          </p>
        )}
      </form>
    </li>
  );
}
