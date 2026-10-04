import type { ErrorEvent } from '@sentry/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../lib/prefs', () => ({
  getPref: <T>(key: string, fallback: T): T =>
    prefStore.has(key) ? (prefStore.get(key) as T) : fallback,
  setPref: (key: string, value: unknown): void => {
    prefStore.set(key, JSON.parse(JSON.stringify(value)));
  },
}));

import {
  appendError,
  clearRecentErrors,
  MAX_ERROR_ENTRIES,
  recentErrors,
  recordError,
  scrubBreadcrumb,
  scrubEvent,
  scrubText,
  scrubUrl,
  type ErrorEntry,
} from './monitoring';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6ImF1dGgifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('scrubText — nothing personal leaves the device', () => {
  it('removes e-mail addresses', () => {
    expect(scrubText('user collector.pemba@example.org not found')).toBe('user [email] not found');
  });

  it('removes phone numbers and other long digit runs', () => {
    expect(scrubText('duplicate phone +255 700 000 001')).toBe('duplicate phone [number]');
    expect(scrubText('call 0712345678 now')).toBe('call [number] now');
    expect(scrubText('status 404 after 3 retries')).toBe('status 404 after 3 retries');
  });

  it('removes tokens and secrets', () => {
    expect(scrubText(`Authorization: Bearer ${JWT}`)).not.toContain('eyJ');
    expect(scrubText(`failed with token ${JWT}`)).toBe('failed with token [token]');
    expect(scrubText('GET /x?apikey=abc123&select=*')).toBe('GET /x?apikey=[redacted]&select=*');
    expect(scrubText('{"password":"hunter2","otp":"123456"}')).toBe(
      '{"password":"[redacted]","otp":"[redacted]"}',
    );
    expect(scrubText('pin=4821')).toBe('pin=[redacted]');
  });

  it('removes values quoted by PostgreSQL constraint errors', () => {
    expect(scrubText('Key (phone_e164)=(+255700000001) already exists.')).toBe(
      'Key (phone_e164)=([redacted]) already exists.',
    );
    expect(scrubText('Key (name_ar)=(سالم بن ناصر) already exists.')).toBe(
      'Key (name_ar)=([redacted]) already exists.',
    );
  });

  it('keeps ordinary technical messages readable and bounded', () => {
    expect(scrubText("TypeError: Cannot read properties of undefined (reading 'id')")).toBe(
      "TypeError: Cannot read properties of undefined (reading 'id')",
    );
    expect(scrubText('x'.repeat(1000)).length).toBeLessThanOrEqual(301);
  });
});

describe('scrubUrl', () => {
  it('drops the query string and fragment (filters, signed-URL tokens)', () => {
    expect(scrubUrl('https://api.example.org/rest/v1/persons?phone_e164=eq.%2B255700000001')).toBe(
      'https://api.example.org/rest/v1/persons',
    );
    expect(
      scrubUrl(`https://api.example.org/storage/v1/object/sign/photos/a_full.webp?token=${JWT}`),
    ).toBe('https://api.example.org/storage/v1/object/sign/photos/a_full.webp');
    expect(scrubUrl('/projects/0190?tab=staff#x')).toBe('/projects/0190');
  });
});

describe('Sentry hooks', () => {
  it('drops console breadcrumbs and cleans URLs and messages of the others', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'user amina@example.org' })).toBeNull();
    const fetchCrumb = scrubBreadcrumb({
      category: 'fetch',
      data: {
        method: 'GET',
        url: 'https://api.example.org/rest/v1/persons?name_ar=ilike.*سالم*',
        status_code: 200,
      },
    });
    expect(fetchCrumb?.data).toEqual({
      method: 'GET',
      url: 'https://api.example.org/rest/v1/persons',
      status_code: 200,
    });
    const nav = scrubBreadcrumb({
      category: 'navigation',
      data: { from: '/people?q=سالم', to: '/projects/1' },
    });
    expect(nav?.data).toEqual({ from: '/people', to: '/projects/1' });
    expect(scrubBreadcrumb({ category: 'ui.click', message: 'mail to a@b.org' })?.message).toBe(
      'mail to [email]',
    );
  });

  it('strips user, extras, request details and personal data from events', () => {
    const event = {
      type: undefined,
      message: 'cannot save +255700000001',
      user: { id: 'u1', email: 'amina@example.org', ip_address: '10.0.0.1' },
      extra: { form: { name_ar: 'سالم' } },
      request: {
        url: 'https://map.example.org/people?q=سالم',
        headers: { Authorization: `Bearer ${JWT}` },
      },
      exception: { values: [{ type: 'Error', value: `bad token ${JWT} for amina@example.org` }] },
      breadcrumbs: [
        { category: 'console', message: 'secret' },
        { category: 'xhr', data: { url: 'https://api.example.org/rest/v1/rpc/search?p_q=سالم' } },
      ],
    } as unknown as ErrorEvent;

    const clean = scrubEvent(event);
    const text = JSON.stringify(clean);
    expect(clean.user).toBeUndefined();
    expect(clean.extra).toBeUndefined();
    expect(clean.request).toEqual({ url: 'https://map.example.org/people' });
    expect(clean.message).toBe('cannot save [number]');
    expect(clean.exception?.values?.[0]?.value).toBe('bad token [token] for [email]');
    expect(clean.breadcrumbs).toHaveLength(1);
    expect(text).not.toContain('amina');
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('سالم');
    expect(text).not.toContain('255700000001');
    // The original object is not mutated.
    expect((event.user as { email: string }).email).toBe('amina@example.org');
  });
});

describe('local error buffer (Settings → About)', () => {
  beforeEach(() => {
    prefStore.clear();
    clearRecentErrors();
  });

  const entry = (message: string): Omit<ErrorEntry, 'count'> => ({
    at: '2026-10-03T10:00:00.000Z',
    message,
    source: 'error',
  });

  it('keeps only the newest entries', () => {
    let buffer: ErrorEntry[] = [];
    for (let i = 0; i < MAX_ERROR_ENTRIES + 15; i++)
      buffer = appendError(buffer, entry(`error ${i}`));
    expect(buffer).toHaveLength(MAX_ERROR_ENTRIES);
    expect(buffer[0]?.message).toBe('error 15');
    expect(buffer[buffer.length - 1]?.message).toBe(`error ${MAX_ERROR_ENTRIES + 14}`);
  });

  it('counts a repeated message instead of filling the buffer with it', () => {
    let buffer: ErrorEntry[] = [];
    for (let i = 0; i < 50; i++) buffer = appendError(buffer, entry('same'));
    buffer = appendError(buffer, entry('other'));
    expect(buffer.map((e) => [e.message, e.count])).toEqual([
      ['same', 50],
      ['other', 1],
    ]);
  });

  it('records scrubbed messages, persists them and can be cleared', () => {
    recordError(new Error('upload failed for amina@example.org'), 'promise');
    recordError('plain text');
    recordError({ code: 42 });
    expect(recentErrors.value.map((e) => e.message)).toEqual([
      'Error: upload failed for [email]',
      'plain text',
      '{"code":42}',
    ]);
    expect(recentErrors.value[0]?.source).toBe('promise');
    expect((prefStore.get('diagnostics.errors') as ErrorEntry[]).length).toBe(3);

    clearRecentErrors();
    expect(recentErrors.value).toEqual([]);
    expect(prefStore.get('diagnostics.errors')).toEqual([]);
  });
});
