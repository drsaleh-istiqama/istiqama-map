/**
 * Auth screens: what is rendered in each state, the test ids the e2e suite relies on, and the
 * wiring between inputs and the session API. The session module is replaced by signals and spies.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../i18n', async () => {
  const { signal } = await import('@preact/signals');
  return {
    locale: signal('ar'),
    setLocale: vi.fn(async () => undefined),
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  };
});

vi.mock('../routes', () => ({ navigate: vi.fn() }));

vi.mock('./session', async () => {
  const { signal } = await import('@preact/signals');
  return {
    authState: signal('signed_out'),
    authNotice: signal(null),
    contextError: signal(null),
    lockMinutes: signal(15),
    initAuth: vi.fn(async () => undefined),
    refreshContext: vi.fn(async () => null),
    signInWithEmailOtp: vi.fn(async () => undefined),
    signInWithPhoneOtp: vi.fn(async () => undefined),
    verifyOtp: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    askConfirm: vi.fn(async () => true),
    pin: {
      set: vi.fn(async () => undefined),
      tryUnlock: vi.fn(async () => 'ok'),
      forget: vi.fn(async () => undefined),
      attempts: signal({ failures: 0, retryAt: 0 }),
      maxFailures: 10,
    },
  };
});

vi.mock('./mfa', () => ({
  getMfaStatus: vi.fn(async () => ({ verifiedFactorId: null })),
  startTotpEnrolment: vi.fn(async () => ({
    factorId: 'factor-1',
    qrDataUrl: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E',
    secret: 'JBSWY3DPEHPK3PXP',
  })),
  verifyTotp: vi.fn(async () => undefined),
}));

import type { Signal } from '@preact/signals';
import { locale, setLocale } from '../i18n';
import { clearPrefs } from '../lib/prefs';
import { navigate } from '../routes';
import { APP_VERSION } from '../version';
import { AuthGate } from './AuthGate';
import { AuthFlowError } from './errors';
import LoginView from './LoginView';
import { getMfaStatus, startTotpEnrolment, verifyTotp } from './mfa';
import { MfaView } from './MfaView';
import { PinLock } from './PinLock';
import { PinSetup } from './PinSetup';
import * as session from './session';

const authState = session.authState as unknown as Signal<string>;
const authNotice = session.authNotice as unknown as Signal<string | null>;
const contextError = session.contextError as unknown as Signal<string | null>;
const attempts = session.pin.attempts as unknown as Signal<{ failures: number; retryAt: number }>;

function type(testId: string, value: string): HTMLInputElement {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  return input;
}

beforeEach(() => {
  clearPrefs(); // the login screen remembers the last tab and country prefix
  authState.value = 'signed_out';
  authNotice.value = null;
  contextError.value = null;
  attempts.value = { failures: 0, retryAt: 0 };
  (locale as unknown as Signal<string>).value = 'ar';
  // `restoreMocks` clears implementations between tests: give the spies their defaults again.
  vi.mocked(session.signInWithEmailOtp).mockResolvedValue(undefined);
  vi.mocked(session.signInWithPhoneOtp).mockResolvedValue(undefined);
  vi.mocked(session.verifyOtp).mockResolvedValue(undefined);
  vi.mocked(session.signOut).mockResolvedValue(undefined);
  vi.mocked(session.initAuth).mockResolvedValue(undefined);
  vi.mocked(session.refreshContext).mockResolvedValue(null);
  vi.mocked(session.askConfirm).mockResolvedValue(true);
  vi.mocked(session.pin.set).mockResolvedValue(undefined);
  vi.mocked(session.pin.tryUnlock).mockResolvedValue('ok');
  vi.mocked(session.pin.forget).mockResolvedValue(undefined);
  vi.mocked(setLocale).mockResolvedValue(undefined);
  vi.mocked(getMfaStatus).mockResolvedValue({ verifiedFactorId: null });
  vi.mocked(startTotpEnrolment).mockResolvedValue({
    factorId: 'factor-1',
    qrDataUrl: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E',
    secret: 'JBSWY3DPEHPK3PXP',
  });
  vi.mocked(verifyTotp).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoginView', () => {
  it('offers e-mail and phone sign-in, the language switcher and the version — and no password', () => {
    const { container } = render(<LoginView />);
    for (const id of [
      'login-tab-email',
      'login-tab-phone',
      'login-email',
      'login-submit',
      'lang-ar',
      'lang-sw',
      'lang-en',
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getByTestId('app-version').textContent).toContain(APP_VERSION);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).not.toMatch(/password/i);
    expect(screen.getByTestId('login-tab-email').getAttribute('aria-selected')).toBe('true');
  });

  it('e-mail flow: request a code, then verify it', async () => {
    render(<LoginView />);
    type('login-email', ' Collector.Pemba@Example.org ');
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => expect(screen.getByTestId('login-code')).toBeTruthy());
    expect(session.signInWithEmailOtp).toHaveBeenCalledWith('collector.pemba@example.org');
    expect(screen.getByTestId('login-sent').textContent).toBe('collector.pemba@example.org');
    expect((screen.getByTestId('login-verify') as HTMLButtonElement).disabled).toBe(true);

    const code = type('login-code', '12 34-56');
    expect(code.value).toBe('123456'); // digits only
    fireEvent.click(screen.getByTestId('login-verify'));
    await waitFor(() =>
      expect(session.verifyOtp).toHaveBeenCalledWith(
        'collector.pemba@example.org',
        '123456',
        'email',
      ),
    );
  });

  it('phone flow: country prefix + national number become E.164', async () => {
    render(<LoginView />);
    fireEvent.click(screen.getByTestId('login-tab-phone'));
    expect(screen.getByTestId('login-tab-phone').getAttribute('aria-selected')).toBe('true');
    fireEvent.change(screen.getByTestId('login-country'), { target: { value: 'KE' } });
    type('login-phone', '0700 000 001');
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => expect(session.signInWithPhoneOtp).toHaveBeenCalledWith('+254700000001'));
    await waitFor(() => expect(screen.getByTestId('login-code')).toBeTruthy());
    type('login-code', '654321');
    fireEvent.click(screen.getByTestId('login-verify'));
    await waitFor(() =>
      expect(session.verifyOtp).toHaveBeenCalledWith('+254700000001', '654321', 'sms'),
    );
  });

  it('refuses an implausible phone number without calling the server', async () => {
    render(<LoginView />);
    fireEvent.click(screen.getByTestId('login-tab-phone'));
    type('login-phone', '12');
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('login-error').textContent).toBe('auth.error_invalid_phone'),
    );
    expect(session.signInWithPhoneOtp).not.toHaveBeenCalled();
  });

  it('shows friendly errors next to the field, linked for assistive technology', async () => {
    vi.mocked(session.signInWithEmailOtp).mockRejectedValue(new AuthFlowError('rate_limited'));
    render(<LoginView />);
    const input = type('login-email', 'a@example.org');
    fireEvent.click(screen.getByTestId('login-submit'));
    const error = await waitFor(() => {
      const node = screen.getByTestId('login-error');
      expect(node.textContent).toBe('auth.error_rate_limited');
      return node;
    });
    expect(error.getAttribute('role')).toBe('alert');
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByTestId('login-code')).toBeNull();
  });

  it('a wrong code keeps the user on the code step with a message', async () => {
    vi.mocked(session.verifyOtp).mockRejectedValue(new AuthFlowError('code_invalid'));
    render(<LoginView />);
    type('login-email', 'a@example.org');
    fireEvent.click(screen.getByTestId('login-submit'));
    await waitFor(() => screen.getByTestId('login-code'));
    type('login-code', '000000');
    fireEvent.click(screen.getByTestId('login-verify'));
    await waitFor(() =>
      expect(screen.getByTestId('login-error').textContent).toBe('auth.error_code_invalid'),
    );
    expect(screen.getByTestId('login-code')).toBeTruthy();
    // Resend is rate-limited on the client for a minute; going back is always possible.
    expect((screen.getByTestId('login-resend') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('login-back'));
    expect(screen.getByTestId('login-email')).toBeTruthy();
  });

  it('switches the language', () => {
    render(<LoginView />);
    fireEvent.click(screen.getByTestId('lang-sw'));
    expect(setLocale).toHaveBeenCalledWith('sw');
    fireEvent.click(screen.getByTestId('lang-en'));
    expect(setLocale).toHaveBeenCalledWith('en');
    expect(screen.getByTestId('lang-ar').getAttribute('aria-pressed')).toBe('true');
  });

  it('explains why the user is back at the login screen', () => {
    authNotice.value = 'revoked';
    render(<LoginView />);
    expect(screen.getByTestId('login-notice').textContent).toContain('auth.notice_revoked');
  });

  it('warns when offline', () => {
    vi.stubGlobal('navigator', { onLine: false });
    render(<LoginView />);
    expect(screen.getByTestId('login-offline').textContent).toBe('auth.offline_banner');
  });

  it('leaves /login once a session exists', async () => {
    authState.value = 'ready';
    render(<LoginView />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }));
    expect(screen.queryByTestId('login-email')).toBeNull();
    expect(screen.getByTestId('login-continue')).toBeTruthy();
  });
});

describe('PinSetup', () => {
  it('saves a PIN entered twice', async () => {
    render(<PinSetup />);
    type('pin-input', '4071');
    type('pin-confirm', '4071');
    fireEvent.click(screen.getByTestId('pin-submit'));
    await waitFor(() => expect(session.pin.set).toHaveBeenCalledWith('4071'));
  });

  it('rejects a mismatch before anything is saved', async () => {
    render(<PinSetup />);
    type('pin-input', '4071');
    type('pin-confirm', '4072');
    fireEvent.click(screen.getByTestId('pin-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('pin-error').textContent).toContain('auth.error_pin_mismatch'),
    );
    expect(session.pin.set).not.toHaveBeenCalled();
  });

  it('shows the reason when the PIN is refused (too easy to guess)', async () => {
    vi.mocked(session.pin.set).mockRejectedValue(new AuthFlowError('pin_weak'));
    render(<PinSetup />);
    type('pin-input', '1234');
    type('pin-confirm', '1234');
    fireEvent.click(screen.getByTestId('pin-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('pin-error').textContent).toContain('auth.error_pin_weak'),
    );
  });

  it('accepts digits only, at most eight, and needs at least four to submit', () => {
    render(<PinSetup />);
    expect(type('pin-input', '12ab34567890').value).toBe('12345678');
    type('pin-input', '123');
    type('pin-confirm', '123');
    expect((screen.getByTestId('pin-submit') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('pin-input') as HTMLInputElement).type).toBe('password');
  });
});

describe('PinLock', () => {
  it('tries the PIN', async () => {
    render(<PinLock />);
    type('pin-input', '4071');
    fireEvent.click(screen.getByTestId('pin-submit'));
    await waitFor(() => expect(session.pin.tryUnlock).toHaveBeenCalledWith('4071'));
  });

  it('reports a wrong PIN with the attempts left and clears the field', async () => {
    vi.mocked(session.pin.tryUnlock).mockImplementation(async () => {
      attempts.value = { failures: 3, retryAt: 0 };
      return 'wrong';
    });
    render(<PinLock />);
    type('pin-input', '9999');
    fireEvent.click(screen.getByTestId('pin-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('pin-error').textContent).toBe('auth.pin_wrong {"remaining":7}'),
    );
    expect((screen.getByTestId('pin-input') as HTMLInputElement).value).toBe('');
  });

  it('blocks input while the retry delay runs', () => {
    attempts.value = { failures: 4, retryAt: Date.now() + 8000 };
    render(<PinLock />);
    expect((screen.getByTestId('pin-input') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('pin-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('pin-error').textContent).toContain('auth.pin_wait');
  });

  it('"forgot PIN" asks first, then destroys the stored session only', async () => {
    vi.mocked(session.askConfirm).mockResolvedValueOnce(false);
    render(<PinLock />);
    fireEvent.click(screen.getByTestId('pin-forgot'));
    await waitFor(() => expect(session.askConfirm).toHaveBeenCalledTimes(1));
    expect(session.pin.forget).not.toHaveBeenCalled();

    vi.mocked(session.askConfirm).mockResolvedValueOnce(true);
    fireEvent.click(screen.getByTestId('pin-forgot'));
    await waitFor(() => expect(session.pin.forget).toHaveBeenCalledTimes(1));
    expect(session.signOut).not.toHaveBeenCalled();
  });
});

describe('MfaView', () => {
  it('first time: shows QR code and manual key, then verifies the code', async () => {
    render(<MfaView />);
    const qr = (await waitFor(() => screen.getByTestId('mfa-qr'))) as HTMLImageElement;
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(qr.getAttribute('alt')).toBe('auth.mfa_qr_alt');
    expect(screen.getByTestId('mfa-secret').textContent).toBe('JBSW Y3DP EHPK 3PXP');
    expect((screen.getByTestId('mfa-verify') as HTMLButtonElement).disabled).toBe(true);
    type('mfa-code', '123456');
    fireEvent.click(screen.getByTestId('mfa-verify'));
    await waitFor(() => expect(verifyTotp).toHaveBeenCalledWith('factor-1', '123456'));
  });

  it('later sign-ins: challenges the existing factor without enrolling again', async () => {
    vi.mocked(getMfaStatus).mockResolvedValue({ verifiedFactorId: 'factor-9' });
    render(<MfaView />);
    await waitFor(() => screen.getByTestId('mfa-code'));
    expect(startTotpEnrolment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-qr')).toBeNull();
    type('mfa-code', '654321');
    fireEvent.click(screen.getByTestId('mfa-verify'));
    await waitFor(() => expect(verifyTotp).toHaveBeenCalledWith('factor-9', '654321'));
  });

  it('a wrong code shows a message and empties the field', async () => {
    vi.mocked(verifyTotp).mockRejectedValue(new AuthFlowError('mfa_code_invalid'));
    render(<MfaView />);
    await waitFor(() => screen.getByTestId('mfa-code'));
    type('mfa-code', '000000');
    fireEvent.click(screen.getByTestId('mfa-verify'));
    await waitFor(() =>
      expect(screen.getByTestId('mfa-error').textContent).toBe('auth.error_mfa_code_invalid'),
    );
    expect((screen.getByTestId('mfa-code') as HTMLInputElement).value).toBe('');
  });

  it('can retry when the factors cannot be loaded (offline) and always offers sign-out', async () => {
    vi.mocked(getMfaStatus).mockRejectedValueOnce(new AuthFlowError('offline'));
    render(<MfaView />);
    await waitFor(() =>
      expect(screen.getByTestId('mfa-failed').textContent).toContain('auth.error_offline'),
    );
    fireEvent.click(screen.getByTestId('mfa-retry'));
    await waitFor(() => screen.getByTestId('mfa-qr'));
    fireEvent.click(screen.getByTestId('mfa-signout'));
    expect(session.signOut).toHaveBeenCalled();
  });
});

describe('AuthGate', () => {
  const Data = () => <div data-testid="data-screen">secret records</div>;

  const cases: Array<[string, string]> = [
    ['loading', 'auth-loading'],
    ['signed_out', 'login-view'],
    ['pin_setup', 'pin-setup'],
    ['locked', 'pin-lock'],
    ['context', 'auth-context'],
    ['mfa', 'mfa-view'],
  ];

  for (const [state, testId] of cases) {
    it(`${state}: shows ${testId} and does not render the data screens`, async () => {
      authState.value = state;
      render(
        <AuthGate>
          <Data />
        </AuthGate>,
      );
      expect(screen.getByTestId(testId)).toBeTruthy();
      expect(screen.queryByTestId('data-screen')).toBeNull();
      await waitFor(() => expect(session.initAuth).toHaveBeenCalled());
    });
  }

  it('ready: renders the application', () => {
    authState.value = 'ready';
    render(
      <AuthGate>
        <Data />
      </AuthGate>,
    );
    expect(screen.getByTestId('data-screen')).toBeTruthy();
  });

  it('locking unmounts the data screens at once and shows the PIN input', async () => {
    authState.value = 'ready';
    render(
      <AuthGate>
        <Data />
      </AuthGate>,
    );
    authState.value = 'locked';
    await waitFor(() => expect(screen.queryByTestId('data-screen')).toBeNull());
    expect(screen.getByTestId('pin-input')).toBeTruthy();
  });

  it('context screen: explains the offline case and retries', async () => {
    authState.value = 'context';
    contextError.value = 'offline';
    render(
      <AuthGate>
        <Data />
      </AuthGate>,
    );
    expect(screen.getByTestId('context-error').textContent).toBe('auth.context_offline');
    fireEvent.click(screen.getByTestId('context-retry'));
    expect(session.refreshContext).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('context-signout'));
    expect(session.signOut).toHaveBeenCalled();
  });
});
