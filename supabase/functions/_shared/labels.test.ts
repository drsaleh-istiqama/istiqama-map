import { describe, expect, it } from 'vitest';
import {
  exportCell,
  exportRow,
  headerRow,
  translateCode,
  type EnumDictionary,
  type ExportColumn,
} from './labels.ts';

const ENUMS_AR: EnumDictionary = {
  project_type: { mosque: 'مسجد', school: 'مدرسة قرآن', combined: 'مسجد ومدرسة' },
  project_status: {
    active: 'يعمل',
    maintenance: 'يحتاج صيانة',
    building: 'قيد الإنشاء',
    inactive: 'متوقف',
  },
  boolean: { true: 'نعم', false: 'لا' },
};
const ENUMS_SW: EnumDictionary = {
  project_type: { mosque: 'Msikiti' },
  project_status: { active: 'Inafanya kazi' },
  boolean: { true: 'Ndiyo', false: 'Hapana' },
};

const COLUMNS: ExportColumn[] = [
  { key: 'code', header: 'رمز المشروع', kind: 'text' },
  { key: 'type', header: 'النوع', kind: 'enum', enum: 'project_type' },
  { key: 'status', header: 'الحالة', kind: 'enum', enum: 'project_status' },
  { key: 'land_expandable', header: 'قابلية التوسع', kind: 'boolean', enum: 'boolean' },
  { key: 'capacity', header: 'السعة', kind: 'integer' },
  { key: 'lat', header: 'خط العرض', kind: 'number' },
  { key: 'livelihoods', header: 'سبل المعيشة', kind: 'list' },
  { key: 'build_date', header: 'تاريخ البناء', kind: 'date' },
];

describe('translateCode', () => {
  it('translates enum codes into the job language', () => {
    expect(translateCode(ENUMS_AR, 'project_type', 'mosque')).toBe('مسجد');
    expect(translateCode(ENUMS_AR, 'project_status', 'active')).toBe('يعمل');
    expect(translateCode(ENUMS_SW, 'project_type', 'mosque')).toBe('Msikiti');
    expect(translateCode(ENUMS_SW, 'project_status', 'active')).toBe('Inafanya kazi');
  });

  it('translates booleans through String(value)', () => {
    expect(translateCode(ENUMS_AR, 'boolean', true)).toBe('نعم');
    expect(translateCode(ENUMS_AR, 'boolean', false)).toBe('لا');
    expect(translateCode(ENUMS_SW, 'boolean', true)).toBe('Ndiyo');
  });

  it('falls back to the code when the dictionary has no label', () => {
    expect(translateCode(ENUMS_SW, 'project_type', 'school')).toBe('school');
    expect(translateCode(ENUMS_AR, 'unknown_enum', 'x')).toBe('x');
    expect(translateCode(ENUMS_AR, undefined, 'x')).toBe('x');
  });

  it('is not fooled by keys of Object.prototype', () => {
    expect(translateCode(ENUMS_AR, 'project_type', 'constructor')).toBe('constructor');
    expect(translateCode(ENUMS_AR, 'project_type', 'toString')).toBe('toString');
    expect(translateCode(ENUMS_AR, '__proto__', 'x')).toBe('x');
  });
});

describe('exportCell / exportRow', () => {
  it('builds a row in column order with translated values', () => {
    const row = {
      code: 'TZ-PN-000001',
      type: 'mosque',
      status: 'active',
      land_expandable: true,
      capacity: 150,
      lat: -5.05,
      livelihoods: 'الزراعة | الصيد',
      build_date: '2015-06-20',
      extra_key_not_in_columns: 'ignored',
    };
    expect(exportRow(COLUMNS, row, ENUMS_AR)).toEqual([
      'TZ-PN-000001',
      'مسجد',
      'يعمل',
      'نعم',
      150,
      -5.05,
      'الزراعة | الصيد',
      '2015-06-20',
    ]);
    expect(headerRow(COLUMNS)).toEqual([
      'رمز المشروع',
      'النوع',
      'الحالة',
      'قابلية التوسع',
      'السعة',
      'خط العرض',
      'سبل المعيشة',
      'تاريخ البناء',
    ]);
  });

  it('null, undefined and missing keys are empty cells', () => {
    expect(exportRow(COLUMNS, { code: null, type: undefined }, ENUMS_AR)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('false is a value, not an empty cell', () => {
    expect(exportCell(COLUMNS[3]!, false, ENUMS_AR)).toBe('لا');
  });

  it('keeps numbers numeric and converts numeric text of numeric columns', () => {
    expect(exportCell(COLUMNS[4]!, 0, ENUMS_AR)).toBe(0);
    expect(exportCell(COLUMNS[5]!, '39.752', ENUMS_AR)).toBe(39.752);
    expect(exportCell(COLUMNS[4]!, '12345678901234567890', ENUMS_AR)).toBe('12345678901234567890');
    expect(exportCell(COLUMNS[4]!, Number.NaN, ENUMS_AR)).toBeNull();
    expect(exportCell(COLUMNS[0]!, 42, ENUMS_AR)).toBe('42'); // a number in a text column is text
  });

  it('joins arrays and serialises objects for text-like columns', () => {
    expect(exportCell(COLUMNS[6]!, ['a', 'b'], ENUMS_AR, ' | ')).toBe('a | b');
    expect(exportCell(COLUMNS[0]!, { a: 1 }, ENUMS_AR)).toBe('{"a":1}');
  });
});
