/**
 * `norm()` must give exactly what SQL `private.norm()` gives. The shared fixture
 * `supabase/tests/fixtures/normalize.json` was produced by the database function itself and
 * also generates the pgTAP test, so both implementations are pinned to the same 60 cases.
 * A live comparison over whole Unicode blocks is in tests/integration/registry.live.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { norm, normOrEmpty } from './normalize';

interface Case {
  name: string;
  input: string;
  expected: string;
}

const fixturePath = path.resolve(__dirname, '../../../../supabase/tests/fixtures/normalize.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Case[];

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

describe('norm — shared fixture with private.norm()', () => {
  it('has the documented number of cases', () => {
    expect(fixture.length).toBeGreaterThanOrEqual(60);
  });

  for (const c of fixture) {
    it(c.name, () => {
      expect(norm(c.input)).toBe(c.expected);
    });
  }

  it('is idempotent on every fixture case', () => {
    for (const c of fixture) expect(norm(norm(c.input))).toBe(norm(c.input));
  });
});

describe('norm — the steps of schema.md 2.1', () => {
  it('examples of the contract', () => {
    expect(norm('  مَسْجِدُ   النُّور ')).toBe('مسجد النور');
    expect(norm('أحمد إبراهيم آل موسى فاطمة')).toBe('احمد ابراهيم ال موسي فاطمه');
    expect(norm('مؤسسة الخير')).toBe('مؤسسه الخير');
    expect(norm('  Msikiti   wa  ÉCOLE São  Ñandú ')).toBe('msikiti wa ecole sao nandu');
  });

  it('empty and blank input', () => {
    expect(norm('')).toBe('');
    expect(norm('   ')).toBe('');
    expect(norm(cp(0x00a0, 0x2003, 0x3000))).toBe('');
  });

  it('step 0: NFC comes first (waw + combining hamza is kept as one letter, alef + hamza folds)', () => {
    expect(norm(cp(0x0648, 0x0654))).toBe(cp(0x0624));
    expect(norm(cp(0x0627, 0x0654))).toBe(cp(0x0627));
    expect(norm(cp(0x0627, 0x0653))).toBe(cp(0x0627)); // alef + madda above = alef with madda
  });

  it('step 1: tashkeel, superscript alef, Quranic marks, tatweel and invisible characters go', () => {
    const beh = cp(0x0628);
    for (const mark of [0x064b, 0x0652, 0x065f, 0x0670, 0x06d6, 0x06ed, 0x0640]) {
      expect(norm(beh + cp(mark) + beh)).toBe(beh + beh);
    }
    for (const invisible of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff]) {
      expect(norm('ab' + cp(invisible) + 'cd')).toBe('abcd');
    }
    // neighbours of the ranges stay
    expect(norm(beh + cp(0x064a) + beh)).toBe(beh + cp(0x064a) + beh);
    expect(norm(beh + cp(0x06d5) + beh)).toBe(beh + cp(0x06d5) + beh);
  });

  it('step 2: Latin diacritics are stripped, Arabic letters with hamza are not decomposed', () => {
    expect(norm('Ünïcödé Nàmé Çà Ž')).toBe('unicode name ca z');
    expect(norm('e' + cp(0x0301))).toBe('e'); // composed by NFC, then unaccented
    expect(norm('q' + cp(0x0301))).toBe('q'); // stray combining mark
    expect(norm(cp(0x0624))).toBe(cp(0x0624));
    expect(norm(cp(0x0626))).toBe(cp(0x0626));
    expect(norm(cp(0x0621))).toBe(cp(0x0621));
  });

  it('step 2: PostgreSQL 17 unaccent rules for letters without a decomposition', () => {
    expect(norm('Straße')).toBe('strasse');
    expect(norm('Æther œuvre')).toBe('aether oeuvre');
    expect(norm('Øre ød')).toBe('ore od');
    expect(norm('Łódź')).toBe('lodz');
    expect(norm(cp(0x0131))).toBe('i'); // dotless i
    expect(norm('Ng' + cp(0x2019) + 'ambo')).toBe("ng'ambo"); // typographic apostrophe
    expect(norm(cp(0x00ab) + 'x' + cp(0x00bb))).toBe('<<x>>');
  });

  it('step 3: lower case', () => {
    expect(norm('MASJID Al-NOOR')).toBe('masjid al-noor');
  });

  it('step 4: only alef forms, alef maksura and teh marbuta are folded', () => {
    expect(norm(cp(0x0623, 0x0625, 0x0622))).toBe(cp(0x0627, 0x0627, 0x0627));
    expect(norm(cp(0x0649))).toBe(cp(0x064a));
    expect(norm(cp(0x0629))).toBe(cp(0x0647));
    // Farsi yeh / keheh are different letters and stay
    expect(norm(cp(0x06cc, 0x06a9))).toBe(cp(0x06cc, 0x06a9));
    // Arabic-Indic digits and punctuation stay
    expect(norm(cp(0x0661, 0x0662, 0x060c, 0x061f))).toBe(cp(0x0661, 0x0662, 0x060c, 0x061f));
  });

  it('step 5: every kind of white space collapses to one blank, both ends are trimmed', () => {
    const spaces = [0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
    for (const s of spaces) {
      expect(norm('a' + cp(s) + cp(s) + 'b')).toBe('a b');
      expect(norm(cp(s) + 'a' + cp(s))).toBe('a');
    }
    // zero width space is removed, not turned into a blank
    expect(norm('a' + cp(0x200b) + 'b')).toBe('ab');
  });

  it('no NFKC: ligatures and presentation forms stay', () => {
    expect(norm(cp(0xfefb))).toBe(cp(0xfefb));
  });

  it('characters outside the BMP survive', () => {
    const emoji = cp(0x1f54c);
    expect(norm('Masjid ' + emoji)).toBe('masjid ' + emoji);
  });

  it('the ASCII fast path gives the same result as the full path', () => {
    const samples = ['  Hello   World  ', 'TZ-PN-000123', "Qur'an\tSchool\r\nNo. 2", 'x'];
    for (const s of samples) {
      // a trailing Arabic letter forces the full path; remove it again for the comparison
      const full = norm(s + ' ' + cp(0x0628));
      expect(full.slice(0, full.length - 2)).toBe(norm(s));
    }
  });
});

describe('normOrEmpty', () => {
  it('maps null and undefined to the empty string', () => {
    expect(normOrEmpty(null)).toBe('');
    expect(normOrEmpty(undefined)).toBe('');
    expect(normOrEmpty(' A ')).toBe('a');
  });
});
