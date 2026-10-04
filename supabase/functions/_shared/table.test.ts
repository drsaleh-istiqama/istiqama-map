import { describe, expect, it } from 'vitest';
import { cleanHeader, tableToObjects } from './table.ts';

const ZWSP = String.fromCharCode(0x200b);
const RLM = String.fromCharCode(0x200f);
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);

describe('cleanHeader', () => {
  it('removes invisible characters and normalises white space', () => {
    expect(cleanHeader(`${BOM}name_ar`)).toBe('name_ar');
    expect(cleanHeader(`${RLM}النوع${ZWSP} `)).toBe('النوع');
    expect(cleanHeader(`اسم${NBSP}${NBSP}المشروع   (عربي)`)).toBe('اسم المشروع (عربي)');
    expect(cleanHeader(null)).toBe('');
    expect(cleanHeader(42)).toBe('42');
  });
});

describe('tableToObjects', () => {
  it('uses the first non-empty row as header and keys every data row by it', () => {
    const t = tableToObjects([
      ['', ''],
      ['النوع', 'name_ar', 'capacity'],
      ['مسجد', 'مسجد النور', 150],
      ['school', 'مدرسة الهداية', '120'],
    ]);
    expect(t.headerRow).toBe(2);
    expect(t.headers).toEqual(['النوع', 'name_ar', 'capacity']);
    expect(t.rows).toEqual([
      { النوع: 'مسجد', name_ar: 'مسجد النور', capacity: 150 },
      { النوع: 'school', name_ar: 'مدرسة الهداية', capacity: '120' },
    ]);
    expect(t.sourceRows).toEqual([3, 4]);
  });

  it('leaves out empty cells, trims text and keeps booleans / zero', () => {
    const t = tableToObjects([
      ['a', 'b', 'c', 'd'],
      ['  x  ', '', null, 0],
      [undefined, false, '   ', 'y'],
    ]);
    expect(t.rows).toEqual([
      { a: 'x', d: 0 },
      { b: false, d: 'y' },
    ]);
  });

  it('skips blank rows and reports where the data rows came from', () => {
    const t = tableToObjects(
      [['h'], ['1'], ['', ''], ['2'], [' '], ['3']],
      [1, 2, 3, 4, 5, 6],
    );
    expect(t.rows).toEqual([{ h: '1' }, { h: '2' }, { h: '3' }]);
    expect(t.sourceRows).toEqual([2, 4, 6]);
    expect(t.skippedBlankRows).toBe(2);
  });

  it('uses the given row numbers (spreadsheet rows, CSV lines)', () => {
    const t = tableToObjects([['h'], ['x']], [5, 9]);
    expect(t.headerRow).toBe(5);
    expect(t.sourceRows).toEqual([9]);
  });

  it('ignores columns without a header and reports duplicates (first one wins)', () => {
    const t = tableToObjects([
      ['name', '', 'name', 'type'],
      ['first', 'orphan', 'second', 'mosque'],
    ]);
    expect(t.headers).toEqual(['name', 'type']);
    expect(t.rows).toEqual([{ name: 'first', type: 'mosque' }]);
    expect(t.duplicateHeaders).toEqual(['name']);
    expect(t.unnamedColumns).toBe(1);
  });

  it('handles ragged rows', () => {
    const t = tableToObjects([['a', 'b'], ['1'], ['1', '2', '3']]);
    expect(t.rows).toEqual([{ a: '1' }, { a: '1', b: '2' }]);
    expect(t.unnamedColumns).toBe(1);
  });

  it('drops the apostrophe our own export adds in front of formula-looking text', () => {
    const t = tableToObjects([['phone', 'note', 'name'], [`'+255700000001`, `'=not a formula`, `'quoted'`]]);
    expect(t.rows).toEqual([{ phone: '+255700000001', note: '=not a formula', name: `'quoted'` }]);
  });

  it('never creates dangerous keys', () => {
    const t = tableToObjects([
      ['__proto__', 'constructor', 'prototype', 'ok'],
      ['a', 'b', 'c', 'd'],
    ]);
    expect(t.rows).toEqual([{ ok: 'd' }]);
    expect(Object.getPrototypeOf(t.rows[0])).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });

  it('an empty table or a header without data yields no rows', () => {
    expect(tableToObjects([])).toMatchObject({ headerRow: 0, rows: [] });
    expect(tableToObjects([[''], [null]])).toMatchObject({ headerRow: 0, rows: [] });
    expect(tableToObjects([['a', 'b']])).toMatchObject({ headerRow: 1, headers: ['a', 'b'], rows: [] });
  });
});
