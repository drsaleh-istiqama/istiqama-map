/**
 * First sign-in on a device: the user must choose a PIN (4–8 digits). Until then the session
 * exists in memory only; saving the PIN encrypts it into the vault.
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { AuthScreen, ErrorText, onlyDigits } from './AuthScreen';
import { AuthFlowError, toFlowError } from './errors';
import { lockMinutes, pin, signOut } from './session';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, isValidPin } from './vault';

export function PinSetup() {
  const ids = useId();
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const errorId = `${ids}-error`;
  const hintId = `${ids}-hint`;
  const error = errorKey ? t(errorKey, { min: PIN_MIN_LENGTH, max: PIN_MAX_LENGTH }) : null;

  const save = async (): Promise<void> => {
    if (busy) return;
    setErrorKey(null);
    setBusy(true);
    try {
      if (!isValidPin(first)) throw new AuthFlowError('pin_invalid');
      if (first !== second) throw new AuthFlowError('pin_mismatch');
      await pin.set(first);
    } catch (thrown) {
      setErrorKey(toFlowError(thrown).key);
      firstRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const digitsInput = (setter: (value: string) => void) => (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const digits = onlyDigits(input.value, PIN_MAX_LENGTH);
    input.value = digits;
    setter(digits);
  };

  return (
    <AuthScreen title={t('auth.pin_setup_title')} testId="pin-setup">
      <form
        class="auth-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p class="auth-card__intro">{t('auth.pin_setup_intro', { minutes: lockMinutes.value })}</p>
        <div class="auth-field">
          <label class="auth-field__label" for={`${ids}-pin`}>
            {t('auth.pin_label', { min: PIN_MIN_LENGTH, max: PIN_MAX_LENGTH })}
          </label>
          <input
            ref={firstRef}
            id={`${ids}-pin`}
            class="auth-input auth-input--code"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]*"
            dir="ltr"
            required
            value={first}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${hintId} ${errorId}`}
            data-testid="pin-input"
            onInput={digitsInput(setFirst)}
          />
        </div>
        <div class="auth-field">
          <label class="auth-field__label" for={`${ids}-confirm`}>
            {t('auth.pin_confirm_label')}
          </label>
          <input
            id={`${ids}-confirm`}
            class="auth-input auth-input--code"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]*"
            dir="ltr"
            required
            value={second}
            aria-invalid={error ? true : undefined}
            aria-describedby={errorId}
            data-testid="pin-confirm"
            onInput={digitsInput(setSecond)}
          />
          <p id={hintId} class="auth-field__hint">
            {t('auth.pin_setup_note')}
          </p>
          <ErrorText id={errorId} message={error} testId="pin-error" />
        </div>
        <button
          type="submit"
          class="auth-btn auth-btn--primary"
          disabled={busy || first.length < PIN_MIN_LENGTH || second.length < PIN_MIN_LENGTH}
          data-testid="pin-submit"
        >
          {busy ? t('auth.pin_saving') : t('auth.pin_save')}
        </button>
        <div class="auth-actions">
          <button
            type="button"
            class="auth-btn auth-btn--link"
            data-testid="pin-signout"
            onClick={() => void signOut()}
          >
            {t('auth.sign_out')}
          </button>
        </div>
      </form>
    </AuthScreen>
  );
}
