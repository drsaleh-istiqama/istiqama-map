/**
 * k6 load test — acceptance criterion 2 (brief §14):
 *   with 300 concurrent users on 100k projects / 500k persons / 1M photo rows
 *   p95 sync_pull < 800 ms, p95 MVT tile < 300 ms, p95 search < 500 ms.
 *
 * Every VU is a distinct user from tokens.json (npm run load:seed): VU n uses vus[n-1], so the
 * per-user rate limits of the RPCs stay ON exactly as in production. Behaviour by `mode`:
 *   first_sync  a collector installing a new device: pages sync_pull from a null cursor to the
 *               end of the round (500 rows per page, 0.5–1.5 s IndexedDB time per page), then
 *               starts over as the next new device.
 *   field       collectors and supervisors: sync cycle (sync_push of an offline batch, then
 *               incremental sync_pull until done), map moves at mixed zooms over the user's area
 *               (phone viewport, ~6 tiles each), searches (Arabic / Latin / code / village /
 *               staff / donor, typed with the app's 250 ms debounce), think time.
 *   office      managers (aal2), hq (aal2) and viewers: incremental pulls, wider map views
 *               (desktop viewport, ~12 tiles, lower zooms), more searches.
 *
 * Requests follow the web app: RPCs through /rest/v1/rpc/* (supabase-js), tiles through the
 * `tiles` Edge Function /functions/v1/tiles/{z}/{x}/{y}?f=…&e=… (apps/web/src/map/tiles.ts).
 *
 * Environment: BASE_URL, ANON_KEY, TOKENS (path of tokens.json), OUT_DIR, VUS (300),
 * RAMP (3m), STEADY (10m), RAMP_DOWN (1m), THINK (1.0 = think-time scale).
 * Run through load-tests/run.ts (npm run load:test), which starts a private stack.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:54341').replace(/\/$/, '');
const ANON = __ENV.ANON_KEY || '';
const TOKENS = __ENV.TOKENS || './tokens.json';
const OUT_DIR = (__ENV.OUT_DIR || './results').replace(/\\/g, '/');
const VUS = Number(__ENV.VUS || 300);
const THINK = Number(__ENV.THINK || 1);

const dur = (s) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(s).trim());
  if (!m) throw new Error(`bad duration ${s}`);
  return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
};
const RAMP = __ENV.RAMP || '3m';
const STEADY = __ENV.STEADY || '10m';
const RAMP_DOWN = __ENV.RAMP_DOWN || '1m';
const RAMP_S = dur(RAMP);
const STEADY_S = dur(STEADY);

const VU_LIST = new SharedArray('vus', () => JSON.parse(open(TOKENS)).vus);
const AREA_LIST = new SharedArray('areas', () => {
  const a = JSON.parse(open(TOKENS)).areas;
  return Object.keys(a).map((k) => ({ key: k, area: a[k] }));
});
const META = new SharedArray('meta', () => {
  const t = JSON.parse(open(TOKENS));
  return [{ seed_xid: t.seed_xid, database: t.database, expires_at: t.expires_at }];
});

const ENDPOINTS = ['sync_pull', 'tile', 'search', 'sync_push', 'my_context', 'register_device'];
const BUDGET = { sync_pull: 800, tile: 300, search: 500 };

const thresholds = { checks: ['rate>0.99'] };
for (const e of ENDPOINTS) {
  // the acceptance budgets are judged on the steady phase (all 300 VUs running)
  const steady = `http_req_duration{endpoint:${e},phase:steady}`;
  thresholds[steady] = BUDGET[e] ? [`p(95)<${BUDGET[e]}`] : ['p(95)<60000'];
  thresholds[`http_req_duration{endpoint:${e}}`] = ['p(95)<60000']; // reported, not judged
  thresholds[`http_req_failed{endpoint:${e},phase:steady}`] = ['rate<0.01'];
  thresholds[`http_req_failed{endpoint:${e}}`] = ['rate<1'];
}
for (const k of ['first', 'incr']) {
  thresholds[`http_req_duration{endpoint:sync_pull,kind:${k},phase:steady}`] = ['p(95)<800'];
}
for (const m of ['first_sync', 'field', 'office']) {
  thresholds[`http_req_duration{endpoint:tile,mode:${m},phase:steady}`] = ['p(95)<60000'];
  thresholds[`http_req_duration{endpoint:search,mode:${m},phase:steady}`] = ['p(95)<60000'];
  thresholds[`http_req_duration{endpoint:sync_pull,mode:${m},phase:steady}`] = ['p(95)<60000'];
}
thresholds['push_ops_rejected'] = ['count>=0'];
thresholds['push_ops_total'] = ['count>=0'];
thresholds['rate_limited'] = ['count>=0'];
thresholds['pull_rows_per_page{kind:first}'] = ['avg>=0'];
thresholds['pull_rows_per_page{kind:incr}'] = ['avg>=0'];

export const options = {
  scenarios: {
    mix: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: STEADY, target: VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: '30s',
      gracefulStop: '30s',
    },
  },
  batchPerHost: 6, // browsers open 6 connections per host for tiles
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  noConnectionReuse: false,
  discardResponseBodies: false,
  setupTimeout: '60s',
};

const pushRejected = new Counter('push_ops_rejected');
const pushTotal = new Counter('push_ops_total');
const rateLimited = new Counter('rate_limited');
const okRate = new Rate('endpoint_ok');
// plausibility of the answers (a fast empty answer would prove nothing)
const tileNonEmpty = new Rate('tile_nonempty');
const searchHits = new Rate('search_nonempty');
const pullRows = new Trend('pull_rows_per_page');
const firstSyncSeconds = new Trend('first_sync_seconds');
const firstSyncRows = new Trend('first_sync_rows');

// ---------------------------------------------------------------------------- helpers

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const think = (a, b) => sleep(rnd(a, b) * THINK);
function weighted(pairs) {
  let t = 0;
  for (const p of pairs) t += p[1];
  let r = Math.random() * t;
  for (const p of pairs) {
    r -= p[1];
    if (r <= 0) return p[0];
  }
  return pairs[pairs.length - 1][0];
}
function hex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}
/** UUIDv7 (device-generated ids, brief §1). */
function uuidv7() {
  const ts = Date.now().toString(16).padStart(12, '0');
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}
function uuidv4() {
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

function phase() {
  const t = (Date.now() - exec.scenario.startTime) / 1000;
  if (t < RAMP_S) return 'ramp';
  if (t < RAMP_S + STEADY_S) return 'steady';
  return 'down';
}

// ---------------------------------------------------------------------------- per-VU state

let me = null; // { vu, area }
let state = null;

function init() {
  const idx = (exec.vu.idInTest - 1) % VU_LIST.length;
  const vu = VU_LIST[idx];
  let area = null;
  for (let i = 0; i < AREA_LIST.length; i++) {
    if (AREA_LIST[i].key === vu.area) {
      area = AREA_LIST[i].area;
      break;
    }
  }
  me = { vu, area };
  state = {
    epoch: null,
    cursor: null,
    firstCursor: null,
    created: [], // { id, version } of projects created by this VU (for update ops)
    headers: {
      Authorization: `Bearer ${vu.token}`,
      apikey: ANON,
      'x-device-id': vu.device,
      'x-client-info': 'supabase-js-web/2 k6-load',
      'Content-Type': 'application/json',
    },
  };
}

function tags(endpoint, extra) {
  const t = { endpoint, phase: phase(), mode: me.vu.mode, role: me.vu.role, name: endpoint };
  if (extra) for (const k in extra) t[k] = extra[k];
  return t;
}

function rpc(fn, body, extraTags) {
  const res = http.post(`${BASE}/rest/v1/rpc/${fn}`, JSON.stringify(body || {}), {
    headers: state.headers,
    tags: tags(fn, extraTags),
    timeout: '60s',
  });
  if (res.status === 429) rateLimited.add(1, { endpoint: fn });
  const ok = check(res, { [`${fn} 200`]: (r) => r.status === 200 }, { endpoint: fn });
  okRate.add(ok, { endpoint: fn });
  if (!ok && Math.random() < 0.05)
    console.warn(`${fn} ${me.vu.key}: HTTP ${res.status} ${String(res.body).slice(0, 300)}`);
  return ok ? res.json() : null;
}

// ---------------------------------------------------------------------------- sync

function startSession() {
  rpc('register_device', {
    p_device_id: state.headers['x-device-id'],
    p_label: 'k6',
    p_app_version: '3.0.0',
  });
  const ctx = rpc('my_context', {});
  state.epoch = ctx ? ctx.scope_epoch : '0';
  // the device finished its first sync when the seed ended: rounds continue from there
  state.cursor = { lo: Number(META[0].seed_xid), e: state.epoch };
}

function pullRound(cursor, kind, maxPages, pageDelay) {
  let cur = cursor;
  let rows = 0;
  for (let i = 0; i < maxPages; i++) {
    const r = rpc('sync_pull', { p_cursor: cur, p_limit: 500 }, { kind });
    if (!r) return { cursor: cur, done: false, rows };
    let n = 0;
    for (const ch of r.changes || []) n += (ch.rows || []).length;
    rows += n;
    pullRows.add(n, { kind });
    cur = r.cursor;
    if (r.reset && kind === 'incr') state.epoch = r.scope_epoch;
    if (r.done) return { cursor: cur, done: true, rows };
    if (pageDelay) sleep(rnd(pageDelay[0], pageDelay[1]));
  }
  return { cursor: cur, done: false, rows };
}

function point() {
  const p = pick(me.area.points);
  return [p[0] + rnd(-0.00005, 0.00005), p[1] + rnd(-0.00005, 0.00005)];
}

const TYPES = ['mosque', 'school', 'combined'];
const AR_PREFIX = { mosque: 'مسجد ', school: 'مدرسة ', combined: 'مسجد ومدرسة ' };
const LA_PREFIX = { mosque: 'Masjid ', school: 'Madrasat ', combined: 'Masjid na Madrasa ' };

function newProjectOps(now) {
  const id = uuidv7();
  const type = pick(TYPES);
  const [lon, lat] = point();
  const ops = [];
  const op = (table, fields, rowId) =>
    ops.push({
      op_id: uuidv4(),
      table,
      id: rowId || uuidv7(),
      kind: 'upsert',
      base_version: 0,
      fields: Object.assign({ created_at: now }, fields),
      client_ts: now,
    });
  const nm = pick(me.area.projectNamesAr) || 'النور';
  op(
    'projects',
    {
      name_ar: `${AR_PREFIX[type]}${nm.split(' ').slice(-1)[0]} ${Math.floor(rnd(1, 999))}`,
      name_latin: `${LA_PREFIX[type]}Load ${hex(4)}`,
      type,
      status: pick(['active', 'active', 'building', 'maintenance']),
      capacity: Math.floor(rnd(30, 600)),
      lon,
      lat,
      gps_accuracy_m: Math.round(rnd(3, 25)),
      location_source: 'gps',
      builder: 'Istiqama',
      build_year: Math.floor(rnd(1990, 2026)),
      record_state: Math.random() < 0.6 ? 'submitted' : 'draft',
    },
    id,
  );
  op('project_land', {
    project_id: id,
    ownership: pick(['association', 'waqf', 'person', 'government']),
    owner_name: 'Load Owner',
    area_m2: Math.round(rnd(200, 3000)),
    utilization_pct: Math.round(rnd(10, 90)),
    expandable: Math.random() < 0.4,
  });
  op('project_facilities', {
    project_id: id,
    teacher_housing: Math.random() < 0.5,
    imam_housing: Math.random() < 0.4,
    library: Math.random() < 0.3,
    quran_count: Math.floor(rnd(0, 80)),
    quran_need: Math.floor(rnd(0, 60)),
    student_transport: pick(['available', 'needed', 'not_needed']),
  });
  op('community_profiles', {
    project_id: id,
    population: Math.floor(rnd(500, 20000)),
    muslim_pct: Math.round(rnd(20, 99)),
  });
  const photos = Math.floor(rnd(2, 6));
  for (let k = 0; k < photos; k++)
    op('project_photos', {
      project_id: id,
      taken_at: now,
      width: 1600,
      height: 1200,
      bytes: Math.floor(rnd(120000, 380000)),
      is_cover: k === 0,
      category: pick(['mosque_front', 'mosque_inside', 'school_front', 'land', 'facilities']),
      upload_state: 'pending',
    });
  if (Math.random() < 0.4)
    op('project_maintenance', {
      project_id: id,
      reported_on: now.slice(0, 10),
      description: 'Roof repair (load test)',
      priority: pick(['low', 'medium', 'high']),
      estimated_cost: Math.round(rnd(100, 4000)),
      currency: 'USD',
      state: 'open',
    });
  const personId = uuidv7();
  const staffId = uuidv7();
  const first = pick(me.area.staffLatin.length ? me.area.staffLatin : ['Salim Al-Kharusi']).split(
    ' ',
  )[0];
  op(
    'persons',
    {
      name_ar: `${pick(me.area.staffAr.length ? me.area.staffAr : ['سالم الخروصي'])} ${hex(2)}`,
      name_latin: `${first} Load ${hex(3)}`,
      gender: 'male',
      birth_year: Math.floor(rnd(1960, 2000)),
    },
    personId,
  );
  op(
    'project_staff',
    {
      project_id: id,
      person_id: personId,
      role: pick(['imam', 'teacher']),
      start_date: '2024-01-01',
    },
    staffId,
  );
  if (Math.random() < 0.5)
    op('staff_compensation', {
      project_staff_id: staffId,
      monthly_amount: Math.round(rnd(50, 400)),
      currency: 'USD',
      effective_from: '2026-01-01',
    });
  return { id, ops };
}

function push() {
  const now = new Date().toISOString();
  let ops = [];
  const newIds = [];
  // an edit of a project this device created earlier (field-level update on a known base)
  if (state.created.length > 0 && Math.random() < 0.6) {
    const c = state.created[Math.floor(Math.random() * state.created.length)];
    ops.push({
      op_id: uuidv4(),
      table: 'projects',
      id: c.id,
      kind: 'upsert',
      base_version: c.version,
      fields: { capacity: Math.floor(rnd(30, 600)), status: pick(['active', 'maintenance']) },
      client_ts: now,
    });
  }
  const n = Math.floor(rnd(1, 4)); // 1–3 new projects of a day offline
  for (let i = 0; i < n; i++) {
    const p = newProjectOps(now);
    if (ops.length + p.ops.length > 50) break;
    ops = ops.concat(p.ops);
    newIds.push(p.id);
  }
  const r = rpc(
    'sync_push',
    { p_ops: ops, p_device_id: state.headers['x-device-id'] },
    { ops: String(ops.length > 25 ? '26-50' : '1-25') },
  );
  pushTotal.add(ops.length);
  if (!r || !r.results) return;
  for (let i = 0; i < r.results.length; i++) {
    const res = r.results[i];
    const o = ops[i];
    if (res.status === 'rejected') {
      pushRejected.add(1, { code: (res.error && res.error.code) || 'unknown', table: o.table });
      if (Math.random() < 0.1)
        console.warn(`push rejected ${me.vu.key} ${o.table}: ${JSON.stringify(res.error)}`);
    } else if (o.table === 'projects' && res.version) {
      const known = state.created.find((c) => c.id === o.id);
      if (known) known.version = res.version;
      else if (newIds.indexOf(o.id) >= 0) state.created.push({ id: o.id, version: res.version });
    }
  }
  if (state.created.length > 20) state.created.splice(0, state.created.length - 20);
}

// ---------------------------------------------------------------------------- map

function lon2x(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function lat2y(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
}

function zoomFor() {
  const role = me.vu.role;
  if (role === 'hq_admin' || (role === 'viewer' && me.vu.area.indexOf('global') === 0))
    return weighted([
      [3, 1],
      [4, 2],
      [5, 3],
      [6, 3],
      [7, 2],
      [8, 2],
      [10, 1],
      [12, 1],
    ]);
  if (role === 'country_manager' || role === 'viewer')
    return weighted([
      [5, 2],
      [6, 3],
      [7, 3],
      [8, 3],
      [9, 2],
      [10, 2],
      [12, 1],
      [14, 1],
    ]);
  return weighted([
    [7, 1],
    [8, 1],
    [9, 2],
    [10, 2],
    [11, 3],
    [12, 3],
    [13, 3],
    [14, 4],
  ]);
}

function mapMove() {
  const z = zoomFor();
  const desktop = me.vu.mode === 'office';
  const [lon, lat] = point();
  const cx = lon2x(lon, z);
  const cy = lat2y(lat, z);
  // tiles of 512 px: phone 412×915 → 2×3 tiles, desktop 1440×900 → 4×3 tiles
  const w = desktop ? 4 : 2;
  const h = 3;
  const n = Math.pow(2, z);
  const layers = Math.random() < 0.15 ? ['clusters', 'points', 'needs'] : ['clusters', 'points'];
  const filters = { layers };
  if (Math.random() < 0.1) filters.type = pick(TYPES);
  const f = encodeURIComponent(JSON.stringify(filters));
  const e = encodeURIComponent(state.epoch || '0');
  const reqs = [];
  for (let dx = -Math.floor(w / 2); dx < w - Math.floor(w / 2); dx++) {
    for (let dy = -1; dy < h - 1; dy++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      reqs.push({
        method: 'GET',
        url: `${BASE}/functions/v1/tiles/${z}/${x}/${y}?f=${f}&e=${e}`,
        params: {
          headers: {
            Authorization: state.headers.Authorization,
            apikey: ANON,
            'x-device-id': state.headers['x-device-id'],
            Accept: '*/*',
            'Accept-Encoding': 'gzip',
          },
          tags: tags('tile', { z: String(z) }),
          timeout: '60s',
          responseType: 'none',
        },
      });
    }
  }
  const out = http.batch(reqs);
  for (const r of out) {
    const ok = check(
      r,
      { 'tile 200/204': (x) => x.status === 200 || x.status === 204 },
      { endpoint: 'tile' },
    );
    okRate.add(ok, { endpoint: 'tile' });
    if (ok) tileNonEmpty.add(r.status === 200, { z: String(z) });
    if (r.status === 429) rateLimited.add(1, { endpoint: 'tile' });
    if (!ok && Math.random() < 0.05) console.warn(`tile ${me.vu.key}: HTTP ${r.status} ${r.url}`);
  }
}

// ---------------------------------------------------------------------------- search

function typo(s) {
  if (s.length < 5) return s;
  const i = 1 + Math.floor(Math.random() * (s.length - 2));
  return s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
}

function searchQuery() {
  const a = me.area;
  const peopleOk = me.vu.role !== 'viewer';
  const kind = weighted([
    ['name_ar', 25],
    ['name_latin', 20],
    ['code', 10],
    ['place', 12],
    ['staff_ar', peopleOk ? 12 : 2],
    ['staff_latin', peopleOk ? 10 : 2],
    ['donor', 5],
    ['generic_ar', 3],
    ['typo', 3],
  ]);
  const or = (arr, d) => (arr && arr.length ? pick(arr) : d);
  switch (kind) {
    case 'name_ar':
      return or(a.projectNamesAr, 'مسجد النور');
    case 'name_latin':
      return or(a.projectNamesLatin, 'Masjid Nuur');
    case 'code':
      return or(a.codes, 'TZ');
    case 'place':
      return or(a.places, 'Kibo');
    case 'staff_ar':
      return or(a.staffAr, 'سالم الخروصي');
    case 'staff_latin':
      return or(a.staffLatin, 'Salim Al-Kharusi');
    case 'donor':
      return or(a.donors, 'Mohammed Al-Harthi');
    case 'generic_ar':
      return pick(['محمد', 'مسجد', 'مدرسة الهدى', 'النور']);
    default:
      return typo(or(a.projectNamesLatin, 'Masjid Nuur'));
  }
}

function search() {
  const q = searchQuery();
  // typing with a 250 ms debounce: a pause mid-word fires once for the prefix, then the full query
  if (q.length > 6 && Math.random() < 0.5) {
    rpc(
      'search',
      { p_q: q.slice(0, Math.max(3, Math.floor(q.length * 0.6))), p_limit: 20 },
      { q: 'prefix' },
    );
    sleep(rnd(0.4, 1.2));
  }
  const hits = rpc('search', { p_q: q, p_limit: 20 }, { q: 'full' });
  if (hits) searchHits.add(Array.isArray(hits) && hits.length > 0);
}

// ---------------------------------------------------------------------------- scenarios

function firstSyncCycle() {
  // a new device: register, context, page the whole scope with IndexedDB time between pages
  state.headers['x-device-id'] = `${me.vu.device}-${hex(6)}`;
  startSession();
  const t0 = Date.now();
  const first = pullRound(null, 'first', 2000, [0.5, 1.5]);
  if (first.done) {
    firstSyncSeconds.add((Date.now() - t0) / 1000);
    firstSyncRows.add(first.rows);
  }
  if (first.done) state.cursor = first.cursor;
  // then the device is in use: an incremental round and a look at the map
  const r = pullRound(state.cursor, 'incr', 20, null);
  state.cursor = r.cursor;
  mapMove();
  think(10, 30);
}

function fieldCycle() {
  const pushP = me.vu.role === 'field_collector' ? 0.35 : 0.1;
  if (Math.random() < pushP) push();
  const r = pullRound(state.cursor, 'incr', 50, null);
  state.cursor = r.cursor;
  think(2, 5);
  const moves = Math.floor(rnd(2, 5));
  for (let i = 0; i < moves; i++) {
    mapMove();
    think(3, 8);
  }
  const searches = Math.random() < 0.6 ? Math.floor(rnd(1, 3)) : 0;
  for (let i = 0; i < searches; i++) {
    search();
    think(3, 8);
  }
  think(10, 30);
}

function officeCycle() {
  const r = pullRound(state.cursor, 'incr', 50, null);
  state.cursor = r.cursor;
  think(2, 5);
  const moves = Math.floor(rnd(3, 7));
  for (let i = 0; i < moves; i++) {
    mapMove();
    think(3, 8);
  }
  const searches = Math.floor(rnd(1, 4));
  for (let i = 0; i < searches; i++) {
    search();
    think(3, 8);
  }
  think(10, 20);
}

export default function () {
  if (!me) {
    init();
    // spread the first requests of the VUs started in the same second
    sleep(Math.random() * 3);
    if (me.vu.mode !== 'first_sync') startSession();
  }
  if (me.vu.mode === 'first_sync') firstSyncCycle();
  else if (me.vu.mode === 'field') fieldCycle();
  else officeCycle();
}

// ---------------------------------------------------------------------------- summary

function fmt(v) {
  return v === undefined || v === null ? '-' : Number(v).toFixed(1);
}

export function handleSummary(data) {
  const lines = [];
  lines.push('');
  lines.push(`endpoint (steady)          count     p50     p95     p99     max  fail%`);
  for (const e of ENDPOINTS) {
    const d = data.metrics[`http_req_duration{endpoint:${e},phase:steady}`];
    const f = data.metrics[`http_req_failed{endpoint:${e},phase:steady}`];
    if (!d) continue;
    const v = d.values;
    lines.push(
      `${e.padEnd(24)} ${String(v.count).padStart(7)} ${fmt(v.med).padStart(7)} ${fmt(v['p(95)']).padStart(7)} ` +
        `${fmt(v['p(99)']).padStart(7)} ${fmt(v.max).padStart(7)} ${f ? (f.values.rate * 100).toFixed(2).padStart(6) : '     -'}`,
    );
  }
  const failed = Object.keys(data.metrics).filter(
    (k) =>
      data.metrics[k].thresholds && Object.values(data.metrics[k].thresholds).some((t) => !t.ok),
  );
  lines.push(failed.length ? `THRESHOLDS FAILED: ${failed.join(', ')}` : 'all thresholds passed');
  lines.push('');
  return {
    stdout: lines.join('\n'),
    [`${OUT_DIR}/k6-summary.json`]: JSON.stringify(data, null, 1),
  };
}
