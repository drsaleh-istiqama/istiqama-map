/**
 * Gate in front of the whole application. Children (every data screen) are rendered only when
 * the user is signed in, has a PIN, the app is unlocked, the account context is known and — for
 * managers and HQ — the second factor has been passed. Locking unmounts the children.
 */
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { t } from '../i18n';
import { AuthScreen, Notice } from './AuthScreen';
import LoginView from './LoginView';
import { MfaView } from './MfaView';
import { PinLock } from './PinLock';
import { PinSetup } from './PinSetup';
import { authState, contextError, initAuth, refreshContext, signOut } from './session';

function Loading() {
  return (
    <div
      class="auth-screen auth-screen--loading"
      role="status"
      aria-live="polite"
      data-testid="auth-loading"
    >
      <span class="auth-spinner" aria-hidden="true" />
      <span class="auth-visually-hidden">{t('auth.loading')}</span>
    </div>
  );
}

/** Signed in, but `my_context()` has never been loaded on this device (needs the network once). */
function ContextPending() {
  const problem = contextError.value;
  return (
    <AuthScreen title={t('auth.context_title')} testId="auth-context">
      {problem === null ? (
        <Notice testId="context-loading">{t('auth.context_loading')}</Notice>
      ) : (
        <div class="auth-form">
          <Notice kind="warning" testId="context-error">
            {problem === 'offline' ? t('auth.context_offline') : t('auth.context_failed')}
          </Notice>
          <button
            type="button"
            class="auth-btn auth-btn--primary"
            data-testid="context-retry"
            onClick={() => void refreshContext()}
          >
            {t('auth.retry')}
          </button>
        </div>
      )}
      <div class="auth-actions">
        <button
          type="button"
          class="auth-btn auth-btn--link"
          data-testid="context-signout"
          onClick={() => void signOut()}
        >
          {t('auth.sign_out')}
        </button>
      </div>
    </AuthScreen>
  );
}

export function AuthGate(props: { children: ComponentChildren }) {
  useEffect(() => {
    void initAuth();
  }, []);

  switch (authState.value) {
    case 'loading':
      return <Loading />;
    case 'signed_out':
      return <LoginView />;
    case 'pin_setup':
      return <PinSetup />;
    case 'locked':
      return <PinLock />;
    case 'context':
      return <ContextPending />;
    case 'mfa':
      return <MfaView />;
    case 'ready':
      return <>{props.children}</>;
  }
}

export default AuthGate;
