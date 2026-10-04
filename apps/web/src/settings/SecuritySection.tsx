import { useState } from 'preact/hooks';
import { lockMinutes, pin, session, signOut } from '../auth';
import { hasTranslation, t } from '../i18n';
import { syncStatus } from '../sync';
import { Button, confirm, Field, IconLock, IconSignOut, toast } from '../ui';
import { clearUserTraces } from '../ui/shell/signOutCleanup';

export const PIN_MIN = 4;
export const PIN_MAX = 8;
const PIN_PATTERN = new RegExp(`^[0-9]{${PIN_MIN},${PIN_MAX}}$`);

type PinErrors = Partial<Record<'current' | 'next' | 'repeat', string>>;

/** Pure validation of the change-PIN form: which field is wrong, and why (translation keys). */
export function validatePinChange(current: string, next: string, repeat: string): PinErrors {
  const errors: PinErrors = {};
  if (!PIN_PATTERN.test(current)) errors.current = 'settings.pinErrFormat';
  if (!PIN_PATTERN.test(next)) errors.next = 'settings.pinErrFormat';
  else if (next === current) errors.next = 'settings.pinErrSame';
  if (repeat !== next) errors.repeat = 'settings.pinErrMismatch';
  return errors;
}

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, PIN_MAX);
}

/** Message of a failure thrown by `pin.set()`: the auth module attaches a translation key. */
function failureMessage(error: unknown): string {
  const key = (error as { key?: unknown } | null)?.key;
  return typeof key === 'string' && hasTranslation(key)
    ? t(key, { min: PIN_MIN, max: PIN_MAX })
    : t('settings.pinErrSave');
}

export type PinCheck = 'ok' | 'wrong' | 'throttled' | 'wiped' | 'no_vault';

interface PinExtensions {
  /** Auth extension: tells a wrong PIN from a throttled or wiped vault. */
  tryUnlock?: (code: string) => Promise<PinCheck>;
  attempts?: { value: { failures: number } };
  maxFailures?: number;
}

/**
 * Checks the current PIN. While unlocked this only verifies it, but wrong guesses still count
 * towards the wipe limit (auth module). Uses the auth extension when present; the contract's
 * `pin.unlock()` alone only answers yes / no.
 */
async function checkCurrentPin(code: string): Promise<PinCheck> {
  const extended = pin as typeof pin & PinExtensions;
  if (typeof extended.tryUnlock === 'function') return extended.tryUnlock(code);
  return (await pin.unlock(code)) ? 'ok' : 'wrong';
}

/** Guesses left before the vault wipes itself, when the auth module tells. */
function attemptsLeft(): number | null {
  const extended = pin as typeof pin & PinExtensions;
  const failures = extended.attempts?.value.failures;
  const max = extended.maxFailures;
  return typeof failures === 'number' && typeof max === 'number'
    ? Math.max(0, max - failures)
    : null;
}

function PinForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<PinErrors>({});
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const range = { min: PIN_MIN, max: PIN_MAX };

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    const found = validatePinChange(current, next, repeat);
    setErrors(found);
    setRemaining(null);
    if (Object.keys(found).length > 0 || busy) return;
    setBusy(true);
    try {
      const check = await checkCurrentPin(current);
      if (check === 'wrong') {
        const left = attemptsLeft();
        setRemaining(left);
        setErrors({
          current: left === null ? 'settings.pinErrCurrent' : 'settings.pinErrCurrentLeft',
        });
        return;
      }
      if (check === 'throttled') {
        setErrors({ current: 'settings.pinErrThrottled' });
        return;
      }
      // 'wiped' / 'no_vault': the sign-in data is gone and the auth gate takes over the screen.
      if (check !== 'ok') return;
      await pin.set(next);
      setCurrent('');
      setNext('');
      setRepeat('');
      toast(t('settings.pinSaved'), 'success');
    } catch (error) {
      toast(failureMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const input = (
    value: string,
    set: (value: string) => void,
    testId: string,
    autocomplete: string,
  ) => (
    <input
      type="password"
      inputMode="numeric"
      autocomplete={autocomplete}
      maxLength={PIN_MAX}
      dir="ltr"
      value={value}
      data-testid={testId}
      onInput={(event) => {
        const digits = digitsOnly(event.currentTarget.value);
        event.currentTarget.value = digits;
        set(digits);
      }}
    />
  );

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <h3>{t('settings.pinChange')}</h3>
      <Field
        label={t('settings.pinCurrent')}
        htmlFor="pin-current"
        required
        error={errors.current && t(errors.current, { ...range, remaining: remaining ?? 0 })}
      >
        {input(current, setCurrent, 'pin-current', 'current-password')}
      </Field>
      <Field
        label={t('settings.pinNew')}
        htmlFor="pin-new"
        required
        hint={t('settings.pinHint', { ...range, minutes: lockMinutes.value })}
        error={errors.next && t(errors.next, range)}
      >
        {input(next, setNext, 'pin-new', 'new-password')}
      </Field>
      <Field
        label={t('settings.pinRepeat')}
        htmlFor="pin-repeat"
        required
        error={errors.repeat && t(errors.repeat, range)}
      >
        {input(repeat, setRepeat, 'pin-repeat', 'new-password')}
      </Field>
      <Button type="submit" variant="primary" busy={busy} testId="pin-save">
        {t('settings.pinSave')}
      </Button>
    </form>
  );
}

async function leave(): Promise<void> {
  const status = syncStatus.value;
  const unsent = status.pendingOps + status.failedOps + status.pendingPhotos > 0;
  // With unsent work the auth module asks its own, more specific question: do not ask twice.
  if (!unsent) {
    const confirmed = await confirm({
      title: t('settings.signOutTitle'),
      message: t('settings.signOutBody'),
      confirmLabel: t('settings.signOut'),
      danger: true,
    });
    if (!confirmed) return;
  }
  try {
    await signOut();
  } catch {
    toast(t('settings.signOutFailed'), 'error');
    return;
  }
  if (session.value) return; // the user kept the session
  // Nothing of this user may stay readable for the next person on a shared device. The app
  // root does the same for every other way a session ends; doing it here too is harmless.
  await clearUserTraces();
}

/** PIN change, "lock now" and sign-out (brief §3). */
export function SecuritySection() {
  return (
    <section class="card" aria-labelledby="settings-security">
      <h2 id="settings-security">{t('settings.securityTitle')}</h2>
      <div class="stack">
        <PinForm />
        <div class="row">
          <Button icon={<IconLock size={20} />} testId="lock-now" onClick={() => pin.lock()}>
            {t('settings.lockNow')}
          </Button>
          <Button
            variant="danger"
            icon={<IconSignOut size={20} />}
            testId="sign-out"
            onClick={() => void leave()}
          >
            {t('settings.signOut')}
          </Button>
        </div>
      </div>
    </section>
  );
}
