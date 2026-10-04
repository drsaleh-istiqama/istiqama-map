import { describe, expect, it } from 'vitest';
import {
  BOM,
  CsvEncoder,
  csvField,
  csvLine,
  decodeText,
  detectDelimiter,
  guardFormula,
  looksLikeFormula,
  parseCsv,
  toCsv,
  unguardFormula,
} from './csv.ts';

const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

describe('formula-injection guard', () => {
  it('prefixes text that starts with = + - @, a tab or a carriage return', () => {
    for (const text of [
      '=1+1',
      '+255700000001',
      '-5',
      '@SUM(A1)',
      `${TAB}=1`,
      `${CR}=1`,
      `${TAB}text`,
    ]) {
      expect(looksLikeFormula(text), text).toBe(true);
      expect(guardFormula(text)).toBe(`'${text}`);
    }
  });

  it('also guards when white space precedes the trigger (v2 behaviour)', () => {
    expect(guardFormula('  =HYPERLINK("http://x","y")')).toBe(`'  =HYPERLINK("http://x","y")`);
    expect(guardFormula(`${LF}=cmd|' /C calc'!A0`)).toBe(`'${LF}=cmd|' /C calc'!A0`);
  });

  it('guards the full-width forms of the triggers', () => {
    const fullWidthEquals = String.fromCharCode(0xff1d);
    expect(guardFormula(`${fullWidthEquals}1+1`)).toBe(`'${fullWidthEquals}1+1`);
  });

  it('leaves ordinary text alone, Arabic included', () => {
    for (const text of [
      'مسجد النور',
      'Masjid An-Nur',
      'a=b',
      '5-3',
      'x@example.org',
      '',
      ' مسجد',
    ]) {
      expect(guardFormula(text)).toBe(text);
    }
  });

  it('guards Arabic text that starts with a trigger', () => {
    expect(guardFormula('=مسجد')).toBe(`'=مسجد`);
    expect(guardFormula('-ملاحظة')).toBe(`'-ملاحظة`);
  });

  it('unguard removes only the apostrophe the guard added', () => {
    expect(unguardFormula(`'=1+1`)).toBe('=1+1');
    expect(unguardFormula(`'+255700000001`)).toBe('+255700000001');
    expect(unguardFormula(`'quoted'`)).toBe(`'quoted'`);
    expect(unguardFormula(`'مسجد`)).toBe(`'مسجد`);
    expect(unguardFormula('plain')).toBe('plain');
  });
});

describe('csvField / csvLine / toCsv', () => {
  it('writes null and undefined as empty cells', () => {
    expect(csvLine([null, undefined, 'a'])).toBe(`,,a${CRLF}`);
  });

  it('never guards numbers: a negative latitude stays a number', () => {
    expect(csvField(-5.05)).toBe('-5.05');
    expect(csvField(0)).toBe('0');
    expect(csvField(Number.NaN)).toBe('');
    expect(csvField('-5.05')).toBe(`'-5.05`); // the same characters as TEXT are guarded
  });

  it('quotes per RFC 4180: delimiter, quote, CR, LF', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(`line1${LF}line2`)).toBe(`"line1${LF}line2"`);
    expect(csvField(`a${CR}b`)).toBe(`"a${CR}b"`);
    expect(csvField('plain text')).toBe('plain text');
  });

  it('guards first, then quotes', () => {
    expect(csvField('=A1,B1')).toBe(`"'=A1,B1"`);
    expect(csvField(`=1${LF}2`)).toBe(`"'=1${LF}2"`);
  });

  it('writes Arabic text unchanged and Arabic list cells quoted only when needed', () => {
    expect(csvField('مسجد ومدرسة')).toBe('مسجد ومدرسة');
    expect(csvField('الزراعة | الصيد، التجارة')).toBe('الزراعة | الصيد، التجارة');
    expect(csvField('راشد سيف (إمام), علي (معلم)')).toBe('"راشد سيف (إمام), علي (معلم)"');
  });

  it('toCsv: BOM first, CRLF after every record', () => {
    const csv = toCsv([
      ['النوع', 'الحالة'],
      ['مسجد', 'يعمل'],
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(`${BOM}النوع,الحالة${CRLF}مسجد,يعمل${CRLF}`);
  });

  it('CsvEncoder emits the UTF-8 BOM exactly once', () => {
    const enc = new CsvEncoder();
    const first = enc.encode([['a', 'b']]);
    const second = enc.encode([['c', 'd']]);
    expect([...first.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(second)).toBe(`c,d${CRLF}`);
    expect(second[0]).not.toBe(0xef);
  });
});

describe('parseCsv', () => {
  it('parses a simple file with a BOM and CRLF line ends', () => {
    const { rows, delimiter, lines } = parseCsv(`${BOM}name,type${CRLF}مسجد النور,mosque${CRLF}`);
    expect(delimiter).toBe(',');
    expect(rows).toEqual([
      ['name', 'type'],
      ['مسجد النور', 'mosque'],
    ]);
    expect(lines).toEqual([1, 2]);
  });

  it('handles quoted fields with delimiters, doubled quotes and line breaks', () => {
    const text = `a,b,c${LF}"x, y","say ""hi""","line1${CRLF}line2"${LF}last,,`;
    const { rows, lines } = parseCsv(text);
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', `line1${CRLF}line2`],
      ['last', '', ''],
    ]);
    expect(lines).toEqual([1, 2, 4]); // the quoted line break advanced the line counter
  });

  it('accepts LF, CRLF and bare CR line ends, with or without a final line break', () => {
    expect(parseCsv(`a,b${LF}1,2`).rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv(`a,b${CR}1,2${CR}`).rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv(`a,b${CRLF}1,2${CRLF}`).rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('skips completely empty lines but keeps rows of empty cells', () => {
    const { rows, lines } = parseCsv(`a,b${LF}${LF}1,2${LF},${LF}${LF}`);
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['', ''],
    ]);
    expect(lines).toEqual([1, 3, 4]);
  });

  it('detects semicolon and tab delimiters and honours "sep="', () => {
    expect(parseCsv(`name;lat${LF}مسجد;-5,05`).rows).toEqual([
      ['name', 'lat'],
      ['مسجد', '-5,05'],
    ]);
    expect(parseCsv(`name${TAB}lat${LF}x${TAB}1`).delimiter).toBe(TAB);
    const sep = parseCsv(`sep=;${LF}a;b${LF}1;2`);
    expect(sep.delimiter).toBe(';');
    expect(sep.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(sep.lines).toEqual([2, 3]);
    expect(detectDelimiter(`"a;b",c,d${LF}`)).toBe(','); // a delimiter inside quotes does not count
  });

  it('treats a quote in the middle of an unquoted field as a literal', () => {
    expect(parseCsv(`5" pipe,x${LF}`).rows).toEqual([['5" pipe', 'x']]);
  });

  it('keeps an empty quoted last field', () => {
    expect(parseCsv('a,""').rows).toEqual([['a', '']]);
    expect(parseCsv('""').rows).toEqual([]); // a single empty cell is an empty line
  });

  it('never evaluates anything: formula-looking cells are plain text', () => {
    expect(parseCsv(`=1+1,"=HYPERLINK(""http://x"")"${LF}`).rows).toEqual([
      ['=1+1', '=HYPERLINK("http://x")'],
    ]);
  });

  it('round-trips what toCsv writes (Arabic, quotes, line breaks, guard)', () => {
    const original = [
      ['الاسم', 'ملاحظة', 'العدد'],
      ['مسجد "النور"', `سطر أول${LF}سطر ثانٍ, مع فاصلة`, 12],
      ['=خطر', null, -3.5],
    ];
    const parsed = parseCsv(toCsv(original)).rows;
    expect(parsed).toEqual([
      ['الاسم', 'ملاحظة', 'العدد'],
      ['مسجد "النور"', `سطر أول${LF}سطر ثانٍ, مع فاصلة`, '12'],
      [`'=خطر`, '', '-3.5'],
    ]);
  });
});

describe('decodeText', () => {
  it('strips the UTF-8 BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('مسجد')]);
    expect(decodeText(bytes)).toEqual({ text: 'مسجد', encoding: 'utf-8' });
  });

  it('decodes UTF-16 with a BOM (Excel "Unicode text")', () => {
    const text = 'نوع,type';
    const le = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
      le[2 + i * 2] = text.charCodeAt(i) & 0xff;
      le[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    expect(decodeText(le)).toEqual({ text, encoding: 'utf-16le' });
  });

  it('falls back to windows-1256 when the bytes are not UTF-8', () => {
    // "مسجد" in windows-1256
    const bytes = new Uint8Array([0xe3, 0xd3, 0xcc, 0xcf]);
    expect(decodeText(bytes)).toEqual({ text: 'مسجد', encoding: 'windows-1256' });
  });

  it('plain ASCII is UTF-8', () => {
    expect(decodeText(new TextEncoder().encode('a,b')).encoding).toBe('utf-8');
  });
});
