# النشر على Railway — Supabase مستضاف ذاتياً (قرار المالك رقم 1)

> مرجع تشغيل لبيئة **production**: مشروع Railway `istiqama-map` (البيئة `production`، المنطقة `ams`)،
> والواجهة على Cloudflare Pages بنطاق `https://map.istiqama.om`. لا قيم سرية في هذا الملف — الأسماء فقط.
> السياق العام: `docs/RUNBOOK.md` (خاصة §4 النسخ الاحتياطي و§12 ملاحظات التوافق) و`docs/ARCHITECTURE.md`.

## 1. الخدمات

القالب المجتمعي `supabase` (المستودع `github.com/6ixfalls/supabase`) + خدمة `functions` الخاصة بنا.

| الخدمة              | المصدر                                           | الدور                                                                                            |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `Envoy`             | `6ixfalls/supabase` (`envoy/`)                   | البوابة العامة (منفذ 8000): `/auth/v1` `/rest/v1` `/storage/v1` `/functions/v1` `/pg` و Studio   |
| `Gotrue Auth`       | `6ixfalls/supabase` (`auth/`)                    | GoTrue v2.189 (منفذ 9999)                                                                        |
| `Postgrest`         | `6ixfalls/supabase` (`rest/`)                    | PostgREST (منفذ 3000)                                                                            |
| `Supabase Storage`  | `6ixfalls/supabase` (`storage/`)                 | Storage API (منفذ 5000)، الملفات في Railway Bucket `S3`                                          |
| `Imgproxy`          | `darthsim/imgproxy`                              | تحويل الصور لـ Storage                                                                           |
| `Postgres`          | `ghcr.io/6ixfalls/supabase-postgres:17.6.1.x`    | supabase/postgres 17 + الحجم `postgres-volume` (5 GB)                                            |
| `Postgres Meta`     | `supabase/postgres-meta`                         | واجهة Studio للقاعدة (`/pg/*`، مفتاح service فقط)                                                |
| `Supavisor`         | `6ixfalls/supabase` (`pooler/`)                  | مجمّع الاتصالات                                                                                  |
| `Supabase Realtime` | `6ixfalls/supabase` (`realtime/`)                | غير مستخدم في التطبيق حالياً                                                                     |
| `Supabase Studio`   | `6ixfalls/supabase` (`studio/`)                  | لوحة الإدارة على جذر نطاق Envoy (Basic Auth: `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` في Envoy) |
| **`functions`**     | **هذا المستودع** — `deploy/functions/Dockerfile` | Edge Functions تحت Node (منفذ 9000، النطاق الخاص `functions.railway.internal`)                   |

**عنوان الـ API العام (SUPABASE_URL):** `https://envoy-production-eebb.up.railway.app`

### 1.1 المفاتيح — من `ROOT_SECRET` واحد

القالب لا يخزّن `JWT_SECRET` ولا مفاتيح `anon`/`service_role` كمتغيرات: كل خدمة تأخذ `ROOT_SECRET`
ويشتق مدخلها (`supabase-secrets --service <name>`) المفاتيح نفسها منه (HKDF، الإصدار
`supabase-secrets/v1`). خدمة `functions` تأخذ `ROOT_SECRET = ${{Envoy.ROOT_SECRET}}` وتستعمل المُشتقّ نفسه
(`--service functions` ⟵ `JWT_SECRET`، `SUPABASE_JWKS`، `SUPABASE_ANON_KEY`، `SUPABASE_SERVICE_ROLE_KEY`).

- للحصول على المفتاحين (للواجهة وأسرار CI): Studio ← Project Settings ← API، أو صفحة مولّد القالب
  `https://6ixfalls.github.io/supabase/` بإدخال `ROOT_SECRET` محلياً.
- **تغيير `ROOT_SECRET` يدوّر كل المفاتيح** ويجب أن يكون متطابقاً في كل الخدمات التي تحمله (Postgres،
  Gotrue Auth، Postgrest، Storage، Realtime، Studio، Supavisor، Envoy) — و`functions` تتبعه بالمرجع.
- رموز المستخدمين يوقّعها GoTrue بالمفتاح غير المتماثل (ES256) أو بالسر المشترك (HS256)؛ PostgREST و
  `functions` يقبلان الاثنين (`JWT_JWKS`).

## 2. المتغيرات (الأسماء فقط)

### 2.1 ما ضبطناه فوق القالب

| الخدمة             | المتغير                                                                                                           | القيمة / الغرض                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Gotrue Auth`      | `GOTRUE_SITE_URL`                                                                                                 | `https://map.istiqama.om` (من القالب)                                                               |
|                    | `GOTRUE_DISABLE_SIGNUP`                                                                                           | `true` — المستخدمون يُنشَؤون من دالة `admin` فقط                                                    |
|                    | `GOTRUE_URI_ALLOW_LIST`                                                                                           | `https://map.istiqama.om/**`                                                                        |
|                    | `GOTRUE_MFA_TOTP_ENROLL_ENABLED`، `GOTRUE_MFA_TOTP_VERIFY_ENABLED`، `GOTRUE_MFA_MAX_ENROLLED_FACTORS`             | `true`، `true`، `10` (`config.toml [auth.mfa]`)                                                     |
|                    | `GOTRUE_JWT_EXP`                                                                                                  | `3600`                                                                                              |
|                    | `GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED`، `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL`                  | `true`، `10`                                                                                        |
|                    | `GOTRUE_EXTERNAL_EMAIL_ENABLED`، `GOTRUE_MAILER_AUTOCONFIRM`، `GOTRUE_MAILER_OTP_EXP`، `GOTRUE_MAILER_OTP_LENGTH` | `true`، `false`، `600`، `6`                                                                         |
| `Postgrest`        | `PGRST_DB_SCHEMAS`، `PGRST_DB_EXTRA_SEARCH_PATH`، `PGRST_DB_MAX_ROWS`                                             | `public`، `public,extensions`، `1000`                                                               |
| `Supabase Storage` | `UPLOAD_FILE_SIZE_LIMIT`، `UPLOAD_FILE_SIZE_LIMIT_STANDARD`                                                       | `104857600` (100 MiB = حد `tiles`)؛ حدود الحاويات في الترحيل 0015: `photos` 5 MiB، `imports` 25 MiB |
| `Envoy`            | `FUNCTIONS_HOST`                                                                                                  | `${{functions.RAILWAY_PRIVATE_DOMAIN}}` (منفذ 9000 ثابت في القالب)                                  |
| `functions`        | `ROOT_SECRET`                                                                                                     | `${{Envoy.ROOT_SECRET}}`                                                                            |
|                    | `SUPABASE_URL`                                                                                                    | `http://${{Envoy.RAILWAY_PRIVATE_DOMAIN}}:8000` (داخلي)                                             |
|                    | `APP_ORIGINS`                                                                                                     | `https://map.istiqama.om`                                                                           |
|                    | `OTP_PROVIDER`                                                                                                    | `fake` (القرار رقم 4 مفتوح)                                                                         |
|                    | `PORT`، `RAILWAY_DOCKERFILE_PATH`، `PURGE_PHOTOS_UTC`                                                             | `9000`، `deploy/functions/Dockerfile`، `01:30`                                                      |

ملاحظات:

- **تصدير كبير:** README الدوال يقدّر تصدير 100,000 مشروع CSV بـ 65–80 MB؛ الحد العام 100 MiB يكفيه. إن
  كبرت البيانات ارفع `UPLOAD_FILE_SIZE_LIMIT*` (حاوية `exports` بلا حد خاص).
- **CORS:** Envoy في القالب يسمح بكل الأصول (`allow_origin_string_match: .*`) ولا متغير لتقييده؛ دوالنا
  تقيّد بـ `APP_ORIGINS`. الحماية الفعلية هي المفاتيح وRLS، لا CORS. تقييد Envoy يحتاج fork للقالب.
- **مهلات الأدوار (`statement_timeout`):** تُضبط في القاعدة لا في المتغيرات — §3.3.

### 2.2 ما على المالك ملؤه: SMTP (يتطلب خطة Railway Pro للإرسال الخارجي)

على خدمة `Gotrue Auth`:
`GOTRUE_SMTP_HOST`، `GOTRUE_SMTP_PORT`، `GOTRUE_SMTP_USER`، `GOTRUE_SMTP_PASS`،
`GOTRUE_SMTP_ADMIN_EMAIL` (عنوان المرسل)، `GOTRUE_SMTP_SENDER_NAME` (مثلاً «خارطة مشاريع الاستقامة»).
اختياري: `GOTRUE_SMTP_MAX_FREQUENCY`، `GOTRUE_RATE_LIMIT_EMAIL_SENT`. دون SMTP يكتب GoTrue
«Noop mail client» ولا تُرسل رموز البريد ولا روابط الاستعادة.

## 3. القاعدة

### 3.1 الاتصال

- داخل Railway: `${{Postgres.DATABASE_URL}}` (الشبكة الخاصة).
- من جهاز: **TCP Proxy** على خدمة `Postgres` (موجود من القالب، المنفذ الداخلي 5432؛ القيمة
  `RAILWAY_TCP_PROXY_DOMAIN:RAILWAY_TCP_PROXY_PORT` في متغيرات الخدمة). للخدمة `Supavisor` TCP Proxy آخر.
  احذف أياً منهما إن لم يعد لازماً (Railway ← الخدمة ← Settings ← Networking).
- طبّق الترحيلات بالدور **`postgres`** (ليس `supabase_admin`) — هكذا تُملك الكائنات كما على Supabase
  (RUNBOOK §12). `.local/pg/bin/psql.exe` يكفي على Windows.

```bash
export DATABASE_URL='postgresql://postgres:<POSTGRES_PASSWORD>@<proxy-host>:<proxy-port>/postgres?sslmode=require'
PSQL=.local/pg/bin/psql.exe   # or psql
```

### 3.2 تطبيق الترحيلات (مثل `supabase db push`) — بلا بذرة تجريبية أبداً

`supabase/seed.staging.sql` **لا يُطبَّق على production**. السجل متوافق مع Supabase CLI
(`supabase_migrations.schema_migrations`)، فيمكن لاحقاً استعمال `supabase db push --db-url "$DATABASE_URL"`.

```bash
"$PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key, statements text[], name text);
SQL

for f in supabase/migrations/*.sql; do
  b=$(basename "$f" .sql); v=${b%%_*}; n=${b#*_}
  done_=$("$PSQL" "$DATABASE_URL" -At -c "select 1 from supabase_migrations.schema_migrations where version='$v'")
  [ "$done_" = 1 ] && continue
  echo "applying $b"
  "$PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -q \
    -f "$f" \
    -c "insert into supabase_migrations.schema_migrations(version, name) values ('$v', '$n')" || break
done
```

بعد أول تطبيق: `select public.refresh_reports();`

### 3.3 فحوص ما بعد التطبيق

```sql
-- roles / schemas / extensions the migrations rely on
select rolname from pg_roles where rolname in ('anon','authenticated','service_role','authenticator');
select nspname from pg_namespace where nspname in ('auth','storage','extensions','private');
select name, installed_version from pg_available_extensions
 where name in ('postgis','pg_trgm','unaccent','pgcrypto','pg_cron','pg_net','pgtap');
-- per-role statement timeouts (same as scripts/local-stack/supabase-shim.sql and hosted Supabase)
alter role anon          set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';
alter role authenticator set statement_timeout = '8s';
notify pgrst, 'reload config';
-- pg_cron must run in this database
show cron.database_name;              -- expected: postgres
select jobname, schedule from cron.job order by 1;   -- istiqama-refresh-reports */15, …
-- buckets from migration 0015
select id, public, file_size_limit from storage.buckets order by id;   -- exports, imports, photos, tiles
```

### 3.4 pgTAP على قاعدة مؤقتة منفصلة (لا على `postgres`)

```bash
"$PSQL" "$DATABASE_URL" -c 'create database imap_pgtap'
PGTAP_URL="${DATABASE_URL/\/postgres?/\/imap_pgtap?}"
# pgTAP: the image usually ships it; otherwise load it into the throw-away db only
"$PSQL" "$PGTAP_URL" -c 'create extension if not exists pgtap' \
  || "$PSQL" "$PGTAP_URL" -f .local/pg/share/extension/pgtap--1.3.4.sql
# apply the migrations to imap_pgtap (loop of §3.2 with $PGTAP_URL), then:
npm run test:db -- --url "$PGTAP_URL"
"$PSQL" "$DATABASE_URL" -c 'drop database imap_pgtap with (force)'
```

### 3.5 البيانات المرجعية (حقيقية فقط)

الترحيلات تُدخل الدول والقوائم والإعدادات. الحدود الإدارية:

```bash
npm run boundaries:import -- --offline --cache-dir .local/downloads/geoboundaries --database-url "$DATABASE_URL"
"$PSQL" "$DATABASE_URL" -c 'select public.refresh_reports()'
```

### 3.6 أول مدير (hq_admin) — بالبريد، يُنفَّذ مرة

أنشئ المستخدم أولاً (الاشتراك الذاتي معطّل): Studio ← Authentication ← Add user (بريد + كلمة مرور، مؤكَّد)،
أو `POST /auth/v1/admin/users` بمفتاح service. ثم بدور `postgres`:

```sql
\set admin_email 'someone@istiqama.om'
begin;
insert into public.profiles (id, full_name, preferred_language, active)
select u.id, coalesce(u.raw_user_meta_data->>'full_name', u.email), 'ar', true
  from auth.users u where lower(u.email) = lower(:'admin_email')
on conflict (id) do update set active = true, deleted_at = null;
insert into public.user_roles (user_id, role, scope_type, scope_id)
select u.id, 'hq_admin', 'global', null
  from auth.users u where lower(u.email) = lower(:'admin_email')
on conflict do nothing;
select p.id, p.full_name, r.role, r.scope_type
  from public.profiles p join public.user_roles r on r.user_id = p.id and r.deleted_at is null
  join auth.users u on u.id = p.id where lower(u.email) = lower(:'admin_email');
commit;
```

بعدها ينشئ هذا المدير بقية المستخدمين من لوحة الإدارة (دالة `admin` ← `create_user`)، ويُطلب منه تفعيل
TOTP (العمليات الحساسة تتطلب `aal2`).

## 4. Edge Functions — الخدمة `functions`

- `deploy/functions/server.ts`: خادم Node يحمّل `supabase/functions/<name>/index.ts` بمحمّل البوابة المحلية
  (`scripts/local-stack/gateway/functions.ts`)، ويتحقق من الـ JWT قبل تشغيل الدالة (HS256 بـ `JWT_SECRET`
  أو ES256 بـ `SUPABASE_JWKS`) كما يفعل Edge Runtime مع `verify_jwt = true`؛ مستثنى: `otp-hook`
  (`FUNCTIONS_NO_VERIFY_JWT`). صحة الخدمة: `GET /_health`.
- Envoy يوجّه `/functions/v1/<name>/…` إلى `functions.railway.internal:9000/<name>/…` (مهلة 150 ث).
- `deploy/functions/Dockerfile` (سياق البناء = جذر المستودع)، يبني من GitHub `drsaleh-istiqama/istiqama-map`
  فرع `main`؛ يعاد البناء تلقائياً عند تغيّر `supabase/functions/**` أو `deploy/functions/**` أو ملفات المحمّل.
- **الجدولة:** `refresh_reports` كل 15 دقيقة وبقية المهام عبر `pg_cron` من الترحيلين 0058/0070.
  `purge-photos` يومياً `PURGE_PHOTOS_UTC` (افتراضياً 01:30 UTC) داخل خدمة `functions` بمفتاح service
  (نسخة واحدة — لا تزد `numReplicas` دون نقل هذه المهمة إلى خدمة cron).

## 5. الخريطة الأساس (PMTiles)

```bash
SUPABASE_URL=https://envoy-production-eebb.up.railway.app SUPABASE_SERVICE_ROLE_KEY=<service key> \
  npx tsx scripts/build-pmtiles/upload-dev.ts --file .local/tiles/east-africa-z9.pmtiles --object basemap/east-africa.pmtiles
# check: public bucket + HTTP Range
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-16383' \
  https://envoy-production-eebb.up.railway.app/storage/v1/object/public/tiles/basemap/east-africa.pmtiles   # 206
```

`VITE_TILES_URL` للواجهة = الرابط العام أعلاه.

## 6. النطاق المخصص `api-map.istiqama.om` (لاحقاً)

1. Railway ← `Envoy` ← Settings ← Networking ← Custom Domain ← `api-map.istiqama.om` (أو أداة
   `generate-domain` مع `domain`) — يعطي سجل CNAME (+ TXT للتحقق) يُضاف في DNS لـ `istiqama.om`
   (في Cloudflare: CNAME «DNS only» حتى تصدر الشهادة).
2. بعد التحقق حدّث: `API_EXTERNAL_URL` (Gotrue Auth)، `SUPABASE_PUBLIC_URL` (Studio)، `STORAGE_PUBLIC_URL`
   (Storage) إن كانت تشير إلى نطاق Railway، ثم `VITE_SUPABASE_URL`/`VITE_TILES_URL` وأسرار CI، وأعد بناء الواجهة.

## 7. النسخ الاحتياطي (لا PITR في Railway)

1. **Railway Volume Backups** لحجم `postgres-volume`: Railway ← Postgres ← Backups ← جدول يومي + أسبوعي
   (لقطات على مستوى القرص، استرجاع سريع للخدمة نفسها).
2. **تفريغ منطقي يومي إلى تخزين منفصل** (RUNBOOK §4.3): `scripts/backup/dump.ts` بـ `DATABASE_URL`
   الإنتاج عبر TCP Proxy (أو خدمة cron في Railway)، والوجهة خارج Railway (Cloudflare R2 / حساب آخر).
   RPO = 24 ساعة.
3. **الصور:** `scripts/backup/replicate-photos.sh` من Railway Bucket `S3` إلى التخزين المنفصل (RUNBOOK §5).
4. اختبار استرجاع ربع سنوي إلى مشروع Railway مؤقت (RUNBOOK §7–8؛ `private.sync_rebase()` يعمل بلا
   superuser بعد الترحيل 0074).

## 8. CI/CD — أسرار GitHub (`.github/workflows/deploy.yml`) مُكيَّفة لـ Railway

`deploy.yml` مكتوب لـ Supabase Cloud (`supabase db push --project-ref` + `supabase functions deploy`). على
Railway:

| النوع    | الاسم                                            | القيمة                                                                            |
| -------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| secret   | `DATABASE_URL`                                   | رابط Postgres عبر TCP Proxy (`sslmode=require`) للترحيلات                         |
| secret   | `VITE_SUPABASE_ANON_KEY` (= `SUPABASE_ANON_KEY`) | مفتاح anon                                                                        |
| secret   | `SUPABASE_SERVICE_ROLE_KEY`                      | لرفع الخرائط/الدخان فقط — لا يدخل الواجهة                                         |
| secret   | `CLOUDFLARE_API_TOKEN`، `CLOUDFLARE_ACCOUNT_ID`  | Cloudflare Pages                                                                  |
| variable | `VITE_SUPABASE_URL` (= `SUPABASE_URL`)           | `https://envoy-production-eebb.up.railway.app` (أو `https://api-map.istiqama.om`) |
| variable | `VITE_TILES_URL`                                 | رابط `tiles/basemap/east-africa.pmtiles` العام                                    |
| variable | `WEB_HOSTING`، `WEB_PROJECT_NAME`، `APP_ORIGINS` | `cloudflare-pages`، اسم مشروع Pages، `https://map.istiqama.om`                    |

التعديلات المطلوبة في الـ workflow (للقائد): خطوة الترحيلات تصبح `supabase db push --db-url "$DATABASE_URL"`
(أو حلقة §3.2)؛ خطوة «Edge Functions deploy» تُحذف — Railway يبني `functions` من `main` تلقائياً؛ أسرار
`SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_REF`/`SUPABASE_DB_PASSWORD` لا تلزم.

## 9. فحص دخان بعد كل نشر

1. `GET /auth/v1/health` بـ `apikey` = 200؛ `GET /rest/v1/` بلا مفتاح = 401.
2. مستخدم مؤقت عبر `POST /auth/v1/admin/users` (service) ⟵ `POST /auth/v1/token?grant_type=password` ⟵
   `POST /rest/v1/rpc/my_context` ⟵ `POST /functions/v1/sync_pull` يعيد الصفوف المرجعية ⟵
   `GET /functions/v1/tiles/4/9/8` (200/204) ⟵ Range على الخريطة = 206.
3. احذف المستخدم المؤقت (`DELETE /auth/v1/admin/users/<id>`) وصفوفه (`profiles`، `user_roles`، `devices`).
