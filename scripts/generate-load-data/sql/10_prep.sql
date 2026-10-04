-- Load generator, part 1: helper schema `loadgen`, branches, users and the project skeleton.
--
-- Executed by scripts/generate-load-data/index.ts (node-postgres, simple query protocol).
-- Placeholders replaced by index.ts before execution:
--   {{PROJECTS}}   total number of projects (100000 for acceptance criterion 2)
--   {{SEED}}       setseed() value (deterministic distribution)
--   {{COLLECTORS}} field collectors per branch
--
-- Every random draw is fixed here, so that the batch procedure (20_batch.sql) is a pure
-- function of the project number `g` and a batch can be re-run after an interruption.
-- Triggers stay ENABLED: t10_std, the derived columns (code, admin_area_id, search_norm,
-- completeness, name_norm, person_names) and sync_xid are stamped exactly as in production.

select setseed({{SEED}});

drop schema if exists loadgen cascade;
create schema loadgen;

create table loadgen.cfg as select {{PROJECTS}}::int as projects, {{COLLECTORS}}::int as collectors;

-- Country quotas (shares of the total) and number of branches per country.
create table loadgen.c as
select c.id, c.iso2::text as iso2, c.default_currency::text as cur, q.share, q.nbranch,
       0::int as quota
from public.countries c
join (values ('TZ', 0.50, 12), ('KE', 0.20, 8), ('UG', 0.10, 4), ('MZ', 0.07, 4),
             ('RW', 0.05, 3), ('BI', 0.05, 3), ('OM', 0.03, 2)) q (iso2, share, nbranch)
  on q.iso2 = c.iso2;
update loadgen.c set quota = floor(share * (select projects from loadgen.cfg))::int;
-- rounding residue goes to Tanzania so that the total is exact
update loadgen.c set quota = quota + ((select projects from loadgen.cfg) - (select sum(quota) from loadgen.c))
where iso2 = 'TZ';

-- Level-1 areas, grouped west → east into the branches of their country.
create table loadgen.adm1 as
select a.id as adm1_id, a.country_id, c.iso2, a.name_en,
       1 + (row_number() over (partition by a.country_id order by st_x(st_centroid(a.geom)), a.id) - 1)
           * c.nbranch / count(*) over (partition by a.country_id) as bno
from public.admin_areas a join loadgen.c c on c.id = a.country_id
where a.level = 1 and a.deleted_at is null;

create table loadgen.b as
select md5('load:branch:' || iso2 || ':' || bno)::uuid as id, country_id, iso2, bno::int as bno,
       array_agg(adm1_id order by adm1_id) as area_ids
from loadgen.adm1 group by country_id, iso2, bno;

insert into public.branches (id, country_id, code, name_ar, name_en, name_sw, admin_area_ids)
select id, country_id, iso2 || '-B' || bno, 'فرع ' || iso2 || ' ' || bno, 'Branch ' || iso2 || ' ' || bno,
       'Tawi ' || iso2 || ' ' || bno, area_ids
from loadgen.b;

-- Deepest areas ("wards") with their level-1 ancestor. The weight power(random(), 6) makes
-- the distribution very uneven (dense coastal / urban wards, empty hinterland), as in reality.
create table loadgen.ward as
with deepest as (
  select a.country_id, max(a.level) as lvl from public.admin_areas a where a.deleted_at is null group by 1
)
select w.id as ward_id, w.country_id, w.geom,
       coalesce(case when w.level = 1 then w.id end,
                case when p1.level = 1 then p1.id end,
                case when p2.level = 1 then p2.id end) as adm1_id,
       power(random(), 6) as w
from public.admin_areas w
join deepest d on d.country_id = w.country_id and d.lvl = w.level
left join public.admin_areas p1 on p1.id = w.parent_id
left join public.admin_areas p2 on p2.id = p1.parent_id
where w.deleted_at is null and st_area(w.geom) > 0;

-- a ward whose ancestor chain is broken falls back to the nearest level-1 area
update loadgen.ward w
set adm1_id = (select a.id from public.admin_areas a
               where a.level = 1 and a.country_id = w.country_id and a.deleted_at is null
               order by a.geom <-> st_pointonsurface(w.geom) limit 1)
where w.adm1_id is null;

-- Projects per ward: largest-remainder rounding, so that every country hits its quota exactly.
create table loadgen.ward_n as
with base as (
  select w.ward_id, w.country_id, w.adm1_id, c.quota, c.iso2, c.cur,
         c.quota * w.w / sum(w.w) over (partition by w.country_id) as exact
  from loadgen.ward w join loadgen.c c on c.id = w.country_id
), fl as (
  select *, floor(exact)::int as n0,
         row_number() over (partition by country_id order by exact - floor(exact) desc, ward_id) as rk,
         quota - sum(floor(exact)::int) over (partition by country_id) as residue
  from base
)
select fl.ward_id, fl.country_id, fl.adm1_id, b.id as branch_id, fl.iso2, fl.cur,
       fl.n0 + case when fl.rk <= fl.residue then 1 else 0 end as n
from fl
join loadgen.adm1 a on a.adm1_id = fl.adm1_id
join loadgen.b b on b.country_id = fl.country_id and b.bno = a.bno;

-- Project points: uniformly random inside the ward polygon.
create table loadgen.pt as
select row_number() over (order by random())::int as g, x.*
from (
  select n.ward_id, n.country_id, n.branch_id, n.iso2, n.cur,
         (st_dump(st_generatepoints(w.geom, n.n, 1 + (random() * 100000)::int))).geom as geom
  from loadgen.ward_n n join loadgen.ward w on w.ward_id = n.ward_id
  where n.n > 0
) x;
create unique index on loadgen.pt (g);

-- Users (≈ 1,500 registered, brief §0): 2 hq_admin, 1 global viewer, per country 2 managers
-- and 3 viewers, per branch 1 supervisor and {{COLLECTORS}} field collectors.
create table loadgen.u (key text primary key, id uuid, role text, scope_type text, scope_id uuid,
                        country_id uuid, branch_id uuid);
insert into loadgen.u select 'hq_' || k, md5('load:user:hq:' || k)::uuid, 'hq_admin', 'global', null, null, null
from generate_series(1, 2) k;
insert into loadgen.u select 'viewer', md5('load:user:viewer')::uuid, 'viewer', 'global', null, null, null;
insert into loadgen.u
select 'mgr_' || iso2 || '_' || k, md5('load:user:mgr:' || iso2 || ':' || k)::uuid, 'country_manager', 'country', id, id, null
from loadgen.c cross join generate_series(1, 2) k;
insert into loadgen.u
select 'viewer_' || iso2 || '_' || k, md5('load:user:viewer:' || iso2 || ':' || k)::uuid, 'viewer', 'country', id, id, null
from loadgen.c cross join generate_series(1, 3) k;
insert into loadgen.u
select 'sup_' || iso2 || bno, md5('load:user:sup:' || iso2 || bno)::uuid, 'branch_supervisor', 'branch', id, country_id, id
from loadgen.b;
insert into loadgen.u
select 'col_' || iso2 || bno || '_' || k, md5('load:user:col:' || iso2 || bno || ':' || k)::uuid,
       'field_collector', 'branch', id, country_id, id
from loadgen.b cross join generate_series(1, (select collectors from loadgen.cfg)) k;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select id, key || '@load.example.org', 'authenticated', 'authenticated',
       '{"provider":"email","providers":["email"]}', '{}', now(), now()
from loadgen.u;
insert into public.profiles (id, full_name, preferred_language) select id, key, 'ar' from loadgen.u;
insert into public.user_roles (user_id, role, scope_type, scope_id) select id, role, scope_type, scope_id from loadgen.u;

-- Name material (Arabic + Latin, East African and Omani names).
create table loadgen.nm_first (i int primary key, ar text, la text);
insert into loadgen.nm_first select row_number() over (), ar, la from (values
 ('محمد','Mohammed'),('أحمد','Ahmed'),('علي','Ali'),('سالم','Salim'),('سعيد','Said'),('خلفان','Khalfan'),
 ('ناصر','Nasser'),('حمد','Hamad'),('عبدالله','Abdallah'),('يوسف','Yusuf'),('إبراهيم','Ibrahim'),('عمر','Omar'),
 ('خالد','Khalid'),('سليمان','Suleiman'),('حسن','Hassan'),('حسين','Hussein'),('عيسى','Issa'),('موسى','Musa'),
 ('هلال','Hilal'),('راشد','Rashid'),('سيف','Seif'),('ماجد','Majid'),('جمعة','Juma'),('بكر','Bakari'),
 ('رمضان','Ramadhani'),('شعبان','Shabani'),('مسعود','Masoud'),('عثمان','Othman'),('إدريس','Idrisa'),('هارون','Haruna'),
 ('فاطمة','Fatma'),('عائشة','Aisha'),('مريم','Mariam'),('زينب','Zainab'),('خديجة','Khadija'),('آمنة','Amina'),
 ('صالح','Saleh'),('طالب','Talib'),('يحيى','Yahya'),('زكريا','Zakaria')) v(ar, la);
create table loadgen.nm_last (i int primary key, ar text, la text);
insert into loadgen.nm_last select row_number() over (), ar, la from (values
 ('الخروصي','Al-Kharusi'),('البوسعيدي','Al-Busaidi'),('الحارثي','Al-Harthi'),('المزروعي','Al-Mazrui'),('الريامي','Al-Riyami'),
 ('اللمكي','Al-Lamki'),('البرواني','Al-Barwani'),('المعولي','Al-Mauli'),('الكندي','Al-Kindi'),('النبهاني','Al-Nabhani'),
 ('مويني','Mwinyi'),('كومبو','Kombo'),('حاجي','Haji'),('جمعة','Juma'),('خميس','Khamis'),('مكامي','Makame'),
 ('شاه','Shah'),('عمان','Omani'),('مباروك','Mbarouk'),('سليم','Selemani'),('كاسيم','Kassim'),('موسى','Mussa'),
 ('نجوروجي','Njoroge'),('أوتينو','Otieno'),('كيبروتو','Kiprotich'),('موانغي','Mwangi'),('واكو','Wako'),('ندايي','Ndayi'),
 ('هابيمانا','Habimana'),('نكوروزيزا','Nkurunziza')) v(ar, la);
create table loadgen.nm_proj (i int primary key, ar text, la text);
insert into loadgen.nm_proj select row_number() over (), ar, la from (values
 ('النور','Nuur'),('الهدى','Huda'),('التقوى','Taqwa'),('الرحمة','Rahma'),('الفرقان','Furqan'),('الإيمان','Iman'),
 ('السلام','Salaam'),('الاستقامة','Istiqama'),('الفتح','Fath'),('البركة','Baraka'),('الصفا','Safa'),('المروة','Marwa'),
 ('قباء','Quba'),('الأنصار','Ansaar'),('المهاجرين','Muhajirin'),('الرضوان','Ridhwan'),('الإخلاص','Ikhlas'),('التوحيد','Tawhid'),
 ('الخير','Khair'),('الفلاح','Falah'),('النصر','Nasr'),('الجمعة','Jumaa'),('بلال','Bilal'),('أبي بكر','Abubakar'),
 ('عمر بن الخطاب','Omar bin Khattab'),('عثمان','Othman'),('علي بن أبي طالب','Ali bin Abi Talib'),('خديجة','Khadija'),
 ('عائشة','Aisha'),('الزهراء','Zahra')) v(ar, la);
create table loadgen.nm_place (i int primary key, la text);
insert into loadgen.nm_place select g, initcap(
  (array['ki','mwa','cha','nya','ma','u','wa','bu','ka','mi','ngo','su','ta','zi','pe'])[1 + (g * 7) % 15] ||
  (array['bo','nga','mba','ro','li','ndu','sha','te','ko','ja','ru','we','zo','ni','ge'])[1 + (g * 11) % 15] ||
  (array['ni','ra','ti','so','le','ka','mu','ya','go','be'])[1 + (g * 3) % 10] ||
  case when g > 150 then (array['ma','to','ru','si','wa'])[1 + g % 5] else '' end)
from generate_series(1, 600) g;

-- Project skeleton.
create table loadgen.pj as
select p.g, md5('load:project:' || p.g)::uuid as id, p.ward_id, p.country_id, p.branch_id, p.iso2, p.cur, p.geom,
       1 + floor(30 * random())::int as n1,
       1 + floor(600 * random())::int as n2,
       1 + (p.g % (select collectors from loadgen.cfg)) as coll,
       random() as r1, random() as r2, random() as r3, random() as r4, random() as r5,
       (1 + floor(20000 * power(random(), 3)))::int as donor_no,
       ((p.g - 1) / 1000)::int as batch
from loadgen.pt p;
create unique index on loadgen.pj (g);

-- st_generatepoints() sometimes returns a point less for a tiny or degenerate polygon: top
-- each country up to its exact quota with points next to existing projects of that country.
with need as (
  select c.id as country_id, c.quota - count(p.g) as deficit
  from loadgen.c c left join loadgen.pj p on p.country_id = c.id
  group by c.id, c.quota having c.quota > count(p.g)
), src as (
  select n.country_id, k,
         (select p.g from loadgen.pj p where p.country_id = n.country_id order by p.g limit 1 offset k * 37) as src_g
  from need n cross join generate_series(1, n.deficit) k
), numbered as (
  select s.*, m.mx + row_number() over (order by s.country_id, s.k) as g
  from src s cross join (select max(g) as mx from loadgen.pj) m
)
insert into loadgen.pj (g, id, ward_id, country_id, branch_id, iso2, cur, geom, n1, n2, coll,
                        r1, r2, r3, r4, r5, donor_no, batch)
select n.g, md5('load:project:' || n.g)::uuid, p.ward_id, p.country_id, p.branch_id, p.iso2, p.cur,
       st_translate(p.geom, 0.0003, 0.0002), p.n1, p.n2, p.coll, p.r1, p.r2, p.r3, p.r4, p.r5, p.donor_no,
       ((n.g - 1) / 1000)::int
from numbered n join loadgen.pj p on p.g = n.src_g;

create index on loadgen.pj (batch);
analyze loadgen.pj;

create table loadgen.progress (batch int primary key, done_at timestamptz not null default now(), seconds numeric);
