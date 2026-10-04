/**
 * Choose an existing person by name or phone (merge tool). A combobox over the device's
 * people index (`listPersons`, prefix match on every word) — no "new person" here.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { db, listPersons, normalizePhone, type Row } from '../db';
import { t } from '../i18n';
import { Button, useDebounced } from '../ui';
import { me } from '../auth';
import { NameBlock, PhoneText } from './display';
import { cleanPhoneInput, toPersonE164 } from './phone';
import { defaultDial } from './queries';
import { useCombobox } from './useCombobox';

type Person = Row<'persons'>;

export interface PersonSearchProps {
  label: string;
  value: Person | null;
  onChange: (person: Person | null) => void;
  testId: string;
  excludeId?: string | null;
  disabled?: boolean;
}

let instance = 0;

/** Calling code of the user's country, read once from the device (null until known). */
export function useDefaultDial(): string | null {
  const [dial, setDial] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void defaultDial(me.peek()).then((d) => alive && setDial(d));
    return () => {
      alive = false;
    };
  }, []);
  return dial;
}

/**
 * Persons matching a typed name (every word starts a word of the name) or a phone number
 * (national form with the calling code of the user's country, or international form).
 */
export async function searchPersons(
  q: string,
  limit = 8,
  dial: string | null = null,
): Promise<Person[]> {
  const text = q.trim();
  if (text.length < 2) return [];
  if (looksLikePhone(text)) {
    const phone = toPersonE164(text, dial) ?? normalizePhone(text);
    if (!phone) return [];
    const rows = await db.persons.where('phone_e164').equals(phone).limit(limit).toArray();
    return rows.filter((p) => !p.deleted_at && !p.merged_into_id);
  }
  const { rows } = await listPersons(text, null, limit);
  return rows.filter((p) => !p.deleted_at && !p.merged_into_id);
}

/** Digits and phone separators only, at least six digits. */
export function looksLikePhone(text: string): boolean {
  const digits = cleanPhoneInput(text).replace('+', '');
  return (
    digits.length >= 6 &&
    [...text].every((ch) => ' +-().'.includes(ch) || cleanPhoneInput(ch) !== '')
  );
}

export function PersonSearch({
  label,
  value,
  onChange,
  testId,
  excludeId,
  disabled,
}: PersonSearchProps) {
  const ids = useMemo(() => `ps${++instance}`, []);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Person[]>([]);
  const debounced = useDebounced(query, 250);
  const inputRef = useRef<HTMLInputElement>(null);
  const token = useRef(0);
  const dial = useDefaultDial();

  useEffect(() => {
    const mine = ++token.current;
    void searchPersons(debounced, 8, dial).then((rows) => {
      if (mine === token.current) setOptions(rows.filter((p) => p.id !== excludeId));
    });
  }, [debounced, excludeId, dial]);

  const choose = (person: Person): void => {
    onChange(person);
    cb.setOpen(false);
    setQuery('');
  };
  const cb = useCombobox({
    baseId: ids,
    count: options.length,
    onChoose: (i) => {
      const p = options[i];
      if (p) choose(p);
    },
  });

  if (value) {
    return (
      <div class="ps" data-testid={testId}>
        <span class="field__label">{label}</span>
        <div class="pp-selected" data-testid={`${testId}-selected`} data-person-id={value.id}>
          <div class="pp-selected__body">
            <NameBlock person={value} />
            <PhoneText phone={value.phone_e164} />
          </div>
          {!disabled && (
            <Button
              size="sm"
              testId={`${testId}-change`}
              onClick={() => {
                onChange(null);
                queueMicrotask(() => inputRef.current?.focus());
              }}
            >
              {t('people.change')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const expanded = cb.open && options.length > 0;
  return (
    <div class="ps" data-testid={testId}>
      <label class="field__label" for={`${ids}-input`}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={`${ids}-input`}
        class="control"
        type="text"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded ? 'true' : 'false'}
        aria-controls={`${ids}-list`}
        aria-activedescendant={expanded ? cb.activeId : undefined}
        data-testid={`${testId}-input`}
        placeholder={t('people.searchPlaceholder')}
        disabled={disabled}
        value={query}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          cb.setOpen(true);
        }}
        onFocus={() => cb.setOpen(true)}
        onKeyDown={cb.onKeyDown}
      />
      <ul id={`${ids}-list`} class="ps__list" role="listbox" aria-label={label} hidden={!expanded}>
        {options.map((p, i) => (
          <li
            key={p.id}
            id={cb.optionId(i)}
            role="option"
            aria-selected={cb.active === i ? 'true' : 'false'}
            class={cb.active === i ? 'ps__opt ps__opt--active' : 'ps__opt'}
            data-testid={`${testId}-option`}
            data-person-id={p.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(p)}
          >
            <NameBlock person={p} />
            <PhoneText phone={p.phone_e164} />
          </li>
        ))}
      </ul>
    </div>
  );
}
