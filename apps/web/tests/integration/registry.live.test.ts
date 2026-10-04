/**
 * Live twin checks of src/db and src/lib against the running database (not part of `npm test`):
 *
 *   npx vitest run --config apps/web/vitest.integration.config.ts tests/integration/registry.live.test.ts
 *
 *   - SYNC_TABLES        = private.sync_tables (order, scope, audience, push classes, natural
 *                          keys, point flag, protected / immutable / writable columns)
 *   - column lists       = information_schema (without sync_xid / geometry, with lon/lat)
 *   - writable columns   = private.sync_writable_columns()
 *   - enumerations       = the CHECK constraints of the tables
 *   - norm()             = private.norm() over the fixture and whole Unicode blocks
 *   - similarity()       = extensions.similarity(private.norm(a), private.norm(b))
 *   - completeness       = private.project_completeness() and the stored value of every project
 *   - wire rows          = a real sync_pull page has exactly the columns of Row<T>
 *
 * Read-only, except the sync_pull call (rate limiter / heartbeat rows of a staging user).
 * Database: ISTIQAMA_DATABASE_URL, else DATABASE_URL, else the local stack
 * (postgresql://postgres@127.0.0.1:54322/istiqama). The service-role key is never used.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFLICT_STATES,
  CURRENCIES,
  GENDERS,
  GUEST_FINANCIAL_CAPACITIES,
  LAND_OWNERSHIPS,
  LANGUAGES,
  LOCALITY_STATUSES,
  LOCATION_SOURCES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATES,
  MERGE_REQUEST_STATES,
  OPTION_LIST_KEYS,
  PHOTO_CATEGORIES,
  PHOTO_UPLOAD_STATES,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  RECORD_STATES,
  SCOPE_TYPES,
  STAFF_ROLES,
  STUDENTS_ORIGINS,
  STUDENT_TRANSPORTS,
  SYNC_TABLES,
  USER_ROLES,
  isTableName,
  tableDef,
  wireColumns,
  writableColumns,
} from '../../src/db';
import { completenessScore } from '../../src/lib/completeness';
import { norm } from '../../src/lib/normalize';
import { similarity } from '../../src/lib/similarity';

const DATABASE_URL =
  process.env.ISTIQAMA_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:54322/istiqama';
const API = process.env.VITE_SUPABASE_URL ?? '';
const ANON = process.env.VITE_SUPABASE_ANON_KEY ?? '';

let client: pg.Client;

beforeAll(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('set default_transaction_read_only = on');
});

afterAll(async () => {
  await client?.end();
});

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(sql, params)).rows as T[];
}

describe('SYNC_TABLES = private.sync_tables', () => {
  it('every column of the registry', async () => {
    const db = await rows<{
      table_name: string;
      pull_order: number;
      scope_kind: string;
      scope_col: string | null;
      audience: string;
      push_insert: string;
      push_update: string;
      push_delete: string;
      natural_key: string[] | null;
      geom_point: boolean;
      protected_cols: string[];
      immutable_cols: string[];
      writable_cols: string[] | null;
    }>('select * from private.sync_tables order by pull_order');
    expect(SYNC_TABLES.map((t) => t.name)).toEqual(db.map((r) => r.table_name));
    for (const r of db) {
      const t = tableDef(r.table_name as Parameters<typeof tableDef>[0]);
      expect({
        name: t.name,
        order: t.order,
        scope: t.scope,
        scopeCol: t.scopeCol,
        audience: t.audience,
        push: t.push,
        naturalKey: t.naturalKey,
        geomPoint: t.geomPoint,
        protectedCols: [...t.protectedCols].sort(),
        immutableCols: [...t.immutableCols].sort(),
        writableCols: t.writableCols ? [...t.writableCols].sort() : null,
      }).toEqual({
        name: r.table_name,
        order: r.pull_order,
        scope: r.scope_kind,
        scopeCol: r.scope_col,
        audience: r.audience,
        push: { insert: r.push_insert, update: r.push_update, delete: r.push_delete },
        naturalKey: r.natural_key,
        geomPoint: r.geom_point,
        protectedCols: [...r.protected_cols].sort(),
        immutableCols: [...r.immutable_cols].sort(),
        writableCols: r.writable_cols ? [...r.writable_cols].sort() : null,
      });
    }
  });

  it('column lists = information_schema (wire form: no sync_xid / geometry, lon/lat for points)', async () => {
    const cols = await rows<{ table_name: string; columns: string[] }>(
      `select table_name, array_agg(column_name::text order by ordinal_position) as columns
         from information_schema.columns
        where table_schema = 'public' and table_name = any($1)
        group by table_name`,
      [SYNC_TABLES.map((t) => t.name)],
    );
    expect(cols).toHaveLength(SYNC_TABLES.length);
    for (const c of cols) {
      const t = tableDef(c.table_name as Parameters<typeof tableDef>[0]);
      const wire = c.columns.filter((n) => !['sync_xid', 'geom', 'geom_simple'].includes(n));
      if (t.geomPoint) wire.push('lon', 'lat');
      expect([c.table_name, [...wireColumns(t.name)].sort()]).toEqual([c.table_name, wire.sort()]);
    }
  });

  it('writable columns = private.sync_writable_columns() (+ lon/lat)', async () => {
    for (const t of SYNC_TABLES) {
      const [r] = await rows<{ cols: string[] | null }>(
        'select private.sync_writable_columns($1) as cols',
        [t.name],
      );
      const server = t.push.insert === 'none' && t.push.update === 'none' ? [] : (r?.cols ?? []);
      const mine = [...writableColumns(t.name)].filter((c) => c !== 'lon' && c !== 'lat');
      expect([t.name, mine.sort()]).toEqual([t.name, [...server].sort()]);
    }
  });
});

describe('enumerations = CHECK constraints', () => {
  const ENUMS: Array<[string, string, readonly string[]]> = [
    ['projects', 'type', PROJECT_TYPES],
    ['projects', 'status', PROJECT_STATUSES],
    ['projects', 'record_state', RECORD_STATES],
    ['projects', 'location_source', LOCATION_SOURCES],
    ['project_land', 'ownership', LAND_OWNERSHIPS],
    ['project_facilities', 'student_transport', STUDENT_TRANSPORTS],
    ['project_facilities', 'students_origin', STUDENTS_ORIGINS],
    ['project_maintenance', 'priority', MAINTENANCE_PRIORITIES],
    ['project_maintenance', 'state', MAINTENANCE_STATES],
    ['project_photos', 'category', PHOTO_CATEGORIES],
    ['project_photos', 'upload_state', PHOTO_UPLOAD_STATES],
    ['project_staff', 'role', STAFF_ROLES],
    // staff_compensation.currency is no longer an enumerated CHECK (migration 0072): a format
    // CHECK plus a managed-list trigger; asserted separately below.
    ['persons', 'gender', GENDERS],
    ['localities', 'status', LOCALITY_STATUSES],
    ['option_values', 'list_key', OPTION_LIST_KEYS],
    ['community_sensitive', 'guest_financial_capacity', GUEST_FINANCIAL_CAPACITIES],
    ['person_merge_requests', 'state', MERGE_REQUEST_STATES],
    ['sync_conflicts', 'state', CONFLICT_STATES],
    ['user_roles', 'role', USER_ROLES],
    ['user_roles', 'scope_type', SCOPE_TYPES],
    ['profiles', 'preferred_language', LANGUAGES],
  ];

  it('every exported value list matches its database CHECK', async () => {
    const defs = await rows<{ table_name: string; def: string }>(
      `select conrelid::regclass::text as table_name, pg_get_constraintdef(oid) as def
         from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace`,
    );
    for (const [table, column, values] of ENUMS) {
      const re = new RegExp(`\\(${column} = ANY \\(ARRAY\\[([^\\]]+)\\]`);
      const hit = defs.find((d) => d.table_name === table && re.test(d.def));
      expect(hit, `${table}.${column}`).toBeDefined();
      const list = [...re.exec(hit!.def)![1]!.matchAll(/'([^']*)'::/g)].map((m) => m[1]);
      expect([`${table}.${column}`, [...values]]).toEqual([`${table}.${column}`, list]);
    }
  });

  it('staff_compensation.currency: format CHECK + every client currency is managed (0072)', async () => {
    const [fmt] = await rows<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.staff_compensation'::regclass
          and conname = 'staff_compensation_currency_format_ck'`,
    );
    expect(fmt?.def).toContain('[A-Z]{3}');
    const managed = await rows<{ code: string; ok: boolean }>(
      'select c as code, private.currency_is_managed(c) as ok from unnest($1::text[]) c',
      [[...CURRENCIES]],
    );
    expect(managed.filter((m) => !m.ok).map((m) => m.code)).toEqual([]);
  });
});

describe('norm() = private.norm()', () => {
  it('the shared fixture', async () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../../supabase/tests/fixtures/normalize.json'),
        'utf8',
      ),
    ) as Array<{ name: string; input: string }>;
    const db = await rows<{ out: string[] }>(
      'select array_agg(private.norm(x) order by o) as out from unnest($1::text[]) with ordinality t(x, o)',
      [fixture.map((c) => c.input)],
    );
    expect(fixture.map((c) => norm(c.input))).toEqual(db[0]!.out);
  });

  // Blocks names can contain (see the header of src/lib/normalize.ts for what is not mirrored).
  // Greek capitals U+037F and U+03F4 are left out: their lower case depends on the Unicode
  // version of the server's locale (JavaScript lower-cases them, PostgreSQL 17 / en-US here
  // does not). Neither occurs in names.
  const BLOCKS: Array<[string, number, number]> = [
    ['ASCII + Latin-1 + Latin Extended-A/B', 0x0001, 0x024f],
    ['IPA + spacing modifiers + combining marks', 0x0250, 0x036f],
    ['Greek (U+0370..U+037E)', 0x0370, 0x037e],
    ['Greek (U+0380..U+03F3)', 0x0380, 0x03f3],
    ['Greek (U+03F5..U+03FF)', 0x03f5, 0x03ff],
    ['Arabic', 0x0600, 0x06ff],
    ['Arabic Supplement', 0x0750, 0x077f],
    ['Arabic Extended-A', 0x08a0, 0x08ff],
    ['Latin Extended Additional', 0x1e00, 0x1eff],
    ['General Punctuation', 0x2000, 0x206f],
    ['Arabic Presentation Forms-A', 0xfb50, 0xfdff],
    ['Arabic Presentation Forms-B', 0xfe70, 0xfeff],
  ];

  for (const [name, from, to] of BLOCKS) {
    it(`every code point of ${name}, alone and inside a word`, async () => {
      const db = await rows<{ i: number; alone: string; inside: string }>(
        `select i, private.norm(chr(i)) as alone, private.norm('Ab ' || chr(i) || 'مس ') as inside
           from generate_series($1::int, $2::int) i`,
        [from, to],
      );
      const diffs: string[] = [];
      for (const r of db) {
        const ch = String.fromCodePoint(r.i);
        if (norm(ch) !== r.alone || norm('Ab ' + ch + 'مس ') !== r.inside)
          diffs.push(r.i.toString(16));
      }
      expect(diffs).toEqual([]);
    });
  }

  it('composed sequences (NFC before the removal of marks)', async () => {
    const cp = (...c: number[]): string => String.fromCodePoint(...c);
    const inputs = [
      cp(0x0648, 0x0654), // waw + hamza above -> U+0624, kept
      cp(0x0627, 0x0654), // alef + hamza above -> U+0623, folded to alef
      cp(0x0627, 0x0653), // alef + madda -> U+0622
      cp(0x064a, 0x0654), // yeh + hamza above -> U+0626
      'e' + cp(0x0301) + 'cole  S' + cp(0x0061, 0x0303) + 'o',
      cp(0x0645, 0x064e, 0x0633, 0x0652, 0x062c, 0x0650, 0x062f, 0x064f) + cp(0x200b) + 'x',
      '  مَسْجِدُ   النُّور ',
    ];
    const db = await rows<{ out: string[] }>(
      'select array_agg(private.norm(x) order by o) as out from unnest($1::text[]) with ordinality t(x, o)',
      [inputs],
    );
    expect(inputs.map(norm)).toEqual(db[0]!.out);
  });
});

describe('similarity() = pg_trgm similarity()', () => {
  const PAIRS: Array<[string, string]> = [
    ['مسجد النور', 'مسجد النور الكبير'],
    ['مسجد النور', 'مسجد نور'],
    ['مسجد النور', 'مدرسة النور'],
    ['مسجد الهدى', 'مسجد الهدي'],
    ['مَسْجِدُ النُّور', 'مسجد النور'],
    ['أحمد إبراهيم', 'احمد ابراهيم'],
    ['محمد بن سالم الحارثي', 'محمد سالم الحارثي'],
    ['محمد بن سالم الحارثي', 'محمد بن سليم الحارثي'],
    ['محمد', 'محمود'],
    ['عبدالله', 'عبد الله'],
    ['فاطمة', 'فاطمه الزهراء'],
    ['مؤسسة الخير', 'مؤسسه الخير'],
    ['Masjid Noor', 'Masjid Nur'],
    ['Msikiti wa Ijumaa', 'Msikiti wa Ijumaa Wete'],
    ['Mohamed Salim Ali', 'Mohammed Salim Ali'],
    ["Shule ya Qur'an", 'Shule ya Quran'],
    ['École São João', 'ecole sao joao'],
    ['TZ-PN-000123', 'TZ-PN-000124'],
    ['Chake Chake', 'Chake-Chake'],
    ['Ali', 'Ally'],
    ['a', 'b'],
    ['ab', 'abc'],
    ['', 'x'],
    ['مسجد ١٢٣', 'مسجد 123'],
  ];

  it('agrees to 6 decimals on Arabic and Latin pairs', async () => {
    const db = await rows<{ s: number[] }>(
      `select array_agg(extensions.similarity(private.norm(a), private.norm(b)) order by o) as s
         from unnest($1::text[], $2::text[]) with ordinality t(a, b, o)`,
      [PAIRS.map((p) => p[0]), PAIRS.map((p) => p[1])],
    );
    PAIRS.forEach(([a, b], i) => {
      expect([a, b, similarity(norm(a), norm(b))]).toEqual([
        a,
        b,
        expect.closeTo(Number(db[0]!.s[i]), 6),
      ]);
    });
  });
});

describe('completeness = private.project_completeness()', () => {
  it('every project in the database (seeded staging data included)', async () => {
    const projects = await rows<{
      id: string;
      name_ar: string;
      name_latin: string | null;
      lon: number | null;
      lat: number | null;
      admin_area_id: string | null;
      capacity: number | null;
      build_year: number | null;
      build_date: string | null;
      photos: boolean;
      land: boolean;
      facilities: boolean;
      staff: boolean;
      community: boolean;
      score: number;
      stored: number;
      deleted: boolean;
    }>(
      `select p.id, p.name_ar, p.name_latin, st_x(p.geom) as lon, st_y(p.geom) as lat, p.admin_area_id, p.capacity,
              p.build_year, p.build_date::text as build_date,
              exists (select 1 from project_photos c where c.project_id = p.id and c.deleted_at is null) as photos,
              exists (select 1 from project_land c where c.project_id = p.id and c.deleted_at is null) as land,
              exists (select 1 from project_facilities c where c.project_id = p.id and c.deleted_at is null) as facilities,
              exists (select 1 from project_staff c where c.project_id = p.id and c.deleted_at is null) as staff,
              exists (select 1 from community_profiles c where c.project_id = p.id and c.deleted_at is null) as community,
              private.project_completeness(p) as score, p.completeness as stored, p.deleted_at is not null as deleted
         from projects p`,
    );
    expect(projects.length).toBeGreaterThan(0);
    const diffs = projects
      .map((p) => ({
        id: p.id,
        local: completenessScore(p, p),
        server: p.score,
        stored: p.stored,
        deleted: p.deleted,
      }))
      .filter((d) => d.local !== d.server || (!d.deleted && d.local !== d.stored));
    expect(diffs).toEqual([]);
    // the staging data covers more than one score
    expect(new Set(projects.map((p) => p.score)).size).toBeGreaterThan(1);
  });
});

describe('wire rows of a real sync_pull page', () => {
  it('have exactly the columns of Row<T> (lon/lat, no geom, no sync_xid)', async () => {
    expect(API, 'VITE_SUPABASE_URL').not.toBe('');
    const auth = await fetch(`${API}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'collector.pemba@example.org', password: 'Passw0rd!dev' }),
    });
    expect(auth.status).toBe(200);
    const { access_token: token } = (await auth.json()) as { access_token: string };
    // A first round (null cursor), paged until done: every table the collector can see.
    const tables = new Set<string>();
    let cursor: unknown = null;
    for (let i = 0; i < 60; i++) {
      const pull = await fetch(`${API}/rest/v1/rpc/sync_pull`, {
        method: 'POST',
        headers: {
          apikey: ANON,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-device-id': 'registry-live-test',
        },
        body: JSON.stringify({ p_cursor: cursor, p_limit: 1000 }),
      });
      expect(pull.status).toBe(200);
      const page = (await pull.json()) as {
        changes: Array<{ table: string; rows?: Array<Record<string, unknown>> }>;
        cursor: unknown;
        done: boolean;
      };
      for (const change of page.changes) {
        expect(isTableName(change.table), change.table).toBe(true);
        if (!isTableName(change.table)) continue;
        const want = [...wireColumns(change.table)].sort();
        for (const row of change.rows ?? []) {
          expect([change.table, Object.keys(row).sort()]).toEqual([change.table, want]);
        }
        tables.add(change.table);
      }
      cursor = page.cursor;
      if (page.done) break;
    }
    expect(tables.has('projects')).toBe(true);
    // a collector never receives restricted tables
    expect(tables.has('staff_compensation')).toBe(false);
    expect(tables.has('community_sensitive')).toBe(false);
    expect(tables.size).toBeGreaterThan(3);
  });
});
