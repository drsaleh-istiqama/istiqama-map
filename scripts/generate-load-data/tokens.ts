/**
 * Load-test identities: picks the k6 virtual users from the generated accounts, signs one
 * HS256 access token per user (the same claims the gateway's Auth emulation issues) and
 * collects per-scope material for the scenarios (map areas, search terms). Written to
 * load-tests/tokens.json (git-ignored: it contains bearer tokens for the private database).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import type pg from 'pg';

export type Mode = 'first_sync' | 'field' | 'office';

export interface VuUser {
  key: string;
  id: string;
  role: string;
  aal: 'aal1' | 'aal2';
  mode: Mode;
  area: string;
  token: string;
  device: string;
}

export interface Area {
  /** [minLon, minLat, maxLon, maxLat] of the projects in scope */
  bbox: [number, number, number, number];
  /** sample project positions [lon, lat] used as map centres and push locations */
  points: [number, number][];
  codes: string[];
  projectNamesAr: string[];
  projectNamesLatin: string[];
  places: string[];
  staffAr: string[];
  staffLatin: string[];
  donors: string[];
}

export interface TokensFile {
  generated_at: string;
  expires_at: string;
  database: string;
  /** private.safe_xid() after seeding: an "already synced" device starts its rounds here */
  seed_xid: string;
  vus: VuUser[];
  areas: Record<string, Area>;
}

export interface VuMix {
  total: number;
  firstSync: number;
  supervisors: number;
  managers: number;
  hq: number;
  viewers: number;
}

/** 300 VUs: 228 collectors (24 of them doing first syncs), 36 supervisors, 14 managers, 2 hq, 20 viewers. */
export function defaultMix(total: number): VuMix {
  const scale = total / 300;
  const r = (n: number): number => Math.max(1, Math.round(n * scale));
  return {
    total,
    firstSync: r(24),
    supervisors: r(36),
    managers: r(14),
    hq: Math.min(2, r(2)),
    viewers: r(20),
  };
}

interface UserRow {
  key: string;
  id: string;
  role: string;
  scope_type: string;
  scope_id: string | null;
  country_id: string | null;
  branch_id: string | null;
}

/** Round-robin over groups (e.g. collectors per branch) so that every branch is represented. */
function roundRobin<T>(groups: T[][], n: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < n; i++) {
    let any = false;
    for (const g of groups) {
      if (i < g.length) {
        any = true;
        out.push(g[i]!);
        if (out.length === n) break;
      }
    }
    if (!any) break;
  }
  return out;
}

function groupBy<T>(rows: T[], key: (r: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const g = m.get(k);
    if (g) g.push(r);
    else m.set(k, [r]);
  }
  return [...m.values()];
}

/** Interleave the role lists so that every ramp stage contains every role. */
function interleave<T>(lists: T[][]): T[] {
  const total = lists.reduce((s, l) => s + l.length, 0);
  const pos = lists.map(() => 0);
  const out: T[] = [];
  while (out.length < total) {
    // pick the list that is furthest behind its proportional share
    let best = -1;
    let bestLag = -Infinity;
    lists.forEach((l, i) => {
      if (pos[i]! >= l.length) return;
      const lag = (out.length + 1) * (l.length / total) - pos[i]!;
      if (lag > bestLag) {
        bestLag = lag;
        best = i;
      }
    });
    out.push(lists[best]![pos[best]!]!);
    pos[best]! += 1;
  }
  return out;
}

async function areaFor(
  client: pg.Client,
  scope: { country?: string | null; branch?: string | null },
  approvedOnly: boolean,
): Promise<Area> {
  const where: string[] = ['p.deleted_at is null'];
  const params: unknown[] = [];
  if (scope.branch) {
    params.push(scope.branch);
    where.push(`p.branch_id = $${params.length}`);
  } else if (scope.country) {
    params.push(scope.country);
    where.push(`p.country_id = $${params.length}`);
  }
  if (approvedOnly) where.push(`p.record_state = 'approved'`);
  const w = where.join(' and ');
  const bbox = await client.query<{ a: number; b: number; c: number; d: number }>(
    `select st_xmin(e) a, st_ymin(e) b, st_xmax(e) c, st_ymax(e) d
       from (select st_extent(p.geom)::geometry e from public.projects p where ${w}) x`,
    params,
  );
  const sample = await client.query<{
    id: string;
    lon: number;
    lat: number;
    code: string;
    name_ar: string;
    name_latin: string | null;
    place: string | null;
  }>(
    `select p.id::text id, st_x(p.geom) lon, st_y(p.geom) lat, p.code, p.name_ar, p.name_latin, l.name_latin place
       from public.projects p tablesample system (5) repeatable (7)
       left join public.localities l on l.id = p.locality_id
      where ${w} and p.geom is not null
      limit 60`,
    params,
  );
  let rows = sample.rows;
  if (rows.length < 10) {
    rows = (
      await client.query<(typeof sample.rows)[number]>(
        `select p.id::text id, st_x(p.geom) lon, st_y(p.geom) lat, p.code, p.name_ar, p.name_latin, l.name_latin place
           from public.projects p left join public.localities l on l.id = p.locality_id
          where ${w} and p.geom is not null order by p.id limit 60`,
        params,
      )
    ).rows;
  }
  const staff = await client.query<{ name_ar: string; name_latin: string }>(
    `select pe.name_ar, pe.name_latin
       from public.projects p
       join public.project_staff s on s.project_id = p.id and s.deleted_at is null
       join public.persons pe on pe.id = s.person_id
      where ${w} and p.id = any($${params.length + 1}::uuid[])
      limit 20`,
    [...params, rows.map((r) => r.id)],
  );
  let staffRows = staff.rows;
  if (staffRows.length === 0) {
    staffRows = (
      await client.query<{ name_ar: string; name_latin: string }>(
        `select pe.name_ar, pe.name_latin from public.persons pe
          where pe.deleted_at is null ${
            scope.branch ? 'and pe.branch_id = $1' : scope.country ? 'and pe.country_id = $1' : ''
          }
          order by pe.id limit 20`,
        scope.branch ? [scope.branch] : scope.country ? [scope.country] : [],
      )
    ).rows;
  }
  const donors = await client.query<{ name_latin: string }>(
    `select d.name_latin from public.project_donors pd
       join public.donors d on d.id = pd.donor_id
       join public.projects p on p.id = pd.project_id
      where ${w} limit 10`,
    params,
  );
  const words = (s: string | null | undefined, n: number): string =>
    (s ?? '').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
  const b = bbox.rows[0]!;
  return {
    bbox: [b.a, b.b, b.c, b.d],
    points: rows.map((r) => [Number(r.lon.toFixed(6)), Number(r.lat.toFixed(6))]),
    codes: rows.slice(0, 15).map((r) => r.code),
    projectNamesAr: [...new Set(rows.map((r) => words(r.name_ar, 2)))].slice(0, 15),
    projectNamesLatin: [...new Set(rows.map((r) => words(r.name_latin, 3)))].slice(0, 15),
    places: [...new Set(rows.map((r) => r.place).filter((p): p is string => !!p))]
      .map((p) => words(p, 1))
      .slice(0, 15),
    staffAr: staffRows.map((r) => words(r.name_ar, 2)).slice(0, 15),
    staffLatin: staffRows.map((r) => words(r.name_latin, 3)).slice(0, 15),
    donors: donors.rows.map((r) => words(r.name_latin, 2)),
  };
}

export async function buildTokens(
  client: pg.Client,
  opts: { database: string; secret: string; mix: VuMix; ttlHours: number; outFile: string },
): Promise<TokensFile> {
  if (!opts.secret || opts.secret.length < 32)
    throw new Error('SUPABASE_JWT_SECRET missing or shorter than 32 characters (.env.local)');
  const users = (
    await client.query<UserRow>(
      'select key, id::text, role, scope_type, scope_id::text, country_id::text, branch_id::text from loadgen.u order by key',
    )
  ).rows;
  const by = (role: string): UserRow[] => users.filter((u) => u.role === role);
  const { mix } = opts;
  const collectorsWanted = mix.total - mix.supervisors - mix.managers - mix.hq - mix.viewers;
  if (collectorsWanted < mix.firstSync) throw new Error('VU mix: not enough collectors');

  const collectors = roundRobin(
    groupBy(by('field_collector'), (u) => u.branch_id ?? ''),
    collectorsWanted,
  );
  const supervisors = by('branch_supervisor').slice(0, mix.supervisors);
  const managers = roundRobin(
    groupBy(by('country_manager'), (u) => u.country_id ?? ''),
    mix.managers,
  );
  const hq = by('hq_admin').slice(0, mix.hq);
  const viewers = [
    ...by('viewer').filter((u) => u.scope_type === 'global'),
    ...roundRobin(
      groupBy(
        by('viewer').filter((u) => u.scope_type !== 'global'),
        (u) => u.country_id ?? '',
      ),
      mix.viewers,
    ),
  ].slice(0, mix.viewers);
  const shortBy = (list: UserRow[], wanted: number, label: string): void => {
    if (list.length < wanted)
      throw new Error(`VU mix wants ${wanted} ${label}, the database has ${list.length}`);
  };
  shortBy(collectors, collectorsWanted, 'collectors');
  shortBy(supervisors, mix.supervisors, 'supervisors');
  shortBy(managers, mix.managers, 'managers');
  shortBy(viewers, mix.viewers, 'viewers');

  // every k-th collector (spread over branches) installs a new device = first-sync scenario
  const step = collectors.length / mix.firstSync;
  const firstSyncKeys = new Set<string>();
  for (let i = 0; i < mix.firstSync; i++) firstSyncKeys.add(collectors[Math.floor(i * step)]!.key);

  const now = Math.floor(Date.now() / 1000);
  const exp = now + opts.ttlHours * 3600;
  const issuer = `${(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/$/, '')}/auth/v1`;
  const areas: Record<string, Area> = {};
  const areaKey = (u: UserRow): string =>
    u.scope_type === 'global'
      ? u.role === 'viewer'
        ? 'global:approved'
        : 'global'
      : `${u.scope_type}:${u.scope_id}${u.role === 'viewer' ? ':approved' : ''}`;

  const toVu = (u: UserRow, mode: Mode): VuUser => {
    const aal: 'aal1' | 'aal2' =
      u.role === 'country_manager' || u.role === 'hq_admin' ? 'aal2' : 'aal1';
    const token = jwt.sign(
      {
        aud: 'authenticated',
        role: 'authenticated',
        sub: u.id,
        email: `${u.key}@load.example.org`,
        phone: '',
        aal,
        amr:
          aal === 'aal2'
            ? [
                { method: 'totp', timestamp: now },
                { method: 'otp', timestamp: now },
              ]
            : [{ method: 'otp', timestamp: now }],
        session_id: crypto.randomUUID(),
        is_anonymous: false,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        iat: now,
        exp,
        iss: issuer,
      },
      opts.secret,
      { algorithm: 'HS256', noTimestamp: true },
    );
    return {
      key: u.key,
      id: u.id,
      role: u.role,
      aal,
      mode,
      area: areaKey(u),
      token,
      device: `load-${u.key}`.replace(/[^A-Za-z0-9._:-]/g, '-'),
    };
  };

  const fieldVus = collectors.map((u) =>
    toVu(u, firstSyncKeys.has(u.key) ? 'first_sync' : 'field'),
  );
  const vus = interleave([
    fieldVus,
    supervisors.map((u) => toVu(u, 'field')),
    [...managers, ...hq, ...viewers].map((u) => toVu(u, 'office')),
  ]);

  for (const u of [...collectors, ...supervisors, ...managers, ...hq, ...viewers]) {
    const k = areaKey(u);
    if (areas[k]) continue;
    areas[k] = await areaFor(
      client,
      {
        country: u.scope_type === 'country' ? u.scope_id : null,
        branch: u.scope_type === 'branch' ? u.scope_id : null,
      },
      u.role === 'viewer',
    );
  }

  const xid = await client.query<{ x: string }>('select private.safe_xid()::text as x');
  const out: TokensFile = {
    generated_at: new Date(now * 1000).toISOString(),
    expires_at: new Date(exp * 1000).toISOString(),
    database: opts.database,
    seed_xid: xid.rows[0]!.x,
    vus,
    areas,
  };
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  fs.writeFileSync(opts.outFile, JSON.stringify(out, null, 1));
  return out;
}
