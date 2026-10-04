import { cloneElement, isValidElement, type ComponentChildren, type VNode } from 'preact';
import { t } from '../i18n';

export interface FieldProps {
  label: string;
  /** Id of the control. Also the base of the hint / error ids (see `fieldIds`). */
  htmlFor: string;
  required?: boolean;
  /** Validation message shown directly under the control (brief §7.6). */
  error?: string | null;
  hint?: string;
  class?: string;
  children?: ComponentChildren;
}

/** Ids a control must reference when it is not a direct child of <Field>. */
export function fieldIds(htmlFor: string): { label: string; hint: string; error: string } {
  return { label: `${htmlFor}-label`, hint: `${htmlFor}-hint`, error: `${htmlFor}-error` };
}

type ControlProps = {
  id?: string;
  required?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: 'true' | 'false' | boolean;
};

/**
 * Label + control + hint + inline error.
 * A single child control is wired automatically: it receives `id`, `required`,
 * `aria-invalid` and `aria-describedby` (hint and error). Several children (radio or chip
 * groups) are wrapped in a labelled `role="group"` instead.
 */
export function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  class: extra,
  children,
}: FieldProps) {
  const ids = fieldIds(htmlFor);
  const describedBy =
    [hint ? ids.hint : null, error ? ids.error : null].filter(Boolean).join(' ') || undefined;

  let control: ComponentChildren;
  let single = false;
  if (isValidElement(children)) {
    single = true;
    const child = children as VNode<ControlProps>;
    control = cloneElement(child, {
      id: child.props.id ?? htmlFor,
      required: child.props.required ?? (required || undefined),
      'aria-invalid': error ? 'true' : undefined,
      'aria-describedby':
        [child.props['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined,
    });
  } else {
    control = (
      <div role="group" aria-labelledby={ids.label} aria-describedby={describedBy} id={htmlFor}>
        {children}
      </div>
    );
  }

  const labelBody = (
    <>
      {label}
      {required && (
        <>
          <span class="field__required" aria-hidden="true">
            *
          </span>
          <span class="sr-only"> ({t('ui.required')})</span>
        </>
      )}
    </>
  );

  return (
    <div class={['field', error && 'field--invalid', extra].filter(Boolean).join(' ')}>
      {single ? (
        <label class="field__label" id={ids.label} for={htmlFor}>
          {labelBody}
        </label>
      ) : (
        <span class="field__label" id={ids.label}>
          {labelBody}
        </span>
      )}
      {control}
      {hint && (
        <p class="field__hint" id={ids.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p class="field__error" id={ids.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
