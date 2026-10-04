/**
 * Mandatory second factor for country managers and HQ administrators (brief §3).
 * First time: enrol an authenticator app (QR code + manual key), then confirm with a code.
 * Later sign-ins: enter the current code. The app stays closed until the session is aal2.
 * The secret is held in component state only and disappears with this screen.
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { AuthScreen, ErrorText, Notice, onlyDigits } from './AuthScreen';
import { toFlowError } from './errors';
import { getMfaStatus, startTotpEnrolment, verifyTotp, type TotpEnrolment } from './mfa';
import { signOut } from './session';

type Phase =
  | { kind: 'loading' }
  | { kind: 'failed'; errorKey: string }
  | { kind: 'enrol'; enrolment: TotpEnrolment }
  | { kind: 'challenge'; factorId: string };

/** Groups the Base32 key in fours for reading aloud / typing. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

export function MfaView() {
  const ids = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  const load = async (): Promise<void> => {
    setPhase({ kind: 'loading' });
    setErrorKey(null);
    try {
      const status = await getMfaStatus();
      const next: Phase = status.verifiedFactorId
        ? { kind: 'challenge', factorId: status.verifiedFactorId }
        : { kind: 'enrol', enrolment: await startTotpEnrolment() };
      if (alive.current) setPhase(next);
    } catch (thrown) {
      if (alive.current) setPhase({ kind: 'failed', errorKey: toFlowError(thrown).key });
    }
  };

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (phase.kind === 'enrol' || phase.kind === 'challenge') codeRef.current?.focus();
  }, [phase.kind]);

  const factorId =
    phase.kind === 'enrol'
      ? phase.enrolment.factorId
      : phase.kind === 'challenge'
        ? phase.factorId
        : null;

  const verify = async (): Promise<void> => {
    if (busy || !factorId) return;
    setErrorKey(null);
    setBusy(true);
    try {
      await verifyTotp(factorId, code);
      // The new aal2 session reaches the AuthGate through the session signal.
    } catch (thrown) {
      if (!alive.current) return;
      setErrorKey(toFlowError(thrown).key);
      setCode('');
      codeRef.current?.focus();
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const errorId = `${ids}-error`;
  const hintId = `${ids}-hint`;
  const error = errorKey ? t(errorKey) : null;

  return (
    <AuthScreen title={t('auth.mfa_title')} testId="mfa-view">
      {phase.kind === 'loading' && <Notice testId="mfa-loading">{t('auth.loading')}</Notice>}

      {phase.kind === 'failed' && (
        <div class="auth-form">
          <Notice kind="warning" testId="mfa-failed">
            {t('auth.mfa_load_failed')} {t(phase.errorKey)}
          </Notice>
          <button
            type="button"
            class="auth-btn auth-btn--primary"
            data-testid="mfa-retry"
            onClick={() => void load()}
          >
            {t('auth.retry')}
          </button>
        </div>
      )}

      {(phase.kind === 'enrol' || phase.kind === 'challenge') && (
        <form
          class="auth-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          {phase.kind === 'enrol' ? (
            <>
              <p class="auth-card__intro">{t('auth.mfa_enrol_intro')}</p>
              <img
                class="auth-qr"
                src={phase.enrolment.qrDataUrl}
                alt={t('auth.mfa_qr_alt')}
                width={200}
                height={200}
                data-testid="mfa-qr"
              />
              <p class="auth-field__label">{t('auth.mfa_secret_label')}</p>
              <p class="auth-secret" dir="ltr" data-testid="mfa-secret">
                {groupSecret(phase.enrolment.secret)}
              </p>
              <p class="auth-field__hint">{t('auth.mfa_secret_warning')}</p>
            </>
          ) : (
            <p class="auth-card__intro">{t('auth.mfa_challenge_intro')}</p>
          )}

          <div class="auth-field">
            <label class="auth-field__label" for={`${ids}-code`}>
              {t('auth.mfa_code_label')}
            </label>
            <input
              ref={codeRef}
              id={`${ids}-code`}
              class="auth-input auth-input--code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              dir="ltr"
              required
              value={code}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${hintId} ${errorId}`}
              data-testid="mfa-code"
              onInput={(event) => {
                const input = event.currentTarget as HTMLInputElement;
                const digits = onlyDigits(input.value, 6);
                input.value = digits;
                setCode(digits);
              }}
            />
            <ErrorText id={errorId} message={error} testId="mfa-error" />
          </div>
          <button
            type="submit"
            class="auth-btn auth-btn--primary"
            disabled={busy || code.length !== 6}
            data-testid="mfa-verify"
          >
            {busy ? t('auth.verifying') : t('auth.mfa_verify')}
          </button>
          <p id={hintId} class="auth-field__hint">
            {t('auth.mfa_lost')}
          </p>
        </form>
      )}

      <div class="auth-actions">
        <button
          type="button"
          class="auth-btn auth-btn--link"
          data-testid="mfa-signout"
          onClick={() => void signOut()}
        >
          {t('auth.sign_out')}
        </button>
      </div>
    </AuthScreen>
  );
}
