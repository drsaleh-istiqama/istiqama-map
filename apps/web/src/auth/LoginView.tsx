/**
 * Sign-in screen (route /login, also shown by the AuthGate while signed out).
 * Field users sign in without a password: a code by e-mail (the same message carries a magic
 * link) or by SMS. Accounts are created by administrators only (`shouldCreateUser: false`).
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { getPref, setPref } from '../lib/prefs';
import { navigate } from '../routes';
import { AuthScreen, ErrorText, Notice, onlyDigits, useCountdown, useOnline } from './AuthScreen';
import { AuthFlowError, toFlowError } from './errors';
import {
  DIAL_COUNTRIES,
  exampleNational,
  guessDialCountry,
  toE164,
  type DialCountry,
} from './phone';
import {
  authNotice,
  authState,
  signInWithEmailOtp,
  signInWithPhoneOtp,
  verifyOtp,
} from './session';
import { MAX_PIN_FAILURES } from './vault';

type Tab = 'email' | 'phone';
type Step = 'identifier' | 'code';

const RESEND_SECONDS = 60;
const TAB_PREF = 'auth.login_tab';
const COUNTRY_PREF = 'auth.phone_country';

function initialCountry(): DialCountry {
  const saved = getPref<string>(COUNTRY_PREF, '');
  return DIAL_COUNTRIES.find((c) => c.iso2 === saved) ?? guessDialCountry();
}

export default function LoginView() {
  const ids = useId();
  const online = useOnline();
  const [tab, setTab] = useState<Tab>(() =>
    getPref<string>(TAB_PREF, 'email') === 'phone' ? 'phone' : 'email',
  );
  const [step, setStep] = useState<Step>('identifier');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState<DialCountry>(initialCountry);
  const [national, setNational] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [sentKind, setSentKind] = useState<'email' | 'sms'>('email');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const resendIn = useCountdown(resendAt);
  const identifierRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const state = authState.value;
  const notice = authNotice.value;
  const signedIn = state !== 'signed_out' && state !== 'loading' && state !== 'locked';

  useEffect(() => {
    // Opened /login while already signed in (or just finished signing in on that route).
    if (signedIn) navigate('/', { replace: true });
  }, [signedIn]);

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  const errorId = `${ids}-error`;
  const hintId = `${ids}-hint`;
  const error = errorKey ? t(errorKey) : null;

  const fail = (thrown: unknown): void => setErrorKey(toFlowError(thrown).key);

  const selectTab = (next: Tab): void => {
    setTab(next);
    setPref(TAB_PREF, next);
    setErrorKey(null);
  };

  const send = async (): Promise<void> => {
    if (busy) return;
    setErrorKey(null);
    setBusy(true);
    try {
      if (tab === 'email') {
        const address = email.trim().toLowerCase();
        await signInWithEmailOtp(address);
        setSentTo(address);
        setSentKind('email');
      } else {
        const phone = toE164(national, country.dial);
        if (!phone) throw new AuthFlowError('invalid_phone');
        await signInWithPhoneOtp(phone);
        setPref(COUNTRY_PREF, country.iso2);
        setSentTo(phone);
        setSentKind('sms');
      }
      setCode('');
      setStep('code');
      setResendAt(Date.now() + RESEND_SECONDS * 1000);
    } catch (thrown) {
      fail(thrown);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (): Promise<void> => {
    if (busy) return;
    setErrorKey(null);
    setBusy(true);
    try {
      await verifyOtp(sentTo, code, sentKind);
      // The AuthGate takes over as soon as the session signal changes.
    } catch (thrown) {
      fail(thrown);
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const back = (): void => {
    setStep('identifier');
    setCode('');
    setErrorKey(null);
    queueMicrotask(() => identifierRef.current?.focus());
  };

  if (signedIn) {
    return (
      <AuthScreen title={t('auth.login_title')} testId="login-view">
        <Notice testId="login-signed-in">{t('auth.already_signed_in')}</Notice>
        <a
          class="auth-btn auth-btn--primary"
          href={import.meta.env.BASE_URL ?? '/'}
          data-testid="login-continue"
        >
          {t('auth.continue')}
        </a>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen title={t('auth.login_title')} testId="login-view">
      {notice && (
        <Notice kind="warning" testId="login-notice">
          {t(`auth.notice_${notice}`, { max: MAX_PIN_FAILURES })}
        </Notice>
      )}
      {!online && (
        <Notice kind="warning" testId="login-offline">
          {t('auth.offline_banner')}
        </Notice>
      )}

      {step === 'identifier' ? (
        <form
          class="auth-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <p class="auth-card__intro">{t('auth.login_intro')}</p>
          <div class="auth-tabs" role="tablist" aria-label={t('auth.login_method')}>
            <button
              type="button"
              role="tab"
              id={`${ids}-tab-email`}
              class="auth-tabs__tab"
              aria-selected={tab === 'email'}
              aria-controls={`${ids}-panel`}
              data-testid="login-tab-email"
              onClick={() => selectTab('email')}
            >
              {t('auth.tab_email')}
            </button>
            <button
              type="button"
              role="tab"
              id={`${ids}-tab-phone`}
              class="auth-tabs__tab"
              aria-selected={tab === 'phone'}
              aria-controls={`${ids}-panel`}
              data-testid="login-tab-phone"
              onClick={() => selectTab('phone')}
            >
              {t('auth.tab_phone')}
            </button>
          </div>

          <div
            id={`${ids}-panel`}
            role="tabpanel"
            aria-labelledby={`${ids}-tab-${tab}`}
            class="auth-form__panel"
          >
            {tab === 'email' ? (
              <div class="auth-field">
                <label class="auth-field__label" for={`${ids}-email`}>
                  {t('auth.email_label')}
                </label>
                <input
                  ref={identifierRef}
                  id={`${ids}-email`}
                  class="auth-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellcheck={false}
                  dir="ltr"
                  required
                  placeholder={t('auth.email_placeholder')}
                  value={email}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={errorId}
                  data-testid="login-email"
                  onInput={(event) => setEmail((event.currentTarget as HTMLInputElement).value)}
                />
              </div>
            ) : (
              <div class="auth-field">
                <label class="auth-field__label" for={`${ids}-phone`}>
                  {t('auth.phone_label')}
                </label>
                <div class="auth-phone" dir="ltr">
                  <select
                    class="auth-input auth-phone__country"
                    aria-label={t('auth.phone_country_label')}
                    value={country.iso2}
                    data-testid="login-country"
                    onChange={(event) => {
                      const iso2 = (event.currentTarget as HTMLSelectElement).value;
                      setCountry(DIAL_COUNTRIES.find((c) => c.iso2 === iso2) ?? country);
                    }}
                  >
                    {DIAL_COUNTRIES.map((c) => (
                      <option key={c.iso2} value={c.iso2}>
                        {`+${c.dial} ${t(`auth.country_${c.iso2.toLowerCase()}`)}`}
                      </option>
                    ))}
                  </select>
                  <input
                    ref={identifierRef}
                    id={`${ids}-phone`}
                    class="auth-input auth-phone__number"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    required
                    placeholder={exampleNational(country)}
                    value={national}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={`${hintId} ${errorId}`}
                    data-testid="login-phone"
                    onInput={(event) =>
                      setNational((event.currentTarget as HTMLInputElement).value)
                    }
                  />
                </div>
                <p id={hintId} class="auth-field__hint">
                  {t('auth.phone_hint')}
                </p>
              </div>
            )}
            <ErrorText id={errorId} message={error} testId="login-error" />
          </div>

          <button
            type="submit"
            class="auth-btn auth-btn--primary"
            disabled={busy}
            data-testid="login-submit"
          >
            {busy ? t('auth.sending') : t('auth.send_code')}
          </button>
        </form>
      ) : (
        <form
          class="auth-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <p class="auth-card__intro">
            {sentKind === 'email' ? t('auth.code_sent_email') : t('auth.code_sent_phone')}
          </p>
          <p class="auth-sent" data-testid="login-sent">
            <bdi dir="ltr">{sentTo}</bdi>
          </p>
          <div class="auth-field">
            <label class="auth-field__label" for={`${ids}-code`}>
              {t('auth.code_label')}
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
              data-testid="login-code"
              onInput={(event) => {
                const input = event.currentTarget as HTMLInputElement;
                const digits = onlyDigits(input.value, 10);
                input.value = digits;
                setCode(digits);
              }}
            />
            <p id={hintId} class="auth-field__hint">
              {t('auth.code_hint')}
            </p>
            <ErrorText id={errorId} message={error} testId="login-error" />
          </div>
          <button
            type="submit"
            class="auth-btn auth-btn--primary"
            disabled={busy || code.length < 4}
            data-testid="login-verify"
          >
            {busy ? t('auth.verifying') : t('auth.verify')}
          </button>
          <div class="auth-actions">
            <button
              type="button"
              class="auth-btn auth-btn--link"
              disabled={busy || resendIn > 0}
              data-testid="login-resend"
              onClick={() => void send()}
            >
              {resendIn > 0 ? t('auth.resend_in', { seconds: resendIn }) : t('auth.resend')}
            </button>
            <button
              type="button"
              class="auth-btn auth-btn--link"
              data-testid="login-back"
              onClick={back}
            >
              {t('auth.change_identifier')}
            </button>
          </div>
        </form>
      )}
    </AuthScreen>
  );
}
