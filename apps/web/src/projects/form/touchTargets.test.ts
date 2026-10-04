/**
 * Touch targets >= 44 px (brief §12, 2 GB Android phones). happy-dom applies no stylesheet,
 * so this guards the CSS rule itself; tests/e2e/form.spec.ts measures the real buttons.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of the rule whose selector list is exactly `selectors` (order-free). */
function ruleFor(sheet: string, selectors: string[]): string | null {
  const want = [...selectors].sort().join(',');
  for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = m[1]!
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .sort()
      .join(',');
    if (list === want) return m[2]!;
  }
  return null;
}

describe('form touch targets', () => {
  it('small buttons of the form, its panel and its dialogs are at least --tap high', () => {
    const body = ruleFor(css('./form.css'), [
      '.pf-page .btn--sm',
      '.pf .btn--sm',
      '.pf-dialog .btn--sm',
    ]);
    expect(body).not.toBeNull();
    expect(body).toMatch(/min-block-size:\s*var\(--tap\)/);
  });

  it('--tap is 44 px', () => {
    expect(css('../../ui/tokens.css')).toMatch(/--tap:\s*44px/);
  });
});
