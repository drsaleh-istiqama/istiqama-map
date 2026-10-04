import { describe, expect, it } from 'vitest';
import { downloadUrlOf } from './api';

describe('downloadUrlOf — download link issued by the export function', () => {
  const path = '/storage/v1/object/sign/exports/u/j.xlsx?token=abc&download=x.xlsx';

  it('resolves the returned path against the app API URL (the function may see an internal origin)', () => {
    const body = { download: { url: `http://kong:8000${path}`, path } };
    expect(downloadUrlOf(body, 'https://api.example.org/')).toBe(`https://api.example.org${path}`);
    expect(downloadUrlOf(body, 'http://127.0.0.1:54321')).toBe(`http://127.0.0.1:54321${path}`);
  });

  it('falls back to the absolute url, and is null without a download', () => {
    expect(downloadUrlOf({ download: { url: `http://x${path}`, path: null } }, 'http://a')).toBe(
      `http://x${path}`,
    );
    expect(downloadUrlOf({ download: { url: `http://x${path}`, path } }, '')).toBe(
      `http://x${path}`,
    );
    expect(downloadUrlOf({ job: {}, download: null }, 'http://a')).toBeNull();
    expect(downloadUrlOf({ job: {} }, 'http://a')).toBeNull();
    expect(downloadUrlOf(null, 'http://a')).toBeNull();
  });
});
