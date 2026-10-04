/**
 * Generate the web locale fragments of enumerated values (namespace "enum") from the single
 * source of truth: private.enum_labels (migration 0053), so that the UI, CSV/XLSX export and
 * print reports always use the same words.
 *
 *   npx tsx scripts/gen-enum-locales.ts [--database-url postgresql://…]
 *
 * Output: apps/web/locales/_parts/enum.{ar,sw,en}.json with keys "<enum_key>.<code>"
 * (e.g. t('enum.project_type.mosque')). Extra labels that only the UI needs and that have
 * no column in the database (photo categories, currencies, gender) are appended from
 * EXTRA below. Re-run after changing enum_labels; the merge script fails on drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvFile } from './local-stack/lib.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(path.join(ROOT, '.env.local'));
const argIdx = process.argv.indexOf('--database-url');
const url =
  (argIdx > 0 ? process.argv[argIdx + 1] : undefined) ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:54322/istiqama';

type Labels = { ar: string; sw: string; en: string };

/** UI-only enumerations (no database dictionary row). Arabic follows v2 wording. */
const EXTRA: Record<string, Record<string, Labels>> = {
  photo_category: {
    unspecified: { ar: 'غير محدد', sw: 'Haijabainishwa', en: 'Unspecified' },
    mosque_front: { ar: 'واجهة المسجد', sw: 'Mbele ya msikiti', en: 'Mosque front' },
    mosque_inside: { ar: 'داخل المسجد', sw: 'Ndani ya msikiti', en: 'Inside the mosque' },
    school_front: { ar: 'واجهة المدرسة', sw: 'Mbele ya madrasa', en: 'School front' },
    school_inside: {
      ar: 'داخل المدرسة / الفصول',
      sw: 'Ndani ya madrasa / madarasa',
      en: 'Inside the school / classrooms',
    },
    land: { ar: 'الأرض والساحات', sw: 'Ardhi na viwanja', en: 'Land and grounds' },
    facilities: { ar: 'المرافق والخدمات', sw: 'Huduma na vifaa', en: 'Facilities and services' },
    maintenance: {
      ar: 'موضع يحتاج صيانة',
      sw: 'Sehemu inayohitaji matengenezo',
      en: 'Spot needing maintenance',
    },
    other: { ar: 'أخرى', sw: 'Nyingine', en: 'Other' },
  },
  gender: {
    male: { ar: 'ذكر', sw: 'Mwanamume', en: 'Male' },
    female: { ar: 'أنثى', sw: 'Mwanamke', en: 'Female' },
  },
  currency: {
    TZS: { ar: 'شلن تنزاني', sw: 'Shilingi ya Tanzania', en: 'Tanzanian shilling' },
    KES: { ar: 'شلن كيني', sw: 'Shilingi ya Kenya', en: 'Kenyan shilling' },
    UGX: { ar: 'شلن أوغندي', sw: 'Shilingi ya Uganda', en: 'Ugandan shilling' },
    RWF: { ar: 'فرنك رواندي', sw: 'Faranga ya Rwanda', en: 'Rwandan franc' },
    BIF: { ar: 'فرنك بوروندي', sw: 'Faranga ya Burundi', en: 'Burundian franc' },
    MZN: { ar: 'متكال موزمبيقي', sw: 'Metikali ya Msumbiji', en: 'Mozambican metical' },
    OMR: { ar: 'ريال عُماني', sw: 'Riyali ya Oman', en: 'Omani rial' },
    USD: { ar: 'دولار أمريكي', sw: 'Dola ya Marekani', en: 'US dollar' },
  },
};

const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows } = await client.query<{
  enum_key: string;
  code: string;
  ar: string;
  sw: string;
  en: string;
}>(
  'select enum_key, code, ar, sw, en from private.enum_labels order by enum_key, sort_order, code',
);
await client.end();

const out: Record<'ar' | 'sw' | 'en', Record<string, string>> = { ar: {}, sw: {}, en: {} };
const put = (key: string, l: Labels): void => {
  out.ar[key] = l.ar;
  out.sw[key] = l.sw;
  out.en[key] = l.en;
};
for (const r of rows) put(`${r.enum_key}.${r.code}`, r);
for (const [group, values] of Object.entries(EXTRA)) {
  for (const [code, l] of Object.entries(values)) {
    if (!(`${group}.${code}` in out.ar)) put(`${group}.${code}`, l);
  }
}

const dir = path.join(ROOT, 'apps', 'web', 'locales', '_parts');
for (const lang of ['ar', 'sw', 'en'] as const) {
  fs.writeFileSync(path.join(dir, `enum.${lang}.json`), JSON.stringify(out[lang], null, 2) + '\n');
}
console.log(
  `enum locales: ${Object.keys(out.ar).length} keys (${rows.length} from private.enum_labels)`,
);
