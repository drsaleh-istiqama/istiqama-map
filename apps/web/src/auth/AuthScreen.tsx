/**
 * Shared frame of the auth screens (login, PIN, MFA): brand header, language switcher,
 * version footer, plus a few tiny hooks. Deliberately self-contained (plain elements + auth.css)
 * so that these screens work before anything else of the shell has loaded.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { env } from '../env';
import { locale, setLocale, t, type Locale } from '../i18n';
import { APP_VERSION } from '../version';
import './auth.css';

const LOCALES: readonly Locale[] = ['ar', 'sw', 'en'];

export function LanguageSwitcher() {
  const current = locale.value;
  return (
    <div class="auth-lang" role="group" aria-label={t('auth.language')}>
      {LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          class="auth-lang__btn"
          lang={code}
          aria-pressed={current === code}
          data-testid={`lang-${code}`}
          onClick={() => void setLocale(code)}
        >
          {t(`auth.lang_${code}`)}
        </button>
      ))}
    </div>
  );
}

export function AuthScreen(props: { title: string; testId: string; children: ComponentChildren }) {
  // Reading the signal re-renders the frame (and its children) when the language changes.
  void locale.value;
  return (
    <div class="auth-screen" data-testid={props.testId}>
      <header class="auth-screen__header">
        <p class="auth-screen__brand">{env.appName || t('auth.app_title')}</p>
        <LanguageSwitcher />
      </header>
      <main class="auth-card">
        <h1 class="auth-card__title">{props.title}</h1>
        {props.children}
      </main>
      <footer class="auth-screen__footer">
        <span dir="ltr" data-testid="app-version">
          {t('auth.version', { version: APP_VERSION })}
        </span>
      </footer>
    </div>
  );
}

/** Inline error linked to its control through `aria-describedby={id}`. */
export function ErrorText(props: { id: string; message: string | null; testId?: string }) {
  return (
    <p id={props.id} class="auth-error" role="alert" data-testid={props.testId}>
      {props.message ?? ''}
    </p>
  );
}

export function Notice(props: {
  kind?: 'info' | 'warning';
  children: ComponentChildren;
  testId?: string;
}) {
  return (
    <p
      class={`auth-notice auth-notice--${props.kind ?? 'info'}`}
      role="status"
      data-testid={props.testId}
    >
      {props.children}
    </p>
  );
}

export function useOnline(): boolean {
  const read = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;
  const [online, setOnline] = useState(read);
  useEffect(() => {
    const update = (): void => setOnline(read());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** Whole seconds left until `deadline` (epoch ms); re-renders once per second while positive. */
export function useCountdown(deadline: number): number {
  const remaining = (): number => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const [seconds, setSeconds] = useState(remaining);
  useEffect(() => {
    setSeconds(remaining());
    if (deadline <= Date.now()) return undefined;
    const timer = setInterval(() => {
      const left = remaining();
      setSeconds(left);
      if (left <= 0) clearInterval(timer);
    }, 500);
    return () => clearInterval(timer);
  }, [deadline]);
  return seconds;
}

/** Keeps only ASCII digits (Arabic-Indic digits typed on Arabic keyboards are converted). */
export function onlyDigits(value: string, maxLength: number): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x30 && code <= 0x39) out += ch;
    else if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    if (out.length >= maxLength) break;
  }
  return out;
}
