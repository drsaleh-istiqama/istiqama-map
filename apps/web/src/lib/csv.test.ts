/**
 * CSV writer: UTF-8 BOM, RFC 4180 quoting, formula-injection guard — the guarantees of v2's
 * `projectsToCsv` (reference/v2/src/domain.js; tests in reference/v2/tests/domain.test.js).
 */
import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell, toCsv } from './csv';

const lines = (csv: string): string[] => csv.slice(1).split('\r\n');

describe('toCsv', () => {
  it('starts with the UTF-8 byte-order mark (U+FEFF) exactly once', () => {
    const csv = toCsv([['a'], ['b']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(CSV_BOM).toBe(String.fromCharCode(0xfeff));
    expect(csv.charCodeAt(1)).toBe('a'.charCodeAt(0));
    expect(toCsv([]).length).toBe(1);
  });

  it('joins fields with commas and rows with CRLF, no trailing line break', () => {
    expect(
      toCsv([
        ['الرقم', 'اسم المشروع'],
        ['1', 'مسجد النور'],
      ]),
    ).toBe(CSV_BOM + 'الرقم,اسم المشروع\r\n1,مسجد النور');
  });

  it('quotes fields with commas, quotes or line breaks and doubles inner quotes (RFC 4180)', () => {
    const csv = toCsv([['مسجد "الرحمة", الكبير', 'سطر\nثان', 'cr\rhere', 'plain']]);
    expect(lines(csv)).toEqual(['"مسجد ""الرحمة"", الكبير","سطر\nثان","cr\rhere",plain']);
  });

  it('neutralises spreadsheet formulas (= + - @, also after white space, tab / CR at the start)', () => {
    expect(csvCell('=HYPERLINK("https://evil.invalid")')).toBe(
      '"\'=HYPERLINK(""https://evil.invalid"")"',
    );
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('  =1+1')).toBe("'  =1+1");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell('\r=1')).toBe('"\'\r=1"');
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('mail@example.org')).toBe('mail@example.org');
  });

  it('keeps real numbers numeric (a negative latitude is not a formula)', () => {
    expect(toCsv([[-5.05, 39.7, 0, 350]])).toBe(CSV_BOM + '-5.05,39.7,0,350');
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(Infinity)).toBe('');
    expect(csvCell(10n)).toBe('10');
  });

  it('writes empty cells for null / undefined, true / false for booleans, ISO for dates', () => {
    expect(
      toCsv([[null, undefined, true, false, new Date('2026-10-04T08:00:00Z'), new Date('x')]]),
    ).toBe(CSV_BOM + ',,true,false,2026-10-04T08:00:00.000Z,');
  });

  it('multi-choice answers stay readable in one cell (v2 behaviour), guarded as text', () => {
    expect(csvCell(['نقص الكادر', 'ضعف التمويل'])).toBe('نقص الكادر | ضعف التمويل');
    expect(csvCell(['=evil', 'ok'])).toBe("'=evil | ok");
  });

  it('objects are written as JSON (quoted when needed)', () => {
    expect(csvCell({ a: 1, b: 'x' })).toBe('"{""a"":1,""b"":""x""}"');
  });
});
