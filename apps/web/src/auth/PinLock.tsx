/**
 * Lock screen. Shown at every start of the app and after the idle limit; unlocking needs no
 * network. Wrong PINs are delayed (doubling) and the stored session is destroyed after
 * `pin.maxFailures` consecutive failures — unsent work stays on the device either way.
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { AuthScreen, ErrorText, onlyDigits, useCountdown } from './AuthScreen';
import { askConfirm, pin } from './session';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from './vault';

export function PinLock() {
  const ids = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const attempts = pin.attempts.value;
  const waitSeconds = useCountdown(attempts.retryAt);
  const waiting = waitSeconds > 0;

  useEffect(() => {
    if (!waiting) inputRef.current?.focus();
  }, [waiting]);

  const errorId = `${ids}-error`;
  let message: string | null = null;
  if (waiting) message = t('auth.pin_wait', { seconds: waitSeconds });
  else if (wrong) message = t('auth.pin_wrong', { remaining: pin.maxFailures - attempts.failures });

  const submit = async (): Promise<void> => {
    if (busy || waiting || value.length < PIN_MIN_LENGTH) return;
    setBusy(true);
    try {
      const result = await pin.tryUnlock(value);
      // 'ok', 'wiped' and 'no_vault' unmount this screen through the auth state.
      setWrong(result === 'wrong' || result === 'throttled');
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  const forgot = async (): Promise<void> => {
    const confirmed = await askConfirm({
      title: t('auth.pin_forgot_title'),
      message: t('auth.pin_forgot_message'),
      confirmLabel: t('auth.pin_forgot_confirm'),
      danger: true,
    });
    if (confirmed) await pin.forget();
  };

  return (
    <AuthScreen title={t('auth.pin_lock_title')} testId="pin-lock">
      <form
        class="auth-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div class="auth-field">
          <label class="auth-field__label" for={`${ids}-pin`}>
            {t('auth.pin_lock_intro')}
          </label>
          <input
            ref={inputRef}
            id={`${ids}-pin`}
            class="auth-input auth-input--code"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]*"
            dir="ltr"
            required
            value={value}
            disabled={waiting}
            aria-invalid={wrong ? true : undefined}
            aria-describedby={errorId}
            data-testid="pin-input"
            onInput={(event) => {
              const input = event.currentTarget as HTMLInputElement;
              const digits = onlyDigits(input.value, PIN_MAX_LENGTH);
              input.value = digits;
              setValue(digits);
            }}
          />
          <ErrorText id={errorId} message={message} testId="pin-error" />
        </div>
        <button
          type="submit"
          class="auth-btn auth-btn--primary"
          disabled={busy || waiting || value.length < PIN_MIN_LENGTH}
          data-testid="pin-submit"
        >
          {busy ? t('auth.pin_unlocking') : t('auth.pin_unlock')}
        </button>
        <div class="auth-actions">
          <button
            type="button"
            class="auth-btn auth-btn--link"
            data-testid="pin-forgot"
            onClick={() => void forgot()}
          >
            {t('auth.pin_forgot')}
          </button>
        </div>
      </form>
    </AuthScreen>
  );
}
