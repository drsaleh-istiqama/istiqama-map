/**
 * Accessibility probes on the live page (no Lighthouse needed):
 *
 *  1. axe-core — the engine Lighthouse's accessibility category runs — restricted to the rules
 *     Lighthouse uses, with an ESTIMATED Lighthouse score (impact-weighted pass ratio of the
 *     applicable rules). axe-core comes from node_modules (eslint-plugin-jsx-a11y depends on
 *     it); nothing is downloaded.
 *  2. Design-token contrast: the text/background pairs of src/ui/tokens.css, read from the
 *     shipped CSS (getComputedStyle on :root), against WCAG AA.
 *  3. Labels: every visible form control has an accessible name (placeholder alone = warning).
 *  4. Landmarks: exactly one <main>, an <h1>, lang + dir on <html>.
 *  5. Tap targets: visible interactive elements ≥ 24×24 CSS px (WCAG 2.5.8 AA = error),
 *     ≥ 44×44 recommended for field phones (--tap token, brief §12) = warning.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import { IMPACT_WEIGHT } from './scoring.ts';
import type { Check } from './installability.ts';

const require = createRequire(import.meta.url);

/** Accessibility audits of Lighthouse 12 that map 1:1 to axe rules. */
export const LIGHTHOUSE_AXE_RULES = [
  'accesskeys',
  'aria-allowed-attr',
  'aria-allowed-role',
  'aria-command-name',
  'aria-conditional-attr',
  'aria-deprecated-role',
  'aria-dialog-name',
  'aria-hidden-body',
  'aria-hidden-focus',
  'aria-input-field-name',
  'aria-meter-name',
  'aria-progressbar-name',
  'aria-prohibited-attr',
  'aria-required-attr',
  'aria-required-children',
  'aria-required-parent',
  'aria-roles',
  'aria-text',
  'aria-toggle-field-name',
  'aria-tooltip-name',
  'aria-treeitem-name',
  'aria-valid-attr-value',
  'aria-valid-attr',
  'button-name',
  'bypass',
  'color-contrast',
  'definition-list',
  'dlitem',
  'document-title',
  'duplicate-id-aria',
  'empty-heading',
  'form-field-multiple-labels',
  'frame-title',
  'heading-order',
  'html-has-lang',
  'html-lang-valid',
  'html-xml-lang-mismatch',
  'identical-links-same-purpose',
  'image-alt',
  'image-redundant-alt',
  'input-button-name',
  'input-image-alt',
  'label-content-name-mismatch',
  'label',
  'landmark-one-main',
  'link-in-text-block',
  'link-name',
  'list',
  'listitem',
  'meta-refresh',
  'meta-viewport',
  'object-alt',
  'select-name',
  'skip-link',
  'tabindex',
  'table-duplicate-name',
  'target-size',
  'td-headers-attr',
  'th-has-data-cells',
  'valid-lang',
  'video-caption',
];

/** [foreground token, background token, minimum ratio, what the pair is used for]. */
export const TOKEN_PAIRS: [string, string, number, string][] = [
  ['--c-text', '--c-bg', 4.5, 'body text on page background'],
  ['--c-text', '--c-surface', 4.5, 'body text on cards'],
  ['--c-text', '--c-surface-2', 4.5, 'body text on secondary surface'],
  ['--c-muted', '--c-surface', 4.5, 'secondary text on cards'],
  ['--c-muted', '--c-bg', 4.5, 'secondary text on page background'],
  ['--c-gold-ink', '--c-surface', 4.5, 'gold text on light surfaces'],
  ['--c-gold-ink', '--c-gold-soft', 4.5, 'gold text on gold-soft'],
  ['--c-on-navy', '--c-navy', 4.5, 'text on navy'],
  ['--c-on-navy-muted', '--c-navy', 4.5, 'muted text on navy'],
  ['--c-gold', '--c-navy', 4.5, 'gold text on navy'],
  ['--c-on-navy', '--c-navy-600', 4.5, 'text on navy-600 (hover)'],
  ['--c-active-ink', '--c-active-soft', 4.5, 'status badge: active'],
  ['--c-maintenance-ink', '--c-maintenance-soft', 4.5, 'status badge: maintenance'],
  ['--c-building-ink', '--c-building-soft', 4.5, 'status badge: building'],
  ['--c-inactive-ink', '--c-inactive-soft', 4.5, 'status badge: inactive'],
  ['--c-danger', '--c-surface', 4.5, 'error text'],
  ['--c-danger', '--c-danger-soft', 4.5, 'error text on error background'],
  ['--c-on-navy', '--c-warning-bg', 4.5, 'offline banner'],
  ['--c-line-strong', '--c-surface', 3, 'input borders (non-text, WCAG 1.4.11)'],
  ['--c-focus', '--c-surface', 3, 'focus ring (non-text)'],
  ['--c-active', '--c-surface', 3, 'status marker: active (non-text)'],
  ['--c-maintenance', '--c-surface', 3, 'status marker: maintenance (non-text)'],
  ['--c-building', '--c-surface', 3, 'status marker: building (non-text)'],
  ['--c-inactive', '--c-surface', 3, 'status marker: inactive (non-text)'],
];

/** WCAG relative luminance of #rgb / #rrggbb / rgb(…). */
export function luminance(color: string): number | null {
  const c = color.trim().toLowerCase();
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join('') : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(c);
    if (m) rgb = [m[1], m[2], m[3]].map(Number);
  }
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface A11yReport {
  checks: Check[];
  axe: {
    estimatedScore: number;
    applicable: number;
    violations: { id: string; impact: string; nodes: number; help: string; sample: string }[];
    incomplete: string[];
  };
}

interface AxeResultLite {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

export async function checkAccessibility(page: Page): Promise<A11yReport> {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string, level: Check['level'] = 'error'): void => {
    checks.push({ id, ok, level, detail });
  };

  // 1. axe-core (evaluated through CDP, so the page's CSP does not apply to it).
  const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  await page.evaluate(axeSource);
  const result = await page.evaluate(async (wanted: string[]) => {
    const axe = (
      window as unknown as {
        axe: {
          getRules: () => { ruleId: string }[];
          run: (ctx: unknown, opts: unknown) => Promise<unknown>;
        };
      }
    ).axe;
    const known = new Set(axe.getRules().map((r) => r.ruleId));
    const rules = wanted.filter((r) => known.has(r));
    const res = (await axe.run(document, {
      runOnly: { type: 'rule', values: rules },
      resultTypes: ['violations', 'incomplete'],
    })) as { violations: AxeResultLite[]; passes: AxeResultLite[]; incomplete: AxeResultLite[] };
    const lite = (list: AxeResultLite[]) =>
      list.map((r) => ({
        id: r.id,
        impact: r.impact,
        help: r.help,
        nodes: r.nodes.map((n) => n.target.join(' ')),
      }));
    return {
      violations: lite(res.violations),
      passes: lite(res.passes),
      incomplete: lite(res.incomplete),
    };
  }, LIGHTHOUSE_AXE_RULES);
  // Lighthouse: a rule with no matching node is "not applicable" and does not count.
  const applicable = [...result.passes, ...result.violations];
  const weightOf = (impact: string | null): number => IMPACT_WEIGHT[impact ?? 'serious'] ?? 7;
  const total = applicable.reduce((s, r) => s + weightOf(r.impact), 0);
  const failed = result.violations.reduce((s, r) => s + weightOf(r.impact), 0);
  const estimatedScore = total ? Math.round(((total - failed) / total) * 100) : 100;
  for (const v of result.violations) {
    add(
      `axe ${v.id}`,
      false,
      `${v.impact}: ${v.help} — ${v.nodes.length} node(s), e.g. ${v.nodes[0] ?? '?'}`,
      v.impact === 'critical' || v.impact === 'serious' ? 'error' : 'warn',
    );
  }
  add(
    'axe-violations',
    result.violations.length === 0,
    `${result.violations.length} rule(s) violated of ${applicable.length} applicable`,
  );

  // 2. Design-token contrast.
  const tokens = await page.evaluate(
    (names: string[]) => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]));
    },
    [...new Set(TOKEN_PAIRS.flatMap(([fg, bg]) => [fg, bg]))],
  );
  // var(--x) chains are resolved by the browser only when used; resolve one level here.
  const resolve = (value: string | undefined): string => {
    const ref = /^var\((--[\w-]+)\)$/.exec(value ?? '')?.[1];
    return ref ? (tokens[ref] ?? '') : (value ?? '');
  };
  for (const [fg, bg, min, use] of TOKEN_PAIRS) {
    const a = resolve(tokens[fg]);
    const b = resolve(tokens[bg]);
    const ratio = a && b ? contrast(a, b) : null;
    if (ratio === null) {
      add(
        `contrast ${fg}/${bg}`,
        false,
        `token missing in shipped CSS (${a || '—'} / ${b || '—'})`,
        'warn',
      );
      continue;
    }
    add(`contrast ${fg}/${bg}`, ratio >= min, `${ratio.toFixed(2)}:1 (min ${min}:1) — ${use}`);
  }

  // 3–5. DOM probes.
  const dom = await page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const describe = (el: Element): string =>
      el.tagName.toLowerCase() +
      (el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : '') +
      (el.id ? `#${el.id}` : '');
    const nameOf = (el: Element): { name: string; placeholderOnly: boolean } => {
      const aria = el.getAttribute('aria-label')?.trim();
      if (aria) return { name: aria, placeholderOnly: false };
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const text = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .join(' ')
          .trim();
        if (text) return { name: text, placeholderOnly: false };
      }
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label?.textContent?.trim())
          return { name: label.textContent.trim(), placeholderOnly: false };
      }
      const wrap = el.closest('label');
      if (wrap?.textContent?.trim())
        return { name: wrap.textContent.trim(), placeholderOnly: false };
      const title = el.getAttribute('title')?.trim();
      if (title) return { name: title, placeholderOnly: false };
      const ph = el.getAttribute('placeholder')?.trim();
      return { name: ph ?? '', placeholderOnly: !!ph };
    };
    const controls = [
      ...document.querySelectorAll('input:not([type=hidden]), select, textarea'),
    ].filter(visible);
    const unlabeled: string[] = [];
    const placeholderOnly: string[] = [];
    for (const el of controls) {
      const n = nameOf(el);
      if (!n.name) unlabeled.push(describe(el));
      else if (n.placeholderOnly) placeholderOnly.push(describe(el));
    }
    const interactiveSel =
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [role=menuitem], [role=radio], [tabindex]:not([tabindex="-1"])';
    const small: string[] = [];
    const belowTap: string[] = [];
    let targets = 0;
    for (const el of [...document.querySelectorAll(interactiveSel)].filter(visible)) {
      // Links inside running text are exempt (WCAG 2.5.8 "inline" exception).
      if (el.tagName === 'A' && el.closest('p, li') && !el.closest('nav')) continue;
      let r = el.getBoundingClientRect();
      const label = el.closest('label');
      if (
        (el as HTMLInputElement).type === 'checkbox' ||
        (el as HTMLInputElement).type === 'radio'
      ) {
        if (label) r = label.getBoundingClientRect();
      }
      targets++;
      const size = `${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}`;
      if (r.width < 24 || r.height < 24) small.push(size);
      else if (r.width < 44 || r.height < 44) belowTap.push(size);
    }
    return {
      controls: controls.length,
      unlabeled,
      placeholderOnly,
      mains: document.querySelectorAll('main, [role=main]').length,
      h1: document.querySelectorAll('h1').length,
      nav: document.querySelectorAll('nav, [role=navigation]').length,
      lang: document.documentElement.getAttribute('lang'),
      dir: document.documentElement.getAttribute('dir'),
      skipLink: !!document.querySelector('a[href^="#"]'),
      targets,
      small,
      belowTap,
    };
  });
  add(
    'labels',
    dom.unlabeled.length === 0,
    dom.unlabeled.length
      ? `no accessible name: ${dom.unlabeled.join(', ')}`
      : `${dom.controls} visible form controls, all named`,
  );
  add(
    'labels-not-placeholder-only',
    dom.placeholderOnly.length === 0,
    dom.placeholderOnly.join(', ') || 'none',
    'warn',
  );
  add('landmark-main', dom.mains === 1, `${dom.mains} <main> landmark(s)`);
  add('heading-h1', dom.h1 >= 1, `${dom.h1} <h1>`, 'warn');
  add('landmark-nav', dom.nav >= 1, `${dom.nav} navigation landmark(s)`, 'warn');
  add('html-lang-dir', !!dom.lang && !!dom.dir, `lang="${dom.lang}" dir="${dom.dir}"`);
  add('skip-link', dom.skipLink, dom.skipLink ? 'in-page link present' : 'no skip link', 'warn');
  add(
    'tap-targets-24',
    dom.small.length === 0,
    dom.small.length ? dom.small.join('; ') : `${dom.targets} targets ≥ 24×24`,
  );
  add(
    'tap-targets-44',
    dom.belowTap.length === 0,
    dom.belowTap.length ? dom.belowTap.join('; ') : `${dom.targets} targets ≥ 44×44`,
    'warn',
  );

  return {
    checks,
    axe: {
      estimatedScore,
      applicable: applicable.length,
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? 'unknown',
        nodes: v.nodes.length,
        help: v.help,
        sample: v.nodes[0] ?? '',
      })),
      incomplete: result.incomplete.map((r) => r.id),
    },
  };
}
