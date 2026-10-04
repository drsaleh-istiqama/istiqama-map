/**
 * Test fixtures of the migration: v2's own sample projects (reference/v2/src/app.js
 * `SAMPLE_PROJECTS`, verbatim), the v2 quick options (quick-options.js) as `option_values`
 * rows with the codes of docs/contracts/reference-data.md §3, and a minimal geography.
 * Not imported by application code.
 */
import type { MapContext, OptionRef } from '../v2map';
import type { V2Data, V2Person, V2Project } from '../v2types';

/** reference/v2/src/app.js SAMPLE_PROJECTS — copied character for character. */
export const SAMPLE_PROJECTS: V2Project[] = [
  {
    id: 'demo-1',
    name: 'مسجد النور',
    type: 'mosque',
    country: 'تنزانيا',
    region: 'بيمبا',
    locality: 'ويتي',
    lat: -5.055,
    lng: 39.729,
    capacity: 350,
    status: 'active',
    manager: 'عبدالله سالم',
    phone: '',
    builder: 'الاستقامة',
    donor: '',
    buildDate: '2019-01-01',
    maintenanceNotes: '',
    createdBy: 'المشرف العام',
  },
  {
    id: 'demo-2',
    name: 'مدرسة الفلاح للقرآن',
    type: 'school',
    country: 'تنزانيا',
    region: 'بيمبا',
    locality: 'ويتي',
    lat: -5.066,
    lng: 39.714,
    capacity: 120,
    status: 'active',
    manager: 'محمد علي',
    phone: '',
    builder: 'الاستقامة',
    donor: 'متبرع كريم',
    buildDate: '2021-01-01',
    maintenanceNotes: '',
    createdBy: 'المشرف العام',
  },
  {
    id: 'demo-3',
    name: 'مسجد ومدرسة الرحمة',
    type: 'combined',
    country: 'تنزانيا',
    region: 'بيمبا',
    locality: 'مكواني',
    lat: -5.357,
    lng: 39.648,
    capacity: 280,
    status: 'active',
    manager: 'خالد حسن',
    phone: '',
    builder: 'الاستقامة',
    donor: '',
    buildDate: '2020-01-01',
    maintenanceNotes: '',
    createdBy: 'المشرف العام',
  },
  {
    id: 'demo-4',
    name: 'مسجد الهدى',
    type: 'mosque',
    country: 'تنزانيا',
    region: 'زنجبار',
    locality: 'مدينة زنجبار',
    lat: -6.165,
    lng: 39.199,
    capacity: 420,
    status: 'maintenance',
    manager: 'سعيد عمر',
    phone: '',
    builder: 'الاستقامة',
    donor: '',
    buildDate: '2017-01-01',
    maintenanceNotes: 'مثال تجريبي: يحتاج إلى فحص وصيانة السقف.',
    createdBy: 'المشرف العام',
  },
  {
    id: 'demo-5',
    name: 'مدرسة البيان',
    type: 'school',
    country: 'تنزانيا',
    region: 'بيمبا',
    locality: 'مكواني',
    lat: -5.37,
    lng: 39.66,
    capacity: 85,
    status: 'building',
    manager: 'يوسف عبدالله',
    phone: '',
    builder: 'الاستقامة',
    donor: 'متبرع كريم',
    buildDate: '2023-01-01',
    maintenanceNotes: '',
    createdBy: 'المشرف العام',
  },
];

/** reference/v2/src/quick-options.js QUICK_OPTIONS, keyed by v3 list key, with v3 codes. */
const QUICK: Record<string, Array<[string, string]>> = {
  daawa_activities: [
    ['quran_memorization_circles', 'حلقات تحفيظ القرآن'],
    ['islamic_lessons', 'دروس شرعية'],
    ['sermons_lectures', 'خطب ومحاضرات'],
    ['daawa_visits', 'زيارات دعوية'],
    ['youth_activities', 'أنشطة شبابية'],
    ['women_activities', 'أنشطة نسائية'],
    ['training_courses', 'دورات تعليمية'],
    ['community_aid', 'مساعدات مجتمعية'],
  ],
  social_features: [
    ['strong_community_cooperation', 'تعاون مجتمعي قوي'],
    ['youth_participation', 'مشاركة شبابية'],
    ['women_participation', 'مشاركة نسائية'],
    ['orphan_care', 'رعاية الأيتام'],
    ['needy_family_support', 'رعاية الأسر المحتاجة'],
    ['community_volunteering', 'تطوع مجتمعي'],
    ['community_councils', 'مجالس أهلية'],
    ['weak_community_participation', 'ضعف المشاركة المجتمعية'],
  ],
  livelihoods: [
    ['agriculture', 'الزراعة'],
    ['fishing', 'الصيد'],
    ['trade', 'التجارة'],
    ['herding', 'الرعي'],
    ['government_jobs', 'الوظائف الحكومية'],
    ['crafts_trades', 'الحرف والمهن'],
    ['daily_labour', 'العمل اليومي'],
    ['tourism', 'السياحة'],
  ],
  religious_issues: [
    ['weak_islamic_education', 'ضعف التعليم الشرعي'],
    ['imam_shortage', 'نقص الأئمة'],
    ['teacher_shortage', 'نقص المعلمين'],
    ['weak_quran_memorization', 'ضعف تحفيظ القرآن'],
    ['low_prayer_attendance', 'ضعف حضور الصلاة'],
    ['wrong_beliefs_practices', 'معتقدات أو ممارسات خاطئة'],
    ['need_youth_programs', 'حاجة لبرامج الشباب'],
    ['need_women_programs', 'حاجة لبرامج النساء'],
  ],
  religious_challenges: [
    ['lack_qualified_staff', 'نقص الكادر المؤهل'],
    ['weak_training', 'ضعف التأهيل'],
    ['few_teaching_materials', 'قلة المواد التعليمية'],
    ['remote_settlements', 'بُعد التجمعات السكانية'],
    ['low_attendance', 'ضعف الحضور'],
    ['multiple_languages', 'تعدد اللغات'],
    ['sectarian_sensitivities', 'حساسيات مذهبية'],
    ['weak_funding', 'ضعف التمويل'],
  ],
  social_challenges: [
    ['poverty', 'الفقر'],
    ['unemployment', 'البطالة'],
    ['school_dropout', 'التسرب الدراسي'],
    ['early_marriage', 'الزواج المبكر'],
    ['drugs', 'المخدرات'],
    ['poor_transport', 'ضعف النقل'],
    ['scattered_population', 'تشتت السكان'],
    ['family_problems', 'مشكلات أسرية'],
  ],
  proposed_activities: [
    ['quran_circles', 'حلقات قرآن'],
    ['teacher_training', 'تدريب المعلمين'],
    ['imam_training', 'تدريب الأئمة'],
    ['public_lectures', 'محاضرات عامة'],
    ['youth_programs', 'برامج الشباب'],
    ['women_programs', 'برامج النساء'],
    ['daawa_caravan', 'قافلة دعوية'],
    ['social_aid', 'مساعدات اجتماعية'],
  ],
};

export const optionId = (list: string, code: string): string => `opt:${list}:${code}`;

export const OPTIONS: OptionRef[] = Object.entries(QUICK).flatMap(([list, items]) => [
  ...items.map(([code, name_ar]) => ({
    id: optionId(list, code),
    list_key: list as OptionRef['list_key'],
    code,
    name_ar,
    name_en: null,
    name_sw: null,
  })),
  {
    id: optionId(list, 'other'),
    list_key: list as OptionRef['list_key'],
    code: 'other',
    name_ar: 'أخرى',
    name_en: 'Other',
    name_sw: 'Nyingine',
  },
]);

export const TZ = 'country-tz';
export const KE = 'country-ke';
export const XX = 'country-xx-no-currency';
export const PN = 'area-tz-pn';
export const PS = 'area-tz-ps';
export const ZW = 'area-tz-zw';
export const PN_WETE = 'area-tz-pn-wete';
export const WETE = 'loc-wete';
export const MKOANI = 'loc-mkoani';
export const BR_PEMBA = 'branch-pemba';
export const BR_ZANZIBAR = 'branch-zanzibar';

export const COUNTRIES: MapContext['countries'] = [
  {
    id: TZ,
    iso2: 'TZ',
    name_ar: 'تنزانيا',
    name_en: 'Tanzania',
    name_sw: 'Tanzania',
    default_currency: 'TZS',
  },
  {
    id: KE,
    iso2: 'KE',
    name_ar: 'كينيا',
    name_en: 'Kenya',
    name_sw: 'Kenya',
    default_currency: 'KES',
  },
  {
    id: XX,
    iso2: 'XX',
    name_ar: 'بلد تجريبي',
    name_en: 'Testland',
    name_sw: null,
    default_currency: null,
  },
];

export const AREAS: MapContext['areas'] = [
  {
    id: PN,
    country_id: TZ,
    level: 1,
    parent_id: null,
    name_ar: 'بيمبا الشمالية',
    name_en: 'North Pemba',
    name_sw: 'Pemba Kaskazini',
  },
  {
    id: PS,
    country_id: TZ,
    level: 1,
    parent_id: null,
    name_ar: 'بيمبا الجنوبية',
    name_en: 'South Pemba',
    name_sw: 'Pemba Kusini',
  },
  {
    id: ZW,
    country_id: TZ,
    level: 1,
    parent_id: null,
    name_ar: 'زنجبار الحضرية والغربية',
    name_en: 'Zanzibar Urban/West',
    name_sw: null,
  },
  {
    id: PN_WETE,
    country_id: TZ,
    level: 2,
    parent_id: PN,
    name_ar: null,
    name_en: 'Wete',
    name_sw: null,
  },
];

export const LOCALITIES: MapContext['localities'] = [
  { id: WETE, country_id: TZ, admin_area_id: PN, name_ar: 'ويتي', name_latin: 'Wete' },
  { id: MKOANI, country_id: TZ, admin_area_id: PS, name_ar: 'مكواني', name_latin: 'Mkoani' },
];

/** A 1×1 PNG as v2 stored photos (data URL). */
export const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
export const JPEG_DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==';

/** Deterministic `MapContext` (ids `id-1`, `id-2`, … for fresh rows). */
export function makeCtx(
  over: Partial<MapContext> = {},
): MapContext & { ids: Record<string, string> } {
  let n = 0;
  const ids: Record<string, string> = {};
  const ctx: MapContext & { ids: Record<string, string> } = {
    countries: COUNTRIES,
    areas: AREAS,
    localities: LOCALITIES,
    options: OPTIONS,
    donors: [],
    geo: new Map(),
    existingKeys: new Set(),
    branchFor: (countryId, path) =>
      countryId === TZ && (path.includes(PN) || path.includes(PS)) ? BR_PEMBA : null,
    defaultCountryId: TZ,
    defaultBranchId: BR_PEMBA,
    idFor: (key) => (ids[key] ??= `stable-${Object.keys(ids).length + 1}`),
    newId: () => `id-${++n}`,
    phone: (raw, iso2) => {
      const digits = raw.replace(/[^0-9+]/g, '');
      if (digits.startsWith('+') && digits.length >= 9) return digits;
      if (iso2 === 'TZ' && /^0\d{9}$/.test(digits)) return `+255${digits.slice(1)}`;
      return null;
    },
    today: '2026-10-04',
    texts: {
      fallbackName: (id) => `v2 project ${id}`,
      salaryReviewNote: (c) => `REVIEW salary currency ${c.join(',')}`,
    },
    ids,
    ...over,
  };
  return ctx;
}

export function v2Data(
  projects: V2Project[],
  people: V2Person[] = [],
  source: V2Data['source'] = 'v2_json',
): V2Data {
  return { source, projects, people, fingerprint: `fp-${projects.length}-${people.length}` };
}
