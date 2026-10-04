export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: readonly SelectOption[];
  /** `''`, null or undefined = nothing chosen. */
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** Text of the empty choice ("All types", "Choose…"). Omit to offer no empty choice. */
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  testId?: string;
  class?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Set by <Field> together with `id`, `required` and `aria-invalid`. */
  'aria-describedby'?: string;
  'aria-invalid'?: 'true' | 'false';
}

/** Native <select>: the platform picker is the fastest and most accessible one on low-end phones. */
export function Select({
  options,
  value,
  onChange,
  placeholder,
  testId,
  class: extra,
  ...rest
}: SelectProps) {
  return (
    <select
      {...rest}
      class={extra ? `control select ${extra}` : 'control select'}
      data-testid={testId}
      value={value ?? ''}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
