# التكامل والنشر المستمر (CI/CD) وميزانية Lighthouse

> المرجع: أمر التنفيذ `docs/BRIEF.md` §1 (GitHub Actions، بيئتا `staging` و`production`)، §5 (ميزانية
> الأداء)، §14 (معيارا القبول 1 و7). الملفات: `.github/workflows/ci.yml` و`.github/workflows/deploy.yml`
> والسكربتات المساعدة في `.github/scripts/` و`scripts/lighthouse/`.

**تنبيه صريح:** درجات Lighthouse الرسمية (PWA وAccessibility وPerformance في معيار القبول 7) **لا
تُنتَج إلا في CI** عبر Lighthouse CI. Lighthouse غير مثبّت على جهاز التطوير ولا يجوز تنزيله، فالأرقام
المحلية في §6 أدناه **تقديرات** من Playwright وبروتوكول Chrome DevTools، وليست درجات Lighthouse.

---

## 1. خريطة سير العمل

| الملف        | المشغّل                                                                                        | الوظائف                                                          |
| ------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `ci.yml`     | كل `push` على أي فرع، كل `pull_request`، يدويًا، ويُستدعى من `deploy.yml` (`workflow_call`)    | `quality` · `build` · `db` · `e2e` · `lighthouse`                |
| `deploy.yml` | نجاح CI على `main` (`workflow_run`) ⟵ staging · وسم `v*` ⟵ production · يدويًا (اختيار البيئة) | `ci` (إعادة CI كاملة للوسوم والتشغيل اليدوي) ⟵ `plan` ⟵ `deploy` |

```
push/PR ─► quality ─┐
          build ────┼─► lighthouse
          db        │
          e2e       │
main أخضر ─────────► deploy.yml ─► staging
وسم v* / يدوي ─► ci (كاملة) ─► plan ─► deploy ─► production (بموافقة يدوية)
```

## 2. وظائف `ci.yml`

### 2.1 `quality` — الجودة

`npm ci` ثم: `npm run lint` (ESLint) · `npm run format:check` (Prettier) · `npm run typecheck`
(السكربتات + الواجهة) · `tsc -p supabase/functions/tsconfig.json` (الدوال) · `npm test` (Vitest) ·
`node .github/scripts/validate-workflows.mjs` (صحة ملفات YAML: تحليل بمكتبة `js-yaml` الموجودة في
`node_modules`، الحقول الإلزامية، `needs` بلا حلقات، وجود السكربتات المشار إليها).

### 2.2 `build` — البناء وحارس الحجم

`npm run build` (دمج الترجمات + `tsc` + `vite build`) ثم `npm run size -w apps/web` الذي يفشل إذا
تجاوز JavaScript الأولي 200 كيلوبايت مضغوطة (البند 1). يُرفع `apps/web/dist` كـ artifact باسم
`web-dist` لوظيفة Lighthouse. قيم البناء عامة فقط (عنوان الحزمة المحلية على `127.0.0.1:54321` ومفتاح
anon وهمي — صفحة الدخول لا تتصل بالخادم قبل «إرسال الرمز»).

### 2.3 `db` — Supabase الحقيقي + pgTAP

1. `supabase/setup-cli@v1` (الإصدار في `SUPABASE_CLI_VERSION`؛ `latest` حتى أول تشغيل أخضر ثم يُثبَّت).
2. `ci-supabase-config.mjs` يرخي حدود المعدل في نسخة المشغّل من `supabase/config.toml` (انظر 2.4).
3. `supabase start -x vector,logflare,studio` (Docker متاح على مشغّلات ubuntu).
4. `supabase db reset` — كل الترحيلات + `seed.staging.sql`.
5. **ترتيب pgTAP:** `supabase test db` يسلّم المجلد إلى `pg_prove` الذي يشغّل الملفات مرتبة أبجديًا،
   فيعمل `00_helpers.test.sql` أولًا. ومع ذلك يُنفَّذ الملف صراحةً قبلها عبر `psql` داخل حاوية
   `supabase_db_*` حتى لا تعتمد الحزمة على هذا الترتيب؛ الملف آمن للتكرار (يحذف مخطط `tests` ويعيد
   إنشاءه)، فتشغيله مرتين لا يضر.
6. `supabase test db`. وعند الفشل تُطبع سجلات الحاويات.

### 2.4 `e2e` — Playwright على Supabase الحقيقي

- `supabase start` + `db reset` ثم `supabase-ci-env.mjs` يكتب في `$GITHUB_ENV` عناوين الحزمة ومفاتيحها
  بأسماء `.env.example` (`VITE_SUPABASE_URL`، `VITE_SUPABASE_ANON_KEY`، `SUPABASE_SERVICE_ROLE_KEY`…).
  هذه مفاتيح التطوير المحلية المعروفة، لا أسرار.
- **وسيط `/dev/otp`:** مساعدات الاختبار تقرأ رموز الدخول من `GET <api>/dev/otp`، وهي نقطة في البوابة
  المحلية فقط. في CI يعمل `dev-otp-proxy.mjs` على `127.0.0.1:54329`: يجيب `/dev/otp` من صندوق بريد
  Mailpit (أو Inbucket في الإصدارات الأقدم)، ويعيد رموز الهواتف الثابتة من `[auth.sms.test_otp]`، ويمرر
  كل ما عداه إلى الحزمة. `E2E_SUPABASE_URL` يشير إلى الوسيط، أما التطبيق نفسه فيتصل بـ `:54321` مباشرة.
- **حدود المعدل في CI فقط:** `ci-supabase-config.mjs` يضيف `max_frequency = "1s"` إلى `[auth.email]`
  وجدول `[auth.rate_limit]` بقيم 1000، في نسخة المشغّل وحدها (لا يُودَع). الإعدادات الافتراضية لـ GoTrue
  (رسالة واحدة لكل عنوان كل 60 ثانية، 30 دخولًا لكل 5 دقائق) صحيحة للإنتاج وتُفشل حزمة آلية.
- المتصفح: `playwright install --with-deps chromium` (مسموح في CI)، و`playwright.config.ts` يستخدم
  `channel: 'chrome'` الموجود أصلًا على مشغّلات ubuntu (ويُثبَّت إن غاب).
- `npm run e2e` يبني التطبيق ويشغّل `vite preview` بنفسه (`webServer` في الإعداد). عند الفشل يُرفع
  تقرير Playwright وآثاره وسجل الوسيط.

### 2.5 `lighthouse` — الميزانية

| الخطوة                  | الإعداد                                                                                                                                                | التحقق (يُفشل CI)                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Lighthouse محمول        | `apps/web/lighthouserc.json` — `formFactor: mobile`، شاشة Moto G Power (412×823)، `throttlingMethod: simulate` (4G بطيء + معالج ×4)، 3 تشغيلات والوسيط | Performance ≥ 0.85، Accessibility ≥ 0.95، `viewport`، `document-title`، `html-has-lang`، `color-contrast` (Best Practices تحذير فقط) |
| Lighthouse على 3G محاكى | `apps/web/lighthouserc.3g.json` — `rttMs 300`، `700 kbps`، معالج ×4 (ملف Lighthouse «regular 3G»)                                                      | FCP < 2500 ms (البند 5)                                                                                                              |
| فحوص التثبيت والوصولية  | `scripts/lighthouse/audit.ts --pages login --no-metrics --enforce`                                                                                     | كل فحص من مستوى `error` في §4                                                                                                        |

Lighthouse CI مثبّت الإصدار (`LHCI_VERSION=0.15.1`، يُنزَّل في CI بـ `npx`) ويحمل Lighthouse 12.
التقارير تُحفظ في نظام الملفات وتُرفع كـ artifact (`lighthouse-reports`) — **لا** يُستخدم
`temporary-public-storage` لأنه ينشر التقارير علنًا.

## 3. ما يُثبَّت بعد أول تشغيل أخضر

- `SUPABASE_CLI_VERSION` في الملفين: من `latest` إلى الإصدار الذي نجح.
- إن ثبت أن إعدادات حدود المعدل في 2.4 لازمة، تُنقل إلى `supabase/config.toml` نفسه بقسم مخصص للتطوير
  ويُحذف سكربت التعديل (القرار للمسؤول عن `config.toml`).

## 4. PWA بعد Lighthouse 12

حذف Lighthouse 12 فئة PWA كلها (ومعها `installable-manifest` و`service-worker` و`maskable-icon`)،
فلا يمكن لأي إصدار حالي من Lighthouse CI أن يعطي «PWA 100» حرفيًا. البديل المعتمد هنا يسأل Chrome نفسه:

| الفحص                                                                                                    | المصدر                                                                                |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Chrome يعدّ التطبيق قابلًا للتثبيت                                                                       | `Page.getInstallabilityErrors` (قائمة فارغة؛ يلزم ملف تعريف دائم لا وضع التصفح الخفي) |
| ملف manifest مرتبط ومحلَّل بلا أخطاء                                                                     | `Page.getAppManifest`                                                                 |
| `name` و`short_name` و`display: standalone` و`start_url` داخل `scope` و`theme_color` و`background_color` | محتوى الـ manifest                                                                    |
| أيقونات PNG ‏192 و512 وأيقونة maskable منفصلة، وأبعادها الفعلية تطابق المعلَن                            | تنزيل كل أيقونة وقراءة ترويسة PNG (البند 12)                                          |
| `apple-touch-icon` ‏≥ 180                                                                                | `<link rel="apple-touch-icon">`                                                       |
| Service Worker مسجّل ويتحكم في الصفحة بعد إعادة التحميل                                                  | `navigator.serviceWorker`                                                             |
| الصفحة الأولى تعمل **دون اتصال** من الـ Service Worker                                                   | `context.setOffline(true)` ثم فتح `start_url`                                         |
| `viewport` و`theme-color` و`lang`/`dir` والعنوان                                                         | ترويسة المستند                                                                        |
| HTTPS                                                                                                    | الحلقة المحلية مستثناة؛ الإنتاج يحتاج HTTPS + HSTS (`public/_headers`)                |

## 5. النشر `deploy.yml`

### 5.1 البيئات والموافقة

- أنشئ في GitHub ← Settings ← Environments بيئتين: `staging` و`production`.
- اجعل لـ `production` **مراجعين إلزاميين** (Required reviewers) — هذه هي الموافقة اليدوية؛ والأفضل
  تقييد فروع النشر بالوسوم `v*`.
- staging يُنشر تلقائيًا بعد كل CI أخضر على `main`؛ production عند دفع وسم `v*` أو يدويًا، وفي
  الحالتين تُعاد CI كاملة على الـ commit نفسه أولًا.

### 5.2 الأسرار والمتغيرات (لكل بيئة)

| النوع         | الاسم                                                                 | ملاحظة                                                               |
| ------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| سر            | `SUPABASE_ACCESS_TOKEN`                                               | رمز حساب Supabase (قرار المالك 1)                                    |
| سر            | `SUPABASE_PROJECT_REF`                                                | أو على مستوى المستودع `SUPABASE_PROJECT_REF_STAGING` / `_PRODUCTION` |
| سر            | `SUPABASE_DB_PASSWORD`                                                | أو `SUPABASE_DB_PASSWORD_STAGING` / `_PRODUCTION`                    |
| سر            | `VITE_SUPABASE_ANON_KEY`                                              | عام بطبيعته لكنه يُحفظ سرًّا للتنظيم                                 |
| متغير         | `VITE_SUPABASE_URL`، `VITE_TILES_URL`، `VITE_SENTRY_DSN` (اختياري)    | قيم البناء العامة؛ منها تُحسب سياسة CSP                              |
| متغير         | `APP_ORIGINS`                                                         | أصول CORS للدوال، مثل `https://staging.example.org` (قرار المالك 2)  |
| متغير         | `OTP_PROVIDER`                                                        | الافتراضي `fake` حتى قرار المالك 4                                   |
| متغير         | `WEB_HOSTING`                                                         | `cloudflare-pages` أو `netlify` أو فارغ (قرار المالك 1/2)            |
| متغير + أسرار | `WEB_PROJECT_NAME` + `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | عند `cloudflare-pages`                                               |
| أسرار         | `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID`                              | عند `netlify`                                                        |
| سر + متغيرات  | `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT`                 | اختياري: إصدار Sentry وخرائط المصدر                                  |

### 5.3 الخطوات

1. التحقق من وجود الإعدادات الإلزامية (رسالة واضحة إن نقص شيء).
2. `supabase link` ثم `supabase db push --dry-run` (عرض الترحيلات المعلّقة).
3. **staging:** `supabase db push --include-seed` — الترحيلات + `seed.staging.sql`.
   **production:** `supabase db push` — الترحيلات فقط، **ولا بذرة أبدًا** (البند 7.8).
4. `supabase secrets set` (`APP_ENV`، `OTP_PROVIDER`، `APP_ORIGINS`) ثم نشر كل دالة في
   `supabase/functions/*` (عدا `_shared`)؛ `otp-hook` بـ `--no-verify-jwt` لأن Auth يستدعيه بلا JWT.
5. بناء الواجهة بقيم البيئة + حارس الحجم.
6. اختياري: إصدار Sentry ورفع خرائط المصدر، ثم **حذف ملفات `.map` من البناء العام** قبل النشر.
7. رفع البناء كـ artifact (`web-dist-<env>`، 30 يومًا)، ثم النشر إلى الاستضافة المختارة، أو تحذير
   صريح في ملخص التشغيل إن لم تُختر استضافة بعد. **لا شيء في الملف يفترض قرار المالك 1 أو 2.**

## 6. القياس المحلي دون Lighthouse (`scripts/lighthouse/audit.ts`)

```bash
cd apps/web && npx vite build --outDir ../../.local/lighthouse/dist --emptyOutDir && cd ../..
npx tsx scripts/lighthouse/audit.ts --serve .local/lighthouse/dist --url http://127.0.0.1:5173 \
  --pages login,map --profiles lh-mobile,3g,slow-3g --runs 3 --out .local/lighthouse/audit-report.json
```

- المنفذ 5173 مقصود: أصوله ضمن أصول CORS الافتراضية للدوال (`_shared/cors.ts`)، فتعمل بلاطات المشاريع
  على صفحة الخارطة دون تعديل الحزمة المحلية. صفحة الخارطة تحتاج البوابة المحلية (`/dev/otp`) والحساب
  المزروع `collector.pemba@example.org`.
- **الخنق المطبَّق (applied):** `Network.emulateNetworkConditions` + `Emulation.setCPUThrottlingRate(4)`،
  بقيم Lighthouse «المكافئة لـ DevTools» (زمن الطلب = RTT × 3.75، السرعة × 0.9). على الحلقة المحلية لا
  توجد مصافحة DNS/TCP/TLS، وLighthouse في CI يستخدم المحاكاة (Lantern) لا الخنق المطبَّق — لذا تختلف
  الأرقام عن CI في الاتجاهين.
- **الدرجة المقدَّرة:** منحنيات Lighthouse 10–12 للهاتف وأوزانه، **دون Speed Index** (يُوزَّع وزنه على
  البقية). ليست درجة Lighthouse.
- **صفحة الدخول:** تحميل بارد (سياق جديد بلا ذاكرة). **صفحة الخارطة:** مستخدم ميداني عائد — جهاز سجّل
  الدخول وتزامن مرة، ثم يُعاد فتح المتصفح على `/map` تحت الخنق: شاشة قفل PIN ⟵ إدخال الرمز ⟵ الخارطة
  جاهزة (`map-view[data-state=ready]`).

### 6.1 الأرقام المقيسة (2026-10-04، Chrome 153، بناء من شجرة العمل الحالية، وسيط 3 تشغيلات)

| الصفحة         | ملف الخنق                       | FCP         | LCP      | TBT     | CLS   | الطلبات / النقل | فتح القفل ⟵ الخارطة | الأداء المقدَّر |
| -------------- | ------------------------------- | ----------- | -------- | ------- | ----- | --------------- | ------------------- | --------------- |
| الدخول (بارد)  | Lighthouse محمول (4G بطيء) + ×4 | 1956 ms     | 3992 ms  | 308 ms  | 0     | 25 / 252 kB     | —                   | ~77             |
| الدخول (بارد)  | 3G ‏(RTT 300، 700 kbps) + ×4    | **3792 ms** | 7380 ms  | 461 ms  | 0     | 25 / 252 kB     | —                   | ~53             |
| الدخول (بارد)  | DevTools «Slow 3G» + ×4         | 6488 ms     | 12000 ms | 418 ms  | 0     | 25 / 252 kB     | —                   | ~50             |
| الخارطة (عائد) | Lighthouse محمول + ×4           | 788 ms      | 1400 ms  | 723 ms  | 0     | 67 / 4 kB       | 1766 ms             | ~80             |
| الخارطة (عائد) | 3G + ×4                         | 1600 ms     | 2152 ms  | 1376 ms | 0.002 | 67 / 4 kB       | 2014 ms             | ~70             |
| الخارطة (عائد) | DevTools «Slow 3G» + ×4         | 2160 ms     | 2716 ms  | 762 ms  | 0.002 | 67 / 3 kB       | 1920 ms             | ~73             |

(في صفحة الخارطة يقيس FCP/LCP شاشة القفل التي تُعرض أولًا من ذاكرة الـ Service Worker؛ و«4 kB» هي
بايتات الشبكة فقط، فالباقي من الذاكرة المحلية.)

| الفحص               | النتيجة                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| قابلية التثبيت (§4) | **كل فحوص مستوى error ناجحة**: Chrome لا يبلغ عن أي خطأ تثبيت، الـ manifest سليم، أيقونات 192/512/maskable وapple-touch-icon 180 بأبعاد مطابقة، الـ SW يتحكم بالصفحة، والصفحة الأولى تعمل دون اتصال. تحذير واحد: `short_name` «خارطة الاستقامة» 15 حرفًا (قد يُقتطع في بعض المشغّلات) |
| الوصولية — الدخول   | axe بقواعد Lighthouse: 0 مخالفات من 26 قاعدة منطبقة (تقدير 100)؛ 24 زوج ألوان من `tokens.css` كلها ≥ AA؛ الحقول مسمّاة؛ `<main>` واحد و`<h1>`؛ كل الأهداف ≥ 44×44. تحذيران: لا `nav` ولا رابط تخطٍّ (طبيعي لشاشة دخول)                                                                |
| الوصولية — الخارطة  | 0 مخالفات من 32 قاعدة (تقدير 100)؛ `color-contrast` «غير محسوم» فوق لوحة الخارطة (axe لا يقرأ ما تحت canvas). تحذير: رابط بارتفاع 42 px (< 44 الموصى به، ≥ 24 الإلزامي)                                                                                                               |

### 6.2 ما تعنيه الأرقام للميزانية

- **FCP < 2.5 s على 3G (البند 5): غير محقق محليًا على صفحة الدخول الباردة (3.8 s بالخنق المطبَّق).**
  الحكم الرسمي لـ Lighthouse CI (المحاكاة) قد يختلف، لكنه مرجَّح أن يفشل أيضًا. السبب من تتبّع
  الطلبات: سلسلة تحميل متتابعة — `index.html` ⟵ ست وحدات modulepreload ⟵ ملفا CSS يُحقنان من JS
  (‏~1.85 s) ⟵ `db`/`routes` ⟵ `LoginView` (‏~2.6 s) ⟵ `auth`/`supabase`/`sync` (‏~3.1 s) ⟵ رسم نص
  الدخول (عنصر LCP هو `p.auth-card__intro`)، والخطوط تنتهي ~3.4 s لأنها تتقاسم النطاق مع JS.
  مقترحات للمسؤول عن الواجهة: ربط CSS الأساسي في `index.html` مباشرة، وإضافة `modulepreload` لسلسلة
  الدخول (`LoginView` و`auth`)، أو رسم هيكل شاشة الدخول ساكنًا في `index.html`، وتأخير `supabase`/`sync`
  إلى ما بعد العرض الأول. (البناء المحلي استخدم `.env.local` أي `VITE_APP_ENV=development`، فحمّل جزء
  `auth/dev` الخاص بالاختبارات بعد العرض؛ بناء الإنتاج يحذفه — أثره على الأرقام ضئيل.)
- **Performance ≥ 85 (محمول):** التقدير ~77 لصفحة الدخول (LCP ‏4 s يخسر أكثر النقاط). الإصلاح نفسه أعلاه.
- **Accessibility ≥ 95:** التقدير 100 للصفحتين؛ الحكم الرسمي في CI.
- **PWA:** كل ما كانت فئة PWA تفحصه ناجح (§4)؛ الرقم «PWA 100» نفسه لم يعد Lighthouse يصدره.

## 7. ما تحقق وما لم يتحقق

| البند                                                                                                          | الحالة                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| صحة YAML وبنية الملفين                                                                                         | ✅ `validate-workflows.mjs` محليًا (8 وظائف)                                                                                               |
| `ci-supabase-config.mjs`                                                                                       | ✅ جُرّب على نسخة من `config.toml` (يضيف المفاتيح الناقصة فقط، وآمن للتكرار)                                                               |
| وسيط `/dev/otp`                                                                                                | ✅ جُرّب على البوابة المحلية: الصحة، رموز الهواتف الثابتة، 404 لبريد بلا رسالة، تمرير الطلبات. ⬜ قراءة Mailpit لم تُجرَّب (لا Docker هنا) |
| `audit.ts`                                                                                                     | ✅ شُغّل كاملًا (الأرقام في §6)                                                                                                            |
| تشغيل GitHub Actions الفعلي (Supabase CLI، pgTAP على Supabase الحقيقي، Playwright في CI، Lighthouse CI، النشر) | ⬜ **لم يُشغَّل** — لا يمكن من هذا الجهاز. أول تشغيل على GitHub هو التحقق                                                                  |

### مخاطر معروفة لأول تشغيل

1. **خريطة الأساس في CI:** ملف PMTiles (`.local/tiles/east-africa.pmtiles`، 100 MB) غير مُودَع، فلن تجد
   اختبارات الخارطة خريطة أساس في دلو `tiles`. الحل: مقتطف صغير مُودَع (z0–6) يُرفع إلى الدلو في CI، أو
   جعل `map.spec.ts` يقبل إشعار «خريطة الأساس غير متاحة» في CI.
2. **pgTAP على Supabase الحقيقي لم يُجرَّب قط** (محليًا يعمل على PostgreSQL + `supabase-shim.sql`)؛ أي فرق
   بين المحاكي ومخطط `auth`/`storage` الحقيقي سيظهر هنا أولًا.
3. **اختبارات التكامل الحية** (`apps/web/tests/integration`، `supabase/functions/smoke.ts`، فحوص البوابة)
   مبنية على البوابة المحلية (`/dev/health`) ولا تعمل في CI حاليًا.
4. **مفاتيح Supabase الجديدة:** إن أعاد CLI مفاتيح `sb_publishable_…` فقط، يأخذها `supabase-ci-env.mjs`
   بديلًا، لكن اختبارات تفكّ JWT المفتاح قد تحتاج تعديلًا.
5. **`channel: 'chrome'`** ثابت في `playwright.config.ts`؛ إن أُريد Chromium المثبَّت من Playwright وحده
   يلزم جعل القناة قابلة للتغيير بمتغير بيئة (خارج نطاق هذا العمل).
