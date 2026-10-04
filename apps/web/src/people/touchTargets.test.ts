/**
 * Touch targets >= 44 px (2 GB Android phones). happy-dom applies no stylesheet, so this
 * guards the CSS rules themselves; tests/e2e/people.spec.ts measures the real elements.
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

describe('people touch targets', () => {
  it('the project link of the person card is a block at least --tap high', () => {
    const body = ruleFor(css('./people.css'), ['.pcard__project']);
    expect(body).not.toBeNull();
    expect(body).toMatch(/min-block-size:\s*var\(--tap\)/);
    // An inline link ignores min-block-size: it must be laid out as a (inline-)flex box.
    expect(body).toMatch(/display:\s*(inline-)?flex/);
  });

  it('small buttons of the module are at least --tap high', () => {
    const body = ruleFor(css('./people.css'), [
      '.pp .btn--sm',
      '.ps .btn--sm',
      '.people .btn--sm',
      '.merge__sides .btn--sm',
      '.merge__suggestions .btn--sm',
      '.mreq .btn--sm',
    ]);
    expect(body).toMatch(/min-block-size:\s*var\(--tap\)/);
  });

  it('--tap is 44 px', () => {
    expect(css('../ui/tokens.css')).toMatch(/--tap:\s*44px/);
  });
});
