/**
 * `similarity()` must be numerically compatible with pg_trgm. The table below was computed by
 * the database (`extensions.similarity(private.norm(a), private.norm(b))`, PostgreSQL 17,
 * UTF-8, LC_CTYPE en-US) and is re-checked live by tests/integration/registry.live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { norm } from './normalize';
import { similarity, trigramSetSimilarity, trigrams } from './similarity';

/** [a, b, pg_trgm similarity of the normalised strings] */
const PG_TABLE: Array<[string, string, number]> = [
  ['مسجد النور', 'مسجد النور', 1],
  ['مسجد النور', 'مسجد النور الكبير', 0.6875],
  ['مسجد النور', 'مسجد نور', 0.538462],
  ['مسجد النور', 'مدرسة النور', 0.4375],
  ['مسجد الهدى', 'مسجد الهدي', 1],
  ['مَسْجِدُ النُّور', 'مسجد النور', 1],
  ['مدرسة القرآن الكريم', 'مدرسه القران الكريم', 1],
  ['أحمد إبراهيم', 'احمد ابراهيم', 1],
  ['محمد بن سالم الحارثي', 'محمد بن سالم الحارثى', 1],
  ['محمد بن سالم الحارثي', 'محمد سالم الحارثي', 0.857143],
  ['محمد بن سالم الحارثي', 'محمد بن سليم الحارثي', 0.68],
  ['محمد بن سالم الحارثي', 'سالم بن محمد الحارثي', 1],
  ['محمد', 'محمد', 1],
  ['محمد', 'محمود', 0.375],
  ['محمد', 'أحمد', 0.25],
  ['عبدالله', 'عبد الله', 0.545455],
  ['عبد الرحمن بن علي', 'عبدالرحمن بن علي', 0.736842],
  ['فاطمة', 'فاطمه الزهراء', 0.428571],
  ['مؤسسة الخير', 'مؤسسه الخير', 1],
  ['مسجد', 'مساجد', 0.375],
  ['Masjid Noor', 'Masjid Noor', 1],
  ['Masjid Noor', 'Masjid Nur', 0.533333],
  ['Masjid Noor', 'Msikiti wa Noor', 0.272727],
  ['Msikiti wa Ijumaa', 'Msikiti wa Ijumaa Wete', 0.818182],
  ['Mohamed Salim Ali', 'Mohammed Salim Ali', 0.842105],
  ['Mohamed Salim Ali', 'Salim Ali Mohamed', 1],
  ['Mohamed', 'Mohammed', 0.7],
  ['Ali', 'Ally', 0.285714],
  ["Shule ya Qur'an", 'Shule ya Quran', 0.722222],
  ['École São João', 'ecole sao joao', 1],
  ['ÉCOLE', 'ecole', 1],
  ['TZ-PN-000123', 'TZ-PN-000124', 0.733333],
  ['TZ-PN-000123', 'tz pn 000123', 1],
  ['Chake Chake', 'Chake-Chake', 1],
  ['Wete', 'Wete Town', 0.5],
  ['a', 'a', 1],
  ['a', 'b', 0],
  ['ab', 'abc', 0.4],
  ['abc', 'abcd', 0.5],
  ['', '', 0],
  ['', 'abc', 0],
  ['!!!', '???', 0],
  ['مسجد 12', 'مسجد 21', 0.454545],
  ['مسجد ١٢', 'مسجد ١٢', 1],
  ['مسجد النور Masjid Noor', 'مسجد النور', 0.478261],
  ['مسجد النور Masjid Noor', 'Masjid Noor', 0.521739],
  ['Masjid_Noor', 'Masjid Noor', 1],
  ['Noor  Masjid', 'Masjid   Noor', 1],
  ['النور', 'نور', 0.25],
  ['بيمبا الشمالية', 'شمال بيمبا', 0.444444],
  ['مسجد عمر بن الخطاب', 'مسجد عمر بن عبد العزيز', 0.518519],
  ['مسجد عثمان بن عفان', 'مسجد عثمان بن عفّان رضي الله عنه', 0.586207],
  ['Masjid Al-Istiqama', 'Masjid Al Istiqamah', 0.857143],
  ['Masjid Istiqama Wete', 'Masjid Istiqama Chake', 0.592593],
  ["Kijiji cha Ng'ambo", 'Kijiji cha Ngambo', 0.75],
  ['x1', 'x2', 0.2],
  ['ی ک', 'ي ك', 0],
  ['مسجد الرَّحمٰن', 'مسجد الرحمن', 1],
  ['Ünïcödé Nàmé', 'unicode name', 1],
  ['straße', 'strasse', 1],
];

describe('similarity — compatible with pg_trgm', () => {
  it.each(PG_TABLE)('similarity(norm(%j), norm(%j)) = %d', (a, b, expected) => {
    expect(similarity(norm(a), norm(b))).toBeCloseTo(expected, 5);
  });

  it('is symmetric', () => {
    for (const [a, b] of PG_TABLE) {
      expect(similarity(norm(a), norm(b))).toBe(similarity(norm(b), norm(a)));
    }
  });

  it('stays inside 0..1', () => {
    for (const [a, b] of PG_TABLE) {
      const s = similarity(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('the thresholds of the brief: 0.6 separates "same name with a typo" from "another name"', () => {
    expect(similarity(norm('محمد بن سالم الحارثي'), norm('محمد بن سليم الحارثي'))).toBeGreaterThanOrEqual(0.6);
    expect(similarity(norm('مسجد النور'), norm('مسجد النور الكبير'))).toBeGreaterThanOrEqual(0.6);
    expect(similarity(norm('مسجد النور'), norm('مدرسة النور'))).toBeLessThan(0.6);
    expect(similarity(norm('Mohamed'), norm('Mohammed'))).toBeGreaterThanOrEqual(0.6);
    expect(similarity(norm('Ali'), norm('Ally'))).toBeLessThan(0.6);
  });
});

describe('trigrams', () => {
  it('pads every word with two blanks in front and one behind, as show_trgm() does', () => {
    expect([...trigrams('cat')].sort()).toEqual(['  c', ' ca', 'at ', 'cat'].sort());
    expect([...trigrams('a')].sort()).toEqual(['  a', ' a '].sort());
  });

  it('splits on everything that is not a letter or digit and lower-cases', () => {
    expect(trigrams('AB-cd')).toEqual(trigrams('ab cd'));
    expect(trigrams('ab_cd')).toEqual(trigrams('ab cd'));
    expect(trigrams("ng'ambo")).toEqual(trigrams('ng ambo'));
  });

  it('keeps distinct trigrams only (a repeated word adds nothing)', () => {
    expect(trigrams('chake chake')).toEqual(trigrams('chake'));
  });

  it('counts characters, not UTF-16 units', () => {
    const word = String.fromCodePoint(0x1d400, 0x1d401); // two letters outside the BMP
    expect(trigrams(word).size).toBe(3);
  });

  it('gives no trigram for text without letters or digits', () => {
    expect(trigrams('').size).toBe(0);
    expect(trigrams(' - !').size).toBe(0);
  });
});

describe('trigramSetSimilarity', () => {
  it('is |A ∩ B| / |A ∪ B|, and 0 when a set is empty', () => {
    const a = new Set(['x', 'y', 'z']);
    const b = new Set(['y', 'z', 'w', 'v']);
    expect(trigramSetSimilarity(a, b)).toBeCloseTo(2 / 5, 10);
    expect(trigramSetSimilarity(a, new Set())).toBe(0);
    expect(trigramSetSimilarity(new Set(), new Set())).toBe(0);
    expect(trigramSetSimilarity(a, a)).toBe(1);
  });
});
