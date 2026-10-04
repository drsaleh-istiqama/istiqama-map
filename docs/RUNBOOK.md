# دليل التشغيل (RUNBOOK) — خارطة مشاريع الاستقامة v3

> المرجع: أمر التنفيذ `docs/BRIEF.md` §1 و§11 ومعيار القبول 8 («استرجاع النسخة الاحتياطية مُجرّب
> وموثّق»). هذا الدليل لمن يشغّل النظام: النشر، والترحيلات، والنسخ الاحتياطي والاسترجاع، والحوادث،
> والمراقبة. الأوامر بالإنجليزية كما تُكتب في الطرفية؛ الشرح بالعربية.
>
> **قرار المالك رقم 1 (حساب الاستضافة والمنطقة) لم يُتخذ بعد** (`docs/OWNER_DECISIONS.md`). كل ما
> يتعلق بالسحابة هنا مكتوب بمتغيرات (`<project-ref>`، `BACKUP_RCLONE_TARGET`…) ولا يحوي مفتاحاً حقيقياً.
> الأجزاء المعلَّمة **⏳ بانتظار المالك** لا تُنفَّذ قبل قراره.

## المحتويات

1. [البيئات](#1-البيئات)
2. [النشر](#2-النشر)
3. [الترحيلات](#3-الترحيلات)
4. [النسخ الاحتياطي — الطبقات الأربع](#4-النسخ-الاحتياطي--الطبقات-الأربع)
5. [النسخ المتماثل للصور](#5-النسخ-المتماثل-للصور)
6. [سياسة الاحتفاظ](#6-سياسة-الاحتفاظ)
7. [إجراء الاسترجاع](#7-إجراء-الاسترجاع)
8. [اختبار الاسترجاع — 2026-10-04](#8-اختبار-الاسترجاع--2026-10-04)
9. [أدلة الحوادث](#9-أدلة-الحوادث)
10. [المراقبة](#10-المراقبة)
11. [مراجع سريعة](#11-مراجع-سريعة)
12. [Supabase compatibility notes — ملاحظات التوافق مع Supabase الحقيقي](#12-supabase-compatibility-notes--ملاحظات-التوافق-مع-supabase-الحقيقي)

### الأهداف

| المقياس                       | الهدف                        | كيف يتحقق                                                                      |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| RPO (أقصى فقد مقبول للبيانات) | دقائق مع PITR؛ 24 ساعة بدونه | PITR (§4.2)؛ التفريغ اليومي (§4.3) شبكة أمان ثانية                             |
| RTO (أقصى زمن توقف)           | ساعتان                       | الاسترجاع إلى مشروع جديد (§7) — قاعدة الاختبار استُرجعت في 6–26 ثانية          |
| فقد بيانات الأجهزة            | صفر                          | الأجهزة تحتفظ بـ `outbox` وتعيد الإرسال؛ `sync_push` متساوي القوى (idempotent) |

---

## 1. البيئات

| البيئة                 | قاعدة البيانات والخدمات                                                                                                                       | الواجهة                       | من ينشر                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| `local` (جهاز المطوّر) | PostgreSQL 17 + PostGIS محمولة على `127.0.0.1:54322`، وPostgREST حقيقي على 54323، وبوابة تحاكي Supabase على 54321 (`docs/ARCHITECTURE.md` §1) | `npm run dev` على 5173        | المطوّر                                             |
| `staging`              | مشروع Supabase مستقل + البيانات التجريبية (`supabase/seed.staging.sql`)                                                                       | استضافة ثابتة (`WEB_HOSTING`) | تلقائياً بعد نجاح CI على `main`                     |
| `production`           | مشروع Supabase مستقل، **بلا بيانات تجريبية**، PITR مفعّل                                                                                      | استضافة ثابتة                 | وسم `v*` + موافقة المراجِعين في GitHub Environments |

قواعد ثابتة:

- مفتاح `service_role` لا يُوضع في الواجهة أبداً؛ يعيش في أسرار Edge Functions وأسرار CI فقط.
- لكل بيئة أسرارها في GitHub → Settings → Environments (القائمة في رأس `.github/workflows/deploy.yml`).
- قاعدة `local` المسماة `istiqama` يملكها الفريق كله: التجارب الثقيلة في قواعد خاصة `imap_<label>`.

```bash
npm run stack:start                    # local: PostgreSQL + PostgREST + gateway
npm run stack:status
npm run db:reset -- --db imap_x        # private local database (shim + migrations + staging seed)
```

## 2. النشر

النشر كله في `.github/workflows/deploy.yml`: `supabase db push` (الترحيلات)، ثم نشر Edge Functions
وأسرارها، ثم بناء الواجهة بقيم البيئة، ثم رفعها.

```bash
# staging: automatic after a green CI run on main, or manually
gh workflow run deploy.yml -f environment=staging

# production: tag (needs the reviewers' approval in the "production" environment)
git tag v3.0.1 && git push origin v3.0.1
```

قبل كل نشر للإنتاج:

1. CI أخضر (Vitest، pgTAP، Playwright، lint، typecheck).
2. **نسخة احتياطية يدوية فورية** إن كان في الإصدار ترحيل يغيّر بيانات (§4.3):
   `node --import tsx scripts/backup/dump.ts --db-url "$BACKUP_DATABASE_URL" --upload`.
3. رقم الإصدار من `package.json` وحده (يُحقن وقت البناء).

**التراجع (rollback):** الواجهة — أعد نشر الوسم السابق (`gh workflow run deploy.yml` على الوسم
السابق). قاعدة البيانات — الترحيلات لا تُعكس بحذف ملفات؛ اكتب ترحيلاً جديداً يصحّح، أو استرجع (§7)
إن أفسد الترحيل البيانات.

## 3. الترحيلات

- كل تغيير في المخطط ملف جديد في `supabase/migrations/` باسم `20261003<NNNN>00_name.sql`
  (`docs/ARCHITECTURE.md` Appendix A.2). **لا يُعدَّل ملف طُبِّق على أي بيئة.**
- كل جدول أو دالة جديدة في `public` تُمنح تلقائياً لـ `anon` و`authenticated` على Supabase؛ كل ترحيل
  يسحب صراحةً ما لا يجب أن يصل إليه (Appendix A.1). pgTAP يتحقق.
- الترحيل يجب أن ينجح على Supabase الحقيقي؛ ما يخص البيئة المحلية وحدها في
  `scripts/local-stack/supabase-shim.sql`.

```bash
npm run db:reset -- --db imap_mig --no-seed               # apply every migration to a fresh database
npm run test:db  -- --db imap_mig                         # full pgTAP suite
supabase db push --project-ref <project-ref> --dry-run    # what would be applied (CI does the real push)
supabase migration list --project-ref <project-ref>       # applied vs local
```

بعد أي تغيير في `private.sync_tables`: `select private.sync_refresh();` (`docs/contracts/sync.md` §8).

---

## 4. النسخ الاحتياطي — الطبقات الأربع

| الطبقة                                              | ماذا تحمي                                    | أين                    | الاحتفاظ                    | الحالة                    |
| --------------------------------------------------- | -------------------------------------------- | ---------------------- | --------------------------- | ------------------------- |
| 1. PITR                                             | القاعدة كاملة حتى الثانية                    | داخل Supabase          | 7 أيام (قابلة لـ 14/28)     | ⏳ بانتظار المالك (§4.2)  |
| 2. النسخ اليومية المدمجة في Supabase                | القاعدة (لقطة يومية)                         | داخل Supabase          | 7 أيام في خطة Pro           | تلقائية مع خطة Pro        |
| 3. تفريغ منطقي يومي (`scripts/backup/dump.ts`)      | القاعدة + بيانات Auth/Storage + سجل الكائنات | **حساب أو منطقة أخرى** | 35 يوماً يومياً + 12 شهرياً | السكربت مُختبر؛ الوجهة ⏳ |
| 4. نسخ الصور (`scripts/backup/replicate-photos.sh`) | ملفات حاوية `photos`                         | **حساب أو منطقة أخرى** | قفل كائنات 35 يوماً         | السكربت جاهز؛ الوجهة ⏳   |

الطبقتان 1 و2 لا تكفيان وحدهما: لو فُقد حساب Supabase نفسه (اختراق، حذف المشروع، مشكلة فوترة)
تضيعان معه. لذلك الطبقتان 3 و4 في حساب آخر وفي منطقة أخرى، والكتابة إليهما بمفتاح لا يملك صلاحية
الحذف (قفل الكائنات / object lock).

### 4.1 ما الذي يحويه التفريغ المنطقي

مجلد واحد لكل نسخة باسم الوقت بتوقيت UTC (`20261004T185108Z/`):

| الملف                   | المحتوى                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.dump`              | `pg_dump -Fc` لمخططَي `public` و`private` (البنية + البيانات + الصلاحيات)، ومخطط `supabase_migrations` إن وُجد                                                                                           |
| `platform-data.dump`    | **بيانات** جداول المنصة التي تخصّنا فقط: `auth.users`، `auth.identities`، `auth.mfa_factors`، `storage.buckets`، `storage.objects`. لا الجلسات ولا رموز التحديث: بعد الكارثة يسجّل الجميع الدخول من جديد |
| `platform-schema.dump`  | بنية `auth` و`storage` — يُستعمل منها عند الاسترجاع **سياسات `storage.objects` فقط** (ترحيل 0015)                                                                                                        |
| `storage-manifest.json` | كل كائن في التخزين (الحاوية، الاسم، الحجم، النوع)، ومسارات الصور المشار إليها من `project_photos` وما ليس له كائن منها؛ ومع `--storage-dir` بصمة sha256 لكل ملف                                          |
| `manifest.json`         | إصدار التطبيق والخادم، الإضافات (extensions)، **عدد الصفوف الدقيق لكل جدول**، أعداد Materialized Views، **صلاحيات كل كائن** (264 كائناً)، `sync_epoch`، بصمة sha256 لكل ملف، والأزمنة                    |

كل ذلك يُقرأ في **لقطة واحدة** (`pg_export_snapshot` + `pg_dump --snapshot`): الأعداد في
`manifest.json` تصف بالضبط ما في الملفات. العملية قراءة فقط على المصدر.

### 4.2 PITR على Supabase ⏳ بانتظار المالك (القرار رقم 1)

**المتطلبات (Supabase Cloud):** خطة **Pro** فأعلى + إضافة **Point in Time Recovery** المدفوعة،
وحجم حوسبة **Small فأكبر**. الاحتفاظ 7 أو 14 أو 28 يوماً (السعر يزيد بالمدة). مع تفعيل PITR تحل
محل النسخ اليومية المدمجة.

**التفعيل (بعد قرار المالك):**

1. Dashboard → Project Settings → Add-ons → Point in Time Recovery → اختر مدة الاحتفاظ (نوصي بـ 14 يوماً).
2. تأكد من حجم الحوسبة: Project Settings → Compute and Disk → Small أو أكبر.
3. انتظر أول نسخة أساسية (تظهر في Database → Backups → Point in Time).
4. سجّل في هذا الملف: تاريخ التفعيل، مدة الاحتفاظ، أقدم نقطة متاحة.

**الاستضافة الذاتية (إن اختارها المالك):** PITR مسؤولية المشغّل — أرشفة WAL مستمرة بأداة مثل
WAL-G أو pgBackRest إلى تخزين S3 في حساب آخر، مع نسخة أساسية يومية، واختبار استرجاع شهري.

**الاسترجاع بـ PITR:** Database → Backups → Point in Time → اختر الثانية المطلوبة → Restore.
الاسترجاع **في المكان نفسه** ويوقف المشروع دقائق إلى ساعات حسب الحجم. بعده:

```sql
-- PITR keeps the xid counter, so sync_rebase() is NOT needed (docs/contracts/sync.md §8).
-- But devices that synced AFTER the restore point hold cursors "from the future" of the
-- rewound counter. sync_pull resets such a cursor while it is ahead (lo > current xmin);
-- rotating the epoch closes the window in which the counter could overtake an old cursor:
select private.sync_rotate_epoch();
```

ثم اتبع §7.5 (ما بعد الاسترجاع).

### 4.3 التفريغ المنطقي اليومي — `scripts/backup/dump.ts`

```bash
# production (CI scheduled job or an operator machine with the PostgreSQL 15+ client tools)
export BACKUP_DATABASE_URL='postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres'
export BACKUP_RCLONE_TARGET='istiqama-offsite-crypt:db/production'     # placeholder, see below
node --import tsx scripts/backup/dump.ts --out /var/backups/istiqama --upload

# local (development stack)
node --import tsx scripts/backup/dump.ts --storage-dir .local/storage          # → .local/backups/<stamp>/
```

ملاحظات:

- استعمل **الاتصال المباشر** (`db.<project-ref>.supabase.co:5432`) لا الـ pooler: اللقطة المصدَّرة لا
  تعيش عبر pooler في وضع transaction. إن تعذّر الاتصال المباشر: `--no-snapshot` (الأعداد قد تختلف
  قليلاً عن الملفات إن كانت هناك كتابة أثناء التفريغ).
- إصدار `pg_dump` يجب أن يكون **مساوياً أو أحدث** من إصدار الخادم. المسار: `$PG_BIN` ثم
  `.local/pg/bin` ثم `PATH`.
- **الرفع (placeholder):** `--upload` ينفّذ `rclone copy --immutable` ثم `rclone check` إلى
  `$BACKUP_RCLONE_TARGET`. الوجهة يقرّرها المالك: حاوية S3-compatible في **حساب آخر ومنطقة أخرى**
  غير حساب Supabase، مع versioning وobject lock (compliance، 35 يوماً)، ويُفضَّل remote من نوع
  `crypt` في rclone فوقها (تشفير من جهة العميل: النسخة تحوي رواتب وبيانات مجتمعية مقيّدة). مفتاح
  الكتابة لا يملك صلاحية الحذف. إن لم يُضبط المتغير يطبع السكربت `upload skipped` ولا يفشل.
- **الجدولة المقترحة** (GitHub Actions، ملف لم يُنشأ بعد لأن الوجهة غير محددة):

```yaml
# .github/workflows/backup.yml (proposal — add once the owner chose the target)
on: { schedule: [{ cron: '30 23 * * *' }], workflow_dispatch: {} } # 02:30 East Africa
jobs:
  dump:
    runs-on: ubuntu-24.04
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: npm }
      - run: npm ci
      - run: sudo apt-get install -y postgresql-client-17 rclone
      - run: node --import tsx scripts/backup/dump.ts --out "$RUNNER_TEMP/backups" --upload
        env:
          PG_BIN: /usr/lib/postgresql/17/bin
          BACKUP_DATABASE_URL: ${{ secrets.BACKUP_DATABASE_URL }}
          BACKUP_RCLONE_TARGET: ${{ vars.BACKUP_RCLONE_TARGET }}
          RCLONE_CONFIG: ${{ secrets.RCLONE_CONFIG_PATH }}
```

- **التنبيه:** فشل المهمة يرسل بريد GitHub للمسؤولين؛ ويُراجَع شهرياً أن آخر مجلد في الوجهة عمره
  أقل من 26 ساعة (`rclone lsf "$BACKUP_RCLONE_TARGET" | tail -1`).

## 5. النسخ المتماثل للصور

الصور في حاوية `photos` (المسار `projects/<country>/<project_id>/<photo_id>_{full,thumb}.webp`).
النسخ أحادي الاتجاه إلى حاوية S3-compatible في حساب ومنطقة أخريين، **كل ساعة**:

```bash
PHOTOS_SOURCE=istiqama-supabase:photos PHOTOS_TARGET=istiqama-offsite:istiqama-photos \
  sh scripts/backup/replicate-photos.sh            # copy new objects + verify
sh scripts/backup/replicate-photos.sh --check      # verify only
sh scripts/backup/replicate-photos.sh --dry-run
```

- مصدر الـ S3 لمشروع Supabase: Dashboard → Storage → S3 Connection (مفاتيح S3 خاصة بالتخزين). الـ
  remotes تُعرَّف خارج المستودع (`rclone.conf` أو أسرار CI). ⏳ الوجهة بانتظار المالك.
- `copy` لا `sync`: حذف صورة من المصدر (الاحتفاظ 90 يوماً) لا يحذفها من النسخة؛ النسخة تنتهي
  بقاعدة دورة حياة خاصة بها (§6).
- `storage-manifest.json` في كل تفريغ يذكر الكائنات المتوقعة؛ مقارنته بالنسخة تكشف النقص.

## 6. سياسة الاحتفاظ

| ماذا                                         | المدة                                                | الآلية                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| صور محذوفة حذفاً ناعماً (أو صور مشروع محذوف) | تُزال من التخزين بعد **90 يوماً**                    | Edge Function `purge-photos` (مفتاح الخدمة): `photos_to_purge` → حذف الكائنين → `mark_photos_purged`. الصف لا يُحذف أبداً (`purged_at`) |
| ملفات التصدير                                | 30 يوماً                                             | `private.expire_export_jobs()` (pg_cron يومياً 02:23) ثم `purge-photos` يحذف الملف                                                      |
| `sync_applied_ops` وسجل نقل النطاق           | 180 يوماً                                            | `private.sync_prune()` يومياً (pg_cron، ترحيل 0070)                                                                                     |
| سجل العمليات المرفوضة                        | 30 يوماً                                             | `private.sync_rejections_cleanup()` يومياً 02:53                                                                                        |
| `audit_log`                                  | لا يُقلَّم أقصر من أطول فترة انقطاع لجهاز            | شرط كشف التعارض (`sync.md` §8)                                                                                                          |
| التفريغ المنطقي                              | 35 يوماً يومياً + أول نسخة من كل شهر 12 شهراً        | قاعدة دورة حياة في حاوية الوجهة                                                                                                         |
| نسخة الصور                                   | الكائن المحذوف من المصدر يبقى 35 يوماً بعد آخر تعديل | قاعدة دورة حياة + object lock                                                                                                           |

**جدولة `purge-photos` في الإنتاج** (لا يجدولها أي ترحيل لأنها تحتاج التخزين): Dashboard →
Integrations → Cron → job يومي `0 1 * * *` بنوع «Supabase Edge Function» → `purge-photos`، بترويسة
`Authorization: Bearer <service_role>` من Vault. محلياً تستدعيها البوابة كل 24 ساعة
(`PURGE_PHOTOS_EVERY_HOURS`). التحقق يدوياً:

```bash
curl -fsS -X POST "https://<project-ref>.supabase.co/functions/v1/purge-photos" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H 'content-type: application/json' \
  -d '{"limit": 500, "max_batches": 20}'
# → { "photos": { "marked", "objects_removed", "batches", "more" }, "exports": {…}, "duration_ms" }
```

---

## 7. إجراء الاسترجاع

اختر الطريق:

| الحالة                                                             | الطريق                                       |
| ------------------------------------------------------------------ | -------------------------------------------- |
| خطأ بشري أو ترحيل أفسد بيانات، والمشروع سليم، وPITR مفعّل          | PITR إلى الثانية التي قبل الخطأ (§4.2)       |
| المشروع أو الحساب فُقد، أو لا PITR، أو المطلوب نسخة جانبية للتحقيق | **استرجاع منطقي إلى مشروع جديد** (هذا القسم) |
| صور مفقودة فقط                                                     | §7.4                                         |

### 7.1 قبل البدء

1. أعلن الحادثة (§9) وأوقف الكتابة إن أمكن: الأجهزة تعمل دون اتصال وتحتفظ بـ `outbox`، فلا يضيع
   عمل الميدان أثناء التوقف.
2. اختر النسخة: أحدث مجلد في الوجهة سابق للحادثة. انسخه محلياً:
   `rclone copy "$BACKUP_RCLONE_TARGET/<stamp>" ./restore/<stamp>`.
3. جهّز **مشروع Supabase جديداً فارغاً** في المنطقة المقررة، بإصدار Postgres مساوٍ أو أحدث من
   `manifest.json → server_version`. لا تسترجع فوق مشروع فيه بيانات.

### 7.2 الاسترجاع

```bash
export RESTORE_DATABASE_URL='postgresql://postgres:<password>@db.<new-ref>.supabase.co:5432/postgres'
node --import tsx scripts/backup/restore.ts --from ./restore/<stamp> --target-url "$RESTORE_DATABASE_URL" --yes
```

ينفّذ السكربت بالترتيب ويتوقف عند أول خطأ:

| #   | الخطوة                                                                                                                                                                               | لماذا                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | يتحقق من sha256 كل ملف مقابل `manifest.json`                                                                                                                                         | نسخة تالفة تُرفض قبل لمس القاعدة                                                                                             |
| 2   | (محلياً فقط) ينشئ القاعدة ويطبّق `supabase-shim.sql`                                                                                                                                 | على Supabase المنصة توفّر الأدوار و`auth` و`storage`                                                                         |
| 3   | ينشئ الإضافات المذكورة في الـ manifest (`postgis`، `pg_trgm`، `unaccent`، `pgcrypto`، `uuid-ossp`) في مخطط `extensions`                                                              | `app.dump` يشير إليها ولا يحويها                                                                                             |
| 4   | بيانات المنصة: `pg_restore --data-only --single-transaction`                                                                                                                         | **أولاً**، لأن جداول التطبيق تشير إلى `auth.users`                                                                           |
| 5   | مخططات التطبيق: `pg_restore -j 4 -L <list>` مع تخطي المخططات الموجودة (`public`)                                                                                                     | البنية والبيانات والفهارس والقيود والـ triggers والسياسات؛ الـ Materialized Views تُحدَّث تلقائياً                           |
| 6   | **تطبيع الصلاحيات**: يُزيل كل منح لغير المالك أضافته «الصلاحيات الافتراضية» للهدف، ويعيد تشغيل مدخلات ACL وDEFAULT ACL من النسخة، ثم **يشترط تطابق صلاحيات كل كائن (264) مع المصدر** | بدونه يمنح الاسترجاع `anon` تنفيذ كل دوال الإدارة وكل الصلاحيات على كل الجداول — اكتُشف في اختبار 2026-10-04 (§8.3)          |
| 7   | سياسات `storage.objects` من `platform-schema.dump` (`--clean --if-exists`)                                                                                                           | ليست ضمن مخطط `public`                                                                                                       |
| 8   | `select private.sync_rebase();`                                                                                                                                                      | قيم `sync_xid` القديمة «في مستقبل» العنقود الجديد فلن تُسحب أبداً؛ الدالة تعيد ختم كل الصفوف وتدوّر الـ epoch (`sync.md` §8) |
| 9   | يتحقق أن لا صف قابل للمزامنة يحمل `sync_xid` أكبر من العدّاد الحالي                                                                                                                  | دليل أن خطوة 8 نجحت                                                                                                          |
| 10  | يقارن عدد صفوف كل جدول بالـ manifest (والـ Materialized Views بعدد استعلامها المعرِّف)                                                                                               | أي فرق ⇒ خروج برمز 2                                                                                                         |
| 11  | `notify pgrst, 'reload schema'`                                                                                                                                                      | PostgREST يقرأ المخطط الجديد                                                                                                 |

التقرير: `<from>/restore-report-<database>.json` (كل خطوة وزمنها والأعداد والفروق).

### 7.3 بعد استرجاع القاعدة

```bash
# 1. scheduled jobs (pg_cron state is not part of the app schemas); both files are idempotent
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261003005800_scheduled_jobs.sql
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261003007000_integration_hardening.sql
# 2. Supabase migration history: if the backup had no supabase_migrations schema, mark every
#    migration as applied so that the next deploy does not re-run them
supabase migration repair --status applied --project-ref <new-ref> $(ls supabase/migrations | sed 's/_.*//')
# 3. Edge Functions + secrets + Auth settings (SMTP/OTP provider, redirect URLs, MFA) of the new project
gh workflow run deploy.yml -f environment=production      # after pointing the environment secrets to <new-ref>
```

4. انسخ الصور إلى الحاوية `photos` في المشروع الجديد (§7.4)، ثم قارن مع `storage-manifest.json`.
5. حدّث `VITE_SUPABASE_URL` و`VITE_SUPABASE_ANON_KEY` (المشروع الجديد له مفاتيح جديدة) وأعد بناء
   الواجهة. **مفاتيح المشروع القديم تصبح بلا قيمة** — مفيد إن كان سبب الكارثة تسرّباً.
6. تحقق بعميل حقيقي (§7.5) قبل فتح النظام.

### 7.4 استرجاع الصور

```bash
# whole bucket from the replica into the new project's bucket
rclone copy istiqama-offsite:istiqama-photos istiqama-supabase-new:photos --checksum --transfers 8
# compare with the manifest of the restored backup (objects that should exist)
node -e "const m=require('./restore/<stamp>/storage-manifest.json');for(const o of m.objects)if(o.bucket_id==='photos')console.log(o.name)" > expected.txt
rclone lsf -R --files-only istiqama-supabase-new:photos | sort > actual.txt
comm -23 <(sort expected.txt) actual.txt          # missing objects
```

صف `project_photos` بلا كائن لا يكسر شيئاً: الواجهة تعرض بديلاً، والجهاز الذي التقط الصورة يعيد
رفعها إن كانت ما تزال في `photo_blobs` لديه.

### 7.5 ما بعد الاسترجاع — الأجهزة والمستخدمون

- `sync_rebase()` دوّر الـ epoch: كل جهاز يتصل يتلقى `reset: true` أو `scope_epoch` جديداً، فيمسح
  الجداول المتزامنة ويسحب نطاقه من جديد، **محتفظاً بـ `outbox` و`photo_blobs` و`drafts`**
  (`sync.md` §5.2) ثم يعيد إرسال ما لم يُؤكَّد. لا تكرار: `sync_push` يتعرف على `op_id` المكرر —
  **لكن** سجل `sync_applied_ops` المسترجَع يعود إلى وقت النسخة، فالعمليات التي أُكّدت بعد النسخة
  وضاعت مع الكارثة لا يعيدها الجهاز (حذفها من `outbox` بعد التأكيد). هذا هو فقد RPO؛ اطلب من
  المشرفين مراجعة سجلات تلك الفترة.
- الجلسات لم تُسترجع: كل مستخدم يسجّل الدخول من جديد (رابط بريد / OTP)، والمصادقة الثنائية
  (`auth.mfa_factors`) محفوظة.
- لوحة حالة المزامنة (`/admin/sync`) تُظهر الأجهزة التي عادت وما بقي لديها من عمليات معلّقة.
- اختبار العميل محلياً (نفس ما في §8): `node --import tsx scripts/backup/verify-client.ts --db <restored>`.

---

## 8. اختبار الاسترجاع — 2026-10-04

> نُفِّذ على جهاز التطوير (Windows 11، PostgreSQL 17.6 + PostGIS 3.6.2، Node 24)، على العنقود المحلي
> المشترك بينما كانت مهام أخرى تعمل عليه (مولّد بيانات الحمل في `imap_load`، Playwright)؛ الأزمنة
> لذلك أعلى مما على خادم مخصص. المصدر قاعدة `istiqama` الحية (بيانات staging)، والقراءة منها فقط.

### 8.1 الأمر الواحد

```bash
node --import tsx scripts/backup/drill.ts --source istiqama --target imap_restore --pgtap
# → .local/backup-drill/drill-<stamp>.json
```

وهو يشغّل الخطوات التالية بالترتيب (ويمكن تشغيل كل منها وحده):

```bash
node --import tsx scripts/backup/dump.ts --db-url postgresql://postgres@127.0.0.1:54322/istiqama --storage-dir .local/storage
node --import tsx scripts/backup/restore.ts --from .local/backups/<stamp> --db imap_restore
.local/pg/bin/pg_dump --schema-only -n public -n private -n auth -n storage ...   # source vs copy
node --import tsx scripts/backup/verify-client.ts --db imap_restore --source-db istiqama --gateway-port 54371 --postgrest-port 54373
npm run db:reset -- --db imap_restore_tap --no-seed --quiet && npm run test:db -- --db imap_restore_tap
psql -d postgres -c 'drop database imap_restore' -c 'drop database imap_restore_tap'
```

### 8.2 النتائج

التشغيل النهائي: `drill-20261004T190435Z` (22:04 بتوقيت مسقط، 2026-10-04) — **كل الخطوات نجحت،
رمز الخروج 0**. النسخة: `.local/backups/20261004T190441Z/` (غير مُودَعة).

| #   | الخطوة                                                                    | الزمن                         | النتيجة                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `dump.ts` من `istiqama` (قراءة فقط، لقطة واحدة)                           | 6.2 s (pg_dump للتطبيق 4.5 s) | 49 جدولاً، **21,402 صفاً**، 9 Materialized Views، 264 كائناً بصلاحياتها، 48 كائن تخزين (47 صورة + بلاطات)؛ `app.dump` 12.6 MB، `platform-data.dump` 10.7 kB، `platform-schema.dump` 45 kB                                                                                                                                                                                                               |
| 2   | `restore.ts` إلى `imap_restore` الجديدة                                   | 7.3 s                         | 1221 مدخلاً في `app.dump` (`-j 4`)؛ 214 مدخل ACL أعيد تشغيلها؛ **الصلاحيات: 264 كائناً، 0 فروق**؛ 10 سياسات `storage.objects`؛ `sync_rebase()` ختم 10,231 صفاً (`sync_xid` 128148) ودوّر الـ epoch (`fb3beef1…` ← `c68c2f78…`)؛ 0 صفوف بـ `sync_xid` مستقبلي؛ **أعداد الصفوف: 58 جدولاً وعرضاً، 0 فروق**                                                                                                |
| 3   | مقارنة المخطط (`pg_dump --schema-only` لـ public/private/auth/storage)    | 0.9 s                         | 22,352 سطراً في الجهتين؛ الفرق الوحيد قيد `map_packs_bbox_ck` بترتيب أقواس مختلف (المعنى نفسه — إعادة تحليل النص)                                                                                                                                                                                                                                                                                       |
| 4   | `verify-client.ts` على PostgREST + بوابة خاصين (المنفذان 54371/54373)     | 24.9 s                        | **17/17**: viewer دخل وسجّل جهازه وسحب 25 مشروعاً = ما تسمح به RLS في المصدر والنسخة (25 = 25)، بلا جداول أشخاص ولا مقيّدة؛ جامع البيانات في كينيا سحب 4 مشاريع = RLS، بلا مشروع من دولة أخرى ولا راتب، و`scope_epoch` يطابق `my_context()`؛ `sync_push` أُدرج متبرعاً (`applied`) وظهر في السحب التدريجي؛ بعد `sync_rebase()` ثانٍ أجاب المؤشر القديم بـ `reset: true` وepoch جديد وأعاد النطاق كاملاً |
| 5a  | قاعدة جديدة `imap_restore_tap` من الترحيلات **دون أي تعديل** (50 ترحيلاً) | 20.1 s                        | نجحت                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5b  | مجموعة pgTAP كاملة عليها                                                  | 25.5 s                        | **35/35 ملفاً، 2378 تحققاً، 0 فشل**                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | حذف `imap_restore` و`imap_restore_tap`                                    | 6.3 s                         | حُذفتا                                                                                                                                                                                                                                                                                                                                                                                                  |

زمن الاسترجاع الفعلي (الخطوة 2) 7 ثوانٍ لقاعدة 59 MB؛ في تشغيلات أخرى من اليوم نفسه 6.7–26 ثانية
حسب حمل العنقود المشترك. الخطوة 4 أطول لأنها تنتظر نافذة السحب (§8.3 بند 3): السحب الأول للـ viewer
اكتمل بعد 7 محاولات (~7 s) والسحب التدريجي بعد 13 محاولة (~12 s).

### 8.3 ما كشفه الاختبار (وأُصلح في السكربتات)

1. **تسرّب صلاحيات عند الاسترجاع (خطير، أُصلح):** `pg_dump` يكتب صلاحيات كل كائن فرقاً عن
   الافتراضي المدمج في PostgreSQL، لكن قاعدة الهدف (Supabase والـ shim) فيها
   `alter default privileges in schema public grant all … to anon, authenticated, service_role`،
   فيأخذ كل جدول ودالة يُنشئها `pg_restore` هذه المنح ولا يسحبها أحد. أول استرجاع تجريبي أنتج **123
   منحاً زائداً**، منها `EXECUTE` لـ `anon` على `admin_users` و`admin_set_role` و`admin_revoke_sessions`
   وكل دوال التصدير، و`ALL` لـ `anon` و`authenticated` على `projects`؛ وأعاد للـ `anon` صلاحياته
   الافتراضية في `public` التي سحبها أحد الترحيلات (فكل جدول يُنشأ لاحقاً سيُمنح له). الإصلاح:
   خطوة «تطبيع الصلاحيات» في `restore.ts` + مقارنة إلزامية مع صلاحيات المصدر المسجلة في
   `manifest.json` (264 كائناً، الفرق صفر وإلا يفشل الاسترجاع). **أي استرجاع يدوي بـ `pg_restore`
   خارج السكربت يقع في هذا الخطأ** — استعمل السكربت دائماً.
2. **Materialized Views:** `pg_restore` يعيد حسابها، فعددها بعد الاسترجاع يساوي استعلامها على
   البيانات المسترجَعة لا محتواها المخزَّن في المصدر إن لم يكن قد حُدِّث بعد آخر تغيير
   (`mv_project_clusters`: 413 مخزَّن مقابل 399 فعلي في محاولة سابقة). السكربت يسجل العددين ويقارن
   بالثاني.
3. **نافذة السحب على عنقود مشترك:** `sync_pull` لا يُرجع إلا الصفوف تحت أقدم معاملة مفتوحة في
   **العنقود كله** (`sync.md` §5.1). `sync_rebase()` يختم كل الصفوف برقم معاملته، فإن كانت هناك
   معاملة أقدم ما تزال مفتوحة (هنا مولّد الحمل في قاعدة أخرى، معاملات ~10 ثوانٍ متلاحقة) **يرجع
   السحب الأول فارغاً** حتى تنتهي — في إحدى المحاولات بقي فارغاً أكثر من دقيقتين. تأخير لا فقد: الصفوف
   تصل في الجولة التالية بعد أن تنتهي المعاملة. لذلك `verify-client.ts` يعيد المحاولة حتى يطابق
   السحب عدد ما تسمح به RLS. في الإنتاج: شغّل `sync_rebase()` والقاعدة هادئة (قبل فتح النظام
   للمستخدمين)، وتحقق قبلها من عدم وجود معاملات طويلة (الاستعلام في §9.3 بند 4).
   (تحقق جانبي: الجولة التدريجية بعد ذلك أرجعت 1902 صفاً مقابل 1899 في جولة أولى جديدة — الفرق 3
   سجلات محذوفة حذفاً ناعماً تُرسل في الجولات التدريجية فقط، كما في العقد؛ لا تكرار.)
4. صورة واحدة في بيانات staging مُشار إليها من `project_photos` بلا كائن في التخزين
   (`projects/TZ/18d83fd1-…/3dc9da05-…_full.webp`) — موجودة في المصدر قبل الاختبار، يذكرها
   `storage-manifest.json` في `referenced_photo_paths_without_object`.

### 8.4 ما لم يُختبر هنا

- الاسترجاع إلى مشروع Supabase سحابي حقيقي (`--target-url`)، وPITR، والرفع إلى وجهة خارجية
  ونسخ الصور بـ rclone — كلها ⏳ بانتظار القرار رقم 1 (لا حساب سحابي ولا rclone على جهاز التطوير).
  أول ما يُنفَّذ بعد القرار: تكرار §8.1 بـ `--target-url` على مشروع staging جديد وتسجيل النتيجة هنا.
- `supabase_migrations` غير موجود محلياً (لا Supabase CLI)؛ السكربت يفرّغه إن وُجد.

---

## 9. أدلة الحوادث

كل حادثة: سجّل الوقت، من اكتشفها، ما فُعل — في قناة الحوادث ثم في هذا الملف إن تغيّر الإجراء.

### 9.1 هاتف مفقود أو مسروق

1. لوحة الإدارة → المستخدمون → المستخدم → «إلغاء جلسات الجهاز» (أو SQL بصلاحية الإدارة):
   ```sql
   select public.admin_revoke_sessions('<user_id>', '<device_id>');   -- device blocked + all tokens dead
   select public.admin_revoke_sessions('<user_id>');                   -- every device of the user
   ```
   يحظر الجهاز، ويُبطل كل رمز صدر قبل الآن (الطلب التالي لا يرجع شيئاً)، ويحذف جلسات Auth ورموز
   التحديث في المعاملة نفسها (`people-admin.md` §6). الجهاز عند اتصاله التالي يمسح كل بياناته المحلية.
2. إن كانت شريحة الهاتف تستقبل رموز الدخول: عطّل الحساب `admin_set_user_active('<user_id>', false)`
   حتى تُستبدل الشريحة.
3. البيانات على الهاتف: محمية بقفل PIN بعد 15 دقيقة ورمز الدخول مشفّر بمفتاح مشتق من PIN؛ الجداول
   المقيّدة لا تبقى على أجهزة الميدان بعد رفعها.
4. عمليات لم تُرفع من الهاتف المفقود: ضائعة؛ `/admin/sync` يُظهر آخر عدد معلّق أبلغ عنه الجهاز
   (`pending_ops`، `pending_photos`) لتعرف حجم الفقد.
5. هاتف عُثر عليه: `select public.admin_restore_device('<user_id>', '<device_id>');` ثم تسجيل دخول جديد.

### 9.2 تسرّب مفتاح

| المفتاح                              | الإجراء                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service_role` / سر JWT              | Dashboard → Project Settings → API → **Generate new JWT secret** (يُبطل `anon` و`service_role` وكل الجلسات معاً) — أو مع مفاتيح API الجديدة: أنشئ مفتاح secret جديداً ثم احذف القديم. ثم حدّث أسرار Edge Functions (`supabase secrets set …`) وأسرار GitHub، وأعد النشر (§2)، وأعد بناء الواجهة بمفتاح `anon` الجديد |
| `anon`                               | علني بطبيعته ومحمي بـ RLS؛ يُدوَّر مع سر JWT إن لزم                                                                                                                                                                                                                                                                  |
| كلمة مرور قاعدة البيانات             | Project Settings → Database → Reset password؛ حدّث `SUPABASE_DB_PASSWORD` و`BACKUP_DATABASE_URL`                                                                                                                                                                                                                     |
| مفاتيح S3 للتخزين أو وجهة النسخ      | أبطلها من لوحة المزوّد، أنشئ جديدة، حدّث `rclone.conf` / أسرار CI؛ راجع سجل الوصول إلى الحاوية                                                                                                                                                                                                                       |
| `SENTRY_AUTH_TOKEN` / رموز الاستضافة | أبطلها وأنشئ جديدة؛ لا تمس البيانات                                                                                                                                                                                                                                                                                  |

بعد أي تدوير: `select private.sync_rotate_epoch();` غير لازم (المفاتيح لا تدخل في الـ epoch)، لكن
راجع `audit_log` و`restricted_access_log` للفترة بين التسرّب والتدوير.

### 9.3 مزامنة عالقة

الأعراض: المؤشر الدائم في التطبيق لا يصل إلى «متزامن»، أو `/admin/sync` يُظهر `pending_ops` ثابتاً.

1. `/admin/sync` (أو `select public.sync_status();` بحساب إداري): هل الجهاز `stale` (لم يُرَ منذ 7
   أيام)؟ هل `rejected_7d` > 0؟ هل `open_conflicts` > 0؟
2. **عمليات مرفوضة:** لا تُوقف الطابور (تذهب إلى `failed_ops` على الجهاز). السبب في
   `private.sync_rejections` (`code`): `out_of_scope` ⇒ صلاحيات المستخدم تغيّرت؛ `parent_missing` ⇒
   أصل حُذف؛ أخطاء قيود ⇒ بيانات غير صالحة يصححها المستخدم.
3. **تعارضات مفتوحة:** المشرف يحلّها من شاشة المراجعة (`resolve_conflict`).
4. **السحب لا يأتي بجديد:** معاملة طويلة مفتوحة تؤخر الجميع (§8.3):
   ```sql
   select pid, now() - xact_start as age, state, left(query, 80)
     from pg_stat_activity where backend_xid is not null or backend_xmin is not null
    order by xact_start limit 5;
   -- end it only if it is safe: select pg_terminate_backend(<pid>);
   ```
5. **جهاز في حلقة `reset`:** تأكد أن أدوار المستخدم لا تتبدل باستمرار. كحل أخير لجميع الأجهزة:
   `select private.sync_rotate_epoch();` (سحب كامل لكل جهاز — ثقيل؛ في وقت هادئ).
6. **رفع الصور عالق:** هل «Wi-Fi فقط» مفعّل على الجهاز؟ هل حد المعدل (rate limit) يرد 429؟ سجل
   Edge Functions / البوابة.

### 9.4 فقد بيانات (حذف خاطئ، ترحيل مفسد، اختراق)

1. **أوقف الضرر:** إن كان مستخدماً: `admin_revoke_sessions` + تعطيل الحساب. إن كان ترحيلاً: أوقف
   النشر (ألغِ workflow الجاري، لا تنشر وسماً جديداً).
2. **حدّد النطاق والوقت:** `audit_log` يسجل كل تغيير (من، متى، القيم القديمة والجديدة):
   ```sql
   select created_at, table_name, row_id, op, changed_fields, user_id, device_id
     from public.audit_log
    where created_at > now() - interval '2 hours' order by created_at desc limit 200;
   -- old_data / new_data hold the full row before / after
   ```
   الحذف في هذا النظام ناعم (`deleted_at`): أغلب
   «الحذف» يُصلَح بإعادة `deleted_at` إلى `null` عبر الواجهة أو `sync_push` دون استرجاع.
3. **صفوف قليلة:** استرجع النسخة المنطقية إلى قاعدة جانبية (`restore.ts --db imap_incident` محلياً، أو
   مشروع مؤقت) وانقل الصفوف المطلوبة يدوياً بعد مراجعتها — لا تستبدل الإنتاج.
4. **فساد واسع:** PITR إلى ما قبل الحادثة (§4.2) أو استرجاع كامل إلى مشروع جديد (§7).
5. بعد أي استرجاع: §7.5، ثم مراجعة ما بعد الحادثة خلال أسبوع.

---

## 10. المراقبة

| ماذا                  | أين                                                                                                                                      | العتبة / الإجراء                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| أخطاء الواجهة والدوال | **Sentry** (`VITE_SENTRY_DSN` للواجهة، `SENTRY_DSN` للدوال؛ الإصدار من `package.json`)                                                   | تنبيه عند خطأ جديد أو ارتفاع مفاجئ؛ قيمة DSN ⏳ تُضبط في متغيرات البيئة    |
| حالة المزامنة         | لوحة **`/admin/sync`** (`sync_status()`): المستخدمون، الأجهزة، العمليات والصور المعلّقة، التعارضات، المرفوض خلال 7 أيام، الأجهزة الخاملة | مراجعة يومية من مدير كل دولة؛ جهاز `stale` بعمليات معلّقة ⇒ تواصل مع صاحبه |
| النسخ الاحتياطي       | GitHub Actions (مهمة `backup` المقترحة) + `rclone lsf`                                                                                   | آخر نسخة أقدم من 26 ساعة ⇒ حادثة                                           |
| نسخ الصور             | سجل `replicate-photos.sh --check`                                                                                                        | أي فرق ⇒ إعادة التشغيل ثم التحقيق                                          |
| مهام pg_cron          | `select jobname, status, start_time from cron.job_run_details order by start_time desc limit 20;`                                        | فشل متكرر ⇒ تحقق                                                           |
| قاعدة البيانات        | Supabase → Reports (CPU، الاتصالات، المساحة)، و`pg_stat_activity` للمعاملات الطويلة                                                      | معاملة > 5 دقائق ⇒ §9.3                                                    |
| PITR                  | Database → Backups                                                                                                                       | أقدم نقطة متاحة أقل من مدة الاحتفاظ ⇒ مراجعة                               |

**اختبار الاسترجاع دورياً:** كل 3 أشهر وبعد أي تغيير كبير في المخطط — كرر §8.1 على أحدث نسخة
حقيقية (إلى مشروع staging مؤقت بعد قرار المالك) وأضف قسماً جديداً «اختبار الاسترجاع — <التاريخ>».

## 11. مراجع سريعة

| الملف                                        | الغرض                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `scripts/backup/dump.ts`                     | التفريغ اليومي + manifest + سجل التخزين + الرفع (placeholder)            |
| `scripts/backup/restore.ts`                  | الاسترجاع إلى قاعدة جديدة + `sync_rebase` + التحقق من الأعداد والصلاحيات |
| `scripts/backup/verify-client.ts`            | عميل حقيقي على النسخة المسترجَعة: دخول، سحب، دفع، reset                  |
| `scripts/backup/drill.ts`                    | اختبار الاسترجاع الكامل بأمر واحد                                        |
| `scripts/backup/replicate-photos.sh`         | نسخ حاوية الصور (placeholder rclone)                                     |
| `docs/contracts/sync.md` §5.2، §8            | `scope_epoch` و`reset`، دوال الصيانة                                     |
| `docs/contracts/people-admin.md` §6، §7      | إلغاء الجلسات، لوحة حالة المزامنة                                        |
| `docs/contracts/reports-import-export.md` §6 | الاحتفاظ بالصور                                                          |

## 12. Supabase compatibility notes — ملاحظات التوافق مع Supabase الحقيقي

مراجعة 2026-10-05 لكل الترحيلات (0001–0075) مقابل Supabase المستضاف والذاتي الاستضافة، ومقارنة
`scripts/local-stack/supabase-shim.sql` بمخطط Supabase الحقيقي. الفرق الجوهري: محلياً تُطبَّق الترحيلات
وتُشغَّل pgTAP بالمستخدم الأعلى `postgres` (superuser)، أما على Supabase فالدور `postgres` **ليس**
superuser (له `CREATEROLE` و`CREATEDB` و`BYPASSRLS`)، والمستخدم الأعلى `supabase_admin` لا نملكه.
كل بند أدناه إما أُصلح في SQL، أو تُحقِّق منه أنه لا يختلف، أو هو فرق قائم يجب فحصه في أول نشر على
`staging` / أول تشغيل CI.

### 12.1 أُصلح في SQL (الترحيل 0074)

- **`private.sync_rebase()` بعد الاسترجاع (§7):** كان يعتمد على
  `set local session_replication_role = replica` — معامل superuser، فيفشل على مشروع Supabase جديد بـ
  `permission denied to set parameter`. الآن يحاوله أولاً، وعند `insufficient_privilege` يعطّل مالكُ
  الجداول (`postgres`) المشغّلات المفعّلة بـ `ALTER TABLE … DISABLE TRIGGER` ثم يعيدها في المعاملة نفسها؛
  النتيجة تذكر `"mode"` (`replica` أو `alter_table`). مُختبَر في pgTAP 25 (§H) بفرض المسار البديل
  (`app.sync_rebase_mode = 'alter'`).

### 12.2 تُحقِّق منه — لا فرق

- **search_path:** الـ shim يضبط `ALTER DATABASE … SET search_path` (محلي فقط). كل الدوال الـ 189 في
  `public` و`private` تثبّت `search_path` في تعريفها (الاستعلام: لا دالة SQL/plpgsql بلا
  `proconfig search_path=`)، فلا تعتمد على إعداد القاعدة أو الدور.
- **الامتيازات الافتراضية:** كل دالة في `public` قابلة للتنفيذ من `authenticated` لها `GRANT EXECUTE`
  صريح في الترحيلات، وكل جدول يقرؤه `authenticated` له `GRANT` صريح (0011) — لا شيء يعتمد على
  `ALTER DEFAULT PRIVILEGES` الخاصة بالمنصة. كائنات تُنشأ يدوياً من الـ Dashboard (بدور آخر) خارج هذه
  الضمانة: أنشئ كل شيء بترحيل.
- **PostgREST overloads:** لا اسم دالة مكرر في `public` (لا غموض في `/rpc/<name>`).
- **دوال STABLE لا تكتب:** الدوال العامة STABLE (`my_context`، `locate_point`، `tile_projects`،
  `project_duplicates`، `admin_area_shapes`، `export_columns`، `import_preview`، `import_template`،
  `photos_to_purge`، `server_info`) لا تكتب ولا تستدعي كاتباً (لا `rate_limit` ولا سجلات)، فتعمل في
  معاملة PostgREST للقراءة فقط (GET).
- **pg_cron:** الترحيلان 0058 و0070 يتحققان من `pg_available_extensions` ويلتقطان أي خطأ؛ على Supabase
  تُجدول المهام باسم `postgres` بلا JWT، و`private.require_service_role()` يقبل غياب الدور. يجب أن تكون
  القاعدة هي `cron.database_name` (`postgres` على Supabase — هي قاعدة الترحيلات).
- **مخطط `auth`:** الترحيلات لا تقرأ من GoTrue إلا مطالبات JWT (`sub`، `role`، `aal`، `iat`،
  `session_id`) عبر `auth.uid()`/`auth.jwt()`، والجدولين `auth.sessions`/`auth.refresh_tokens` (في
  `private.end_auth_sessions` فقط، بأعمدة موجودة في GoTrue: `user_id` من نوع uuid في الأول و`varchar`
  في الثاني). لا مشغّلات على جداول `auth`.
- **سياسات `storage.objects`:** الترحيل 0015 ينشئ سياسات فقط (`create policy` مسموح لـ `postgres` على
  Supabase) ويحدّث `storage.buckets`؛ لا `ALTER TABLE storage.objects` (تفعيل RLS والمشغّلات والملكية في
  الـ shim وحده). `file_size_limit`/`allowed_mime_types` تُضبط فقط إن وُجد العمودان.
- **BYPASSRLS:** جداول `public` بـ `FORCE ROW LEVEL SECURITY`، والدوال SECURITY DEFINER يملكها دور
  الترحيلات؛ هذا يعمل لأن `postgres` على Supabase له `BYPASSRLS`. إن طُبِّقت الترحيلات بدور بلا
  `BYPASSRLS` يرفض الترحيل 0070 (`harden_private_schema`) المتابعة برسالة صريحة بدل أن ترى الدوال
  جداول فارغة.

### 12.3 فروق قائمة — قد تنجح محلياً وتفشل على Supabase

1. **pgTAP بغير superuser.** `supabase test db` في CI يتصل بـ `postgres` (ليس superuser في صور Supabase
   الحديثة). ما قد يفشل هناك وحده: `tests.create_user()` يكتب في `auth.users`/`auth.identities`،
   و`tests.fixture_storage()` (ملف 15) يكتب في `storage.objects` — مسموح لـ `postgres` في صور CLI الحالية
   لكنه غير مضمون في كل إصدار؛ استبدال `private.current_xid()`/`safe_xid()` داخل المعاملة (الملفات 16، 17،
   22، 23، 25) يحتاج أن يكون `postgres` مالك الدالتين (هو كذلك حين تطبّق CLI الترحيلات).
   `sync_rebase` في الملفين 23 و25 صار يعمل بالمسارين. **افحص هذا في أول تشغيل CI** (`docs/CI.md`).
2. **statement_timeout.** على Supabase: `authenticated` = 8 ث و`anon` = 3 ث (الـ shim يكررها). pgTAP يستخدم
   `SET ROLE` فلا يرى هذه المهل أبداً. وجُرِّب محلياً أن `SET statement_timeout` في تعريف الدالة **لا** يمدّ
   مهلة جملة جارية في PostgreSQL (دالة بـ 10 ث قُطعت عند مهلة الجلسة 1 ث). الدوال الطويلة
   (`import_stage` 180 ث، `import_commit`/`import_rollback` 300 ث، `refresh_reports` 10 دقائق) تعتمد إذن على
   أن PostgREST ≥ 12.1 «يرفع» `statement_timeout` من إعدادات الدالة إلى المعاملة (`db-hoisted-tx-settings`،
   مفعّل افتراضياً). Supabase المستضاف (PostgREST 12.2+) والبيئة المحلية (16.4) كذلك؛ **في الاستضافة الذاتية
   تأكد أن صورة PostgREST ≥ v12.1**، وإلا قُطع استيراد دفعة كبيرة وأول مزامنة لنطاق كبير جداً عند 8 ث. ولا
   تضع هذه الدوال خلف Supavisor بوضع `session` بإعدادات مختلفة. الاستدعاء المباشر (psql، pg_cron) بدور
   `postgres` بلا مهلة.
3. **GET مقابل POST.** كل دالة VOLATILE تكتب (محدّد المعدل، نبضة الجهاز، السجلات): `sync_pull`،
   `sync_push`، `search`، `projects_page`، `dashboard`، `report_*`، `user_display_names`… — تُستدعى بـ POST
   فقط (افتراضي `supabase-js`)؛ GET يفتح معاملة للقراءة فقط فتفشل بـ
   `cannot execute INSERT in a read-only transaction`. `tile_projects` يعيد النطاق
   `"application/vnd.mapbox-vector-tile"` ويحتاج PostgREST ≥ 12 وترويسة `Accept` مطابقة.
4. **ترويسة `x-device-id` خارج PostgREST.** `private.device_id()` يقرأ `request.headers` (صيغة JSON في
   PostgREST ≥ 10). Storage API لا يضمن تمرير ترويسات العميل إلى `request.headers` (بحسب الإصدار، ولا
   يمر الطلب بالبوابة المحلية التي تحاكيه)، فداخل سياسات `storage.objects` قد يكون الجهاز مجهولاً: إلغاء **الحساب** (`sessions_revoked_at` عبر `iat`، أو تعطيله)
   نافذ في Storage، أما إلغاء **جهاز واحد** فلا يمنع تنزيل الصور حتى تنتهي صلاحية JWT ذلك الجهاز (ساعة)؛
   إلغاء الجلسات (`admin_revoke_sessions` بلا جهاز) هو الإجراء الكامل (§9.1).
5. **حذف مستخدم من Supabase Auth.** الأعمدة `created_by`/`updated_by`/… تشير إلى `auth.users(id)` بلا
   `ON DELETE`؛ حذف مستخدم كتب أي صف من الـ Dashboard أو `auth.admin.deleteUser` يفشل بخرق FK. الإجراء
   الصحيح تعطيل الحساب (`admin_set_user_active`) — لا حذف.
6. **إنهاء جلسات Auth.** `private.end_auth_sessions` يحذف من `auth.sessions`/`auth.refresh_tokens` بدور
   `postgres`. إن سحبت المنصة صلاحية DML على جداول `auth` يعيد `NULL` (لا خطأ)، و`admin_end_auth_sessions`
   يرفع `PT503`، فتلجأ دالة Edge `admin` إلى Auth Admin API. **افحص على staging:** إلغاء جلسات مستخدم ثم
   محاولة `refresh_token` له.
7. **Storage القابل للاستئناف.** الـ shim لا يحوي جداول Storage الحديثة (`storage.s3_multipart_uploads`،
   `storage.prefixes`) والبوابة المحلية تحاكي TUS؛ رفع الصور بـ TUS الحقيقي وسياسات `INSERT`/`UPDATE` على
   `storage.objects` (upsert يحتاج `SELECT` + `UPDATE`) يُجرَّبان أول مرة على staging.
8. **امتداد مثبت مسبقاً في مخطط آخر.** الترحيل 0001 ينشئ `postgis`/`pg_trgm`/`unaccent`/`pgcrypto`
   `with schema extensions` مع `if not exists`، والدوال تشير صراحة إلى `extensions.geometry`،
   `extensions.gin_trgm_ops`، `extensions.unaccent`، `extensions.st_x/st_y`. مشروع فُعّل فيه PostGIS من
   الـ Dashboard في `public` يجعل هذه الإشارات تفشل. **قبل أول `db push`:**
   `select extname, extnamespace::regnamespace from pg_extension;` — يجب أن تكون الأربعة في `extensions`.
9. **`ALTER DATABASE … SET app.rate_limit = 'off'`** (تعليق الترحيل 0040، لاختبارات الحمل): يحتاج مالك
   القاعدة؛ لا يُستعمل على Supabase ولا يلزم هناك (يُطفأ محدّد المعدل محلياً فقط).
10. **pg_cron محلياً غير موجود:** المهام المجدولة (التقارير، `sync_prune`، `sync_rejections_cleanup`،
    `expire_export_jobs`) لم تعمل قط تحت pg_cron الحقيقي؛ بعد أول نشر:
    `select jobname, schedule, active from cron.job;` و`cron.job_run_details` بعد 15 دقيقة.

| ما يُفحص في أول نشر                    | الأمر / المكان                                                              |
| -------------------------------------- | --------------------------------------------------------------------------- |
| مخطط الامتدادات (§12.3/8)              | `select extname, extnamespace::regnamespace from pg_extension;`             |
| `BYPASSRLS` لدور الترحيلات             | `select rolsuper, rolbypassrls from pg_roles where rolname = current_user;` |
| مهام pg_cron (§12.3/10)                | `select jobname, active from cron.job;`                                     |
| `sync_rebase` على مشروع الاسترجاع (§7) | `select private.sync_rebase();` ← `"mode"` = `replica` أو `alter_table`     |
| مهلة الاستيراد الطويل (§12.3/2)        | استيراد ≥ 5000 صف عبر الواجهة؛ `import_commit` لا يُقطع عند 8 ث             |
| إنهاء جلسات Auth (§12.3/6)             | `admin_end_auth_sessions` عبر service role ثم refresh مرفوض                 |
