/**
 * Responses captured from the running stack (import function + import_preview +
 * import_template as collector2.pemba, 2026-10-04), trimmed. Test data only.
 */

export const BATCH_ID = '01a107d6-f3e0-7cde-ad93-c187820e90ca';
export const DUP_TARGET = '4e57a255-1287-3635-bf4f-ddc778d4541d';

export const LIVE_UPLOAD = {
  state: 'validated',
  counts: {
    skip: 1,
    total: 3,
    valid: 1,
    create: 1,
    update: 0,
    invalid: 1,
    skipped: 0,
    reverted: 0,
    duplicate: 1,
    with_warnings: 1,
    applied_created: 0,
    applied_updated: 0,
  },
  batch_id: BATCH_ID,
  file_name: 'probe.csv',
  row_count: 3,
  source_kind: 'csv',
  committed_at: null,
  first_errors: [
    {
      errors: [
        {
          code: 'invalid_value',
          field: 'type',
          message: '"bogus" is not an allowed value for type',
        },
      ],
      row_no: 2,
    },
  ],
  rolled_back_at: null,
  ignored_columns: ['ملاحظات'],
  file: {
    kind: 'csv',
    headers: ['name_ar', 'type'],
    header_row: 1,
    rows: 3,
    skipped_blank_rows: 0,
    encoding: 'utf-8',
    delimiter: ',',
    warnings: [],
  },
};

export const LIVE_ROWS = [
  {
    raw: { name_ar: 'مسجد اختبار الاستيراد', type: 'mosque' },
    state: 'valid',
    action: 'create',
    errors: [],
    parsed: {
      project: { lat: -5.06, lon: 39.72, type: 'mosque', name_ar: 'مسجد اختبار الاستيراد' },
    },
    row_no: 1,
    warnings: [],
    target_id: null,
    external_id: null,
    duplicate_of: null,
  },
  {
    raw: { lat: 'abc', type: 'bogus' },
    state: 'invalid',
    action: null,
    errors: [
      { code: 'invalid_value', field: 'type', message: '"bogus" is not an allowed value for type' },
      { code: 'invalid_number', field: 'lat', message: '"abc" is not a number' },
      { code: 'required', field: 'name_ar', message: 'name_ar is required' },
    ],
    parsed: { project: { status: 'active' } },
    row_no: 2,
    warnings: [],
    target_id: null,
    external_id: null,
    duplicate_of: null,
  },
  {
    raw: { name_ar: 'مسجد النور', type: 'mosque' },
    state: 'duplicate',
    action: 'skip',
    errors: [],
    parsed: { project: { type: 'mosque', name_ar: 'مسجد النور' } },
    row_no: 3,
    warnings: [
      {
        code: 'possible_duplicate',
        field: null,
        message: 'a similar project already exists',
        candidates: [
          {
            id: DUP_TARGET,
            code: 'TZ-PN-000001',
            type: 'mosque',
            reason: 'both',
            status: 'active',
            name_ar: 'مسجد النور',
            distance_m: 0,
            name_latin: 'Masjid An-Nur',
            similarity: 1,
            record_state: 'approved',
          },
        ],
      },
    ],
    target_id: null,
    external_id: null,
    duplicate_of: DUP_TARGET,
  },
];

export const LIVE_TEMPLATE = {
  dir: 'rtl',
  lang: 'ar',
  version: 1,
  max_rows: 5000,
  list_separator: '|',
  date_format: 'YYYY-MM-DD',
  merge_key: 'external_id',
  columns: [
    {
      key: 'external_id',
      kind: 'text',
      header: 'المعرّف الخارجي',
      example: 'IST-TZ-0001',
      headers: { ar: 'المعرّف الخارجي', en: 'External ID', sw: 'Kitambulisho cha nje' },
      required: false,
    },
    {
      key: 'name_ar',
      kind: 'text',
      header: 'اسم المشروع (عربي)',
      example: 'مسجد النور',
      headers: { ar: 'اسم المشروع (عربي)', en: 'Project name (Arabic)' },
      required: true,
    },
    {
      key: 'type',
      kind: 'enum',
      header: 'النوع',
      allowed: [
        { code: 'mosque', label: 'مسجد' },
        { code: 'school', label: 'مدرسة قرآن' },
      ],
      example: 'mosque',
      headers: { ar: 'النوع', en: 'Type' },
      required: true,
    },
    {
      key: 'capacity',
      max: 10000000,
      min: 0,
      kind: 'integer',
      header: 'السعة',
      example: '250',
      headers: { ar: 'السعة', en: 'Capacity' },
      required: false,
    },
    {
      key: 'lat',
      max: 90,
      min: -90,
      kind: 'number',
      header: 'خط العرض',
      example: '-5.0712',
      headers: { ar: 'خط العرض', en: 'Latitude' },
      required: true,
    },
  ],
};

/** The English template has English headers (what the page shows in English). */
export const LIVE_TEMPLATE_EN = {
  ...LIVE_TEMPLATE,
  dir: 'ltr',
  lang: 'en',
  columns: LIVE_TEMPLATE.columns.map((c) => ({ ...c, header: c.headers.en ?? c.key })),
};
