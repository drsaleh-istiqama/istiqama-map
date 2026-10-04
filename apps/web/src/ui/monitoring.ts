/**
 * Error monitoring (brief §1).
 *
 *  - A small local ring buffer of the last unhandled errors, shown in Settings → About so a
 *    field worker can read them out to support. It works with or without Sentry.
 *  - Sentry, loaded lazily and only when a DSN is configured. Everything sent is scrubbed:
 *    no names, phone numbers, e-mail addresses, tokens or URL query strings.
 */
import { signal, type Signal } from '@preact/signals';
import type * as SentryModule from '@sentry/browser';
import type { Breadcrumb, ErrorEvent } from '@sentry/browser';
import { env } from '../env';
import { getPref, setPref } from '../lib/prefs';
import { APP_VERSION } from '../version';

export interface ErrorEntry {
  /** ISO time of the last occurrence. */
  at: string;
  /** Scrubbed message. */
  message: string;
  source: 'error' | 'promise' | 'manual';
  /** How many times in a row this message was recorded. */
  count: number;
}

const BUFFER_PREF = 'diagnostics.errors';
export const MAX_ERROR_ENTRIES = 20;
const MAX_MESSAGE_LENGTH = 300;

// ---------------------------------------------------------------------------------------------
// Scrubbing (pure)
// ---------------------------------------------------------------------------------------------

const SCRUBBERS: ReadonlyArray<[RegExp, string]> = [
  // JSON Web Tokens (Supabase access / refresh tokens, signed URLs)
  [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, '[token]'],
  [/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer [token]'],
  // key=value / "key":"value" secrets (error codes such as "code":"PT403" stay readable)
  [
    /((?:access_token|refresh_token|token|apikey|api_key|authorization|password|otp|pin)["']?\s*[=:]\s*["']?)[^&\s"',}]+/gi,
    '$1[redacted]',
  ],
  // PostgreSQL constraint details: Key (phone)=(+255…) / Key (name_ar)=(…)
  [/\(([\w, ]+)\)=\([^)]*\)/g, '($1)=([redacted])'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  // Phone numbers and other long digit runs (coordinates included)
  [/\+?\d[\d\s().-]{7,}\d/g, '[number]'],
];

/** Removes e-mail addresses, phone numbers, tokens and secrets from free text. */
export function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out.length > MAX_MESSAGE_LENGTH ? `${out.slice(0, MAX_MESSAGE_LENGTH)}…` : out;
}

/** Origin + path only: PostgREST filters and signed-URL tokens live in the query string. */
export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://relative.invalid');
    const path = parsed.pathname;
    return parsed.origin === 'http://relative.invalid' ? path : `${parsed.origin}${path}`;
  } catch {
    return '[url]';
  }
}

const URL_FIELDS = ['url', 'to', 'from'] as const;

/** Sentry `beforeBreadcrumb`: no console output, no query strings, no free text. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') return null;
  const data = breadcrumb.data ? { ...breadcrumb.data } : undefined;
  if (data) {
    for (const field of URL_FIELDS) {
      const value: unknown = data[field];
      if (typeof value === 'string') data[field] = scrubUrl(value);
    }
    delete data.request_body_size;
    delete data.response_body_size;
  }
  return {
    ...breadcrumb,
    message: breadcrumb.message ? scrubText(breadcrumb.message) : breadcrumb.message,
    data,
  };
}

/** Sentry `beforeSend`: strip the user, request details and anything that may carry personal data. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const clean: ErrorEvent = { ...event };
  delete clean.user;
  delete clean.extra;
  if (clean.request) {
    clean.request = clean.request.url ? { url: scrubUrl(clean.request.url) } : {};
  }
  if (clean.message) clean.message = scrubText(clean.message);
  if (clean.exception?.values) {
    clean.exception = {
      ...clean.exception,
      values: clean.exception.values.map((value) => ({
        ...value,
        value: value.value ? scrubText(value.value) : value.value,
      })),
    };
  }
  if (clean.breadcrumbs) {
    clean.breadcrumbs = clean.breadcrumbs
      .map((breadcrumb) => scrubBreadcrumb(breadcrumb))
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);
  }
  return clean;
}

// ---------------------------------------------------------------------------------------------
// Local ring buffer
// ---------------------------------------------------------------------------------------------

function loadBuffer(): ErrorEntry[] {
  const saved = getPref<unknown>(BUFFER_PREF, []);
  return Array.isArray(saved) ? (saved as ErrorEntry[]).slice(-MAX_ERROR_ENTRIES) : [];
}

/** Last errors on this device, oldest first. */
export const recentErrors: Signal<ErrorEntry[]> = signal(loadBuffer());

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Pure ring-buffer step: repeated messages are counted instead of filling the buffer. */
export function appendError(
  buffer: readonly ErrorEntry[],
  entry: Omit<ErrorEntry, 'count'>,
): ErrorEntry[] {
  const last = buffer[buffer.length - 1];
  if (last && last.message === entry.message && last.source === entry.source) {
    return [...buffer.slice(0, -1), { ...entry, count: last.count + 1 }];
  }
  return [...buffer, { ...entry, count: 1 }].slice(-MAX_ERROR_ENTRIES);
}

export function recordError(error: unknown, source: ErrorEntry['source'] = 'manual'): void {
  const entry = { at: new Date().toISOString(), message: scrubText(messageOf(error)), source };
  recentErrors.value = appendError(recentErrors.value, entry);
  setPref(BUFFER_PREF, recentErrors.value);
}

export function clearRecentErrors(): void {
  recentErrors.value = [];
  setPref(BUFFER_PREF, []);
}

// ---------------------------------------------------------------------------------------------
// Sentry (lazy)
// ---------------------------------------------------------------------------------------------

let sentry: typeof SentryModule | null = null;
const beforeLoad: unknown[] = [];

async function startSentry(): Promise<void> {
  // The literal build-time test lets the bundler drop Sentry entirely from builds without a DSN.
  if (!import.meta.env.VITE_SENTRY_DSN) return;
  const Sentry = await import('@sentry/browser');
  Sentry.init({
    dsn: env.sentryDsn,
    release: APP_VERSION,
    environment: env.appEnv,
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== 'Breadcrumbs'),
      // DOM breadcrumbs carry selectors only (never text); test ids make them readable.
      Sentry.breadcrumbsIntegration({ dom: { serializeAttribute: ['data-testid'] } }),
    ],
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubEvent,
  });
  sentry = Sentry;
  for (const error of beforeLoad.splice(0)) Sentry.captureException(error);
}

/** Report a handled error (failed lazy chunk, failed background task…). */
export function captureError(error: unknown): void {
  recordError(error, 'manual');
  if (sentry) sentry.captureException(error);
  else if (env.sentryDsn && beforeLoad.length < 5) beforeLoad.push(error);
}

let started = false;

/** Call once at start-up. Cheap: Sentry itself loads when the browser is idle, and only with a DSN. */
export function initMonitoring(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('error', (event) => recordError(event.error ?? event.message, 'error'));
  window.addEventListener('unhandledrejection', (event) => recordError(event.reason, 'promise'));
  if (!env.sentryDsn) return;
  const start = (): void => {
    startSentry().catch((error: unknown) => recordError(error, 'manual'));
  };
  if (typeof window.requestIdleCallback === 'function')
    window.requestIdleCallback(start, { timeout: 5000 });
  else setTimeout(start, 3000);
}
