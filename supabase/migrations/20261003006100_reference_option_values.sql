-- =============================================================================
-- 0061  Reference data (2/4): option lists of the community profile
--       (brief section 2.5; v2 parity: reference/v2/src/quick-options.js)
--
-- PRODUCTION DATA. Seven manageable, translatable multi-choice lists. The
-- Arabic labels are exactly the v2 labels, so the v2 migration can map old
-- free-text selections to option ids by comparing normalised Arabic text.
--
--   list_key              v2 key               v2 form label
--   daawa_activities      daawaActivities      current da'wah activity
--   social_features       socialFeatures       social features and interests
--   livelihoods           livelihoods          livelihoods and trade
--   religious_issues      religiousIssues      important religious issues
--   religious_challenges  religiousChallenges  religious challenges
--   social_challenges     socialChallenges     social challenges
--   proposed_activities   proposedActivities   proposed da'wah activities
--
-- Every list ends with the option "other" (sort_order 990): choosing it makes
-- the form show the free-text column community_profiles.<list_key>_other.
--
-- code       stable snake_case English identifier, never shown to users and
--            never changed once deployed (exports, imports and reports use it)
-- sort_order 10, 20, ... in v2 order, so new options can be inserted between
-- id         private.ref_uuid('option:<list_key>:<code>')
--
-- The official lists are owner decision #5 (docs/OWNER_DECISIONS.md): they are
-- edited from the admin screens. ON CONFLICT DO NOTHING keeps such edits.
-- =============================================================================

insert into public.option_values (id, list_key, code, name_ar, name_en, name_sw, sort_order, active)
select private.ref_uuid('option:' || v.list_key || ':' || v.code),
       v.list_key, v.code, v.name_ar, v.name_en, v.name_sw, v.sort_order, true
from (values
  -- daawa_activities ----------------------------------------------------------
  ('daawa_activities', 'quran_memorization_circles', 10, 'حلقات تحفيظ القرآن', 'Qur''an memorisation circles', 'Halaqa za kuhifadhi Qur''an'),
  ('daawa_activities', 'islamic_lessons',            20, 'دروس شرعية',         'Islamic studies lessons',       'Darasa za elimu ya dini'),
  ('daawa_activities', 'sermons_lectures',           30, 'خطب ومحاضرات',       'Sermons and lectures',          'Hotuba na mihadhara'),
  ('daawa_activities', 'daawa_visits',               40, 'زيارات دعوية',       'Da''wah visits',                'Ziara za da''wah'),
  ('daawa_activities', 'youth_activities',           50, 'أنشطة شبابية',       'Youth activities',              'Shughuli za vijana'),
  ('daawa_activities', 'women_activities',           60, 'أنشطة نسائية',       'Women''s activities',           'Shughuli za wanawake'),
  ('daawa_activities', 'training_courses',           70, 'دورات تعليمية',      'Educational courses',           'Kozi za mafunzo'),
  ('daawa_activities', 'community_aid',              80, 'مساعدات مجتمعية',    'Community aid',                 'Misaada kwa jamii'),
  ('daawa_activities', 'other',                     990, 'أخرى',               'Other',                         'Nyingine'),

  -- social_features -----------------------------------------------------------
  ('social_features', 'strong_community_cooperation', 10, 'تعاون مجتمعي قوي',          'Strong community cooperation', 'Ushirikiano imara wa jamii'),
  ('social_features', 'youth_participation',          20, 'مشاركة شبابية',             'Youth participation',          'Ushiriki wa vijana'),
  ('social_features', 'women_participation',          30, 'مشاركة نسائية',             'Women''s participation',       'Ushiriki wa wanawake'),
  ('social_features', 'orphan_care',                  40, 'رعاية الأيتام',             'Care for orphans',             'Malezi ya yatima'),
  ('social_features', 'needy_family_support',         50, 'رعاية الأسر المحتاجة',      'Care for needy families',      'Kusaidia familia zenye uhitaji'),
  ('social_features', 'community_volunteering',       60, 'تطوع مجتمعي',               'Community volunteering',       'Kujitolea kwa jamii'),
  ('social_features', 'community_councils',           70, 'مجالس أهلية',               'Community councils',           'Mabaraza ya wananchi'),
  ('social_features', 'weak_community_participation', 80, 'ضعف المشاركة المجتمعية',    'Weak community participation', 'Ushiriki mdogo wa jamii'),
  ('social_features', 'other',                       990, 'أخرى',                      'Other',                        'Nyingine'),

  -- livelihoods ---------------------------------------------------------------
  ('livelihoods', 'agriculture',     10, 'الزراعة',           'Agriculture',           'Kilimo'),
  ('livelihoods', 'fishing',         20, 'الصيد',             'Fishing',               'Uvuvi'),
  ('livelihoods', 'trade',           30, 'التجارة',           'Trade',                 'Biashara'),
  ('livelihoods', 'herding',         40, 'الرعي',             'Livestock herding',     'Ufugaji'),
  ('livelihoods', 'government_jobs', 50, 'الوظائف الحكومية',  'Government employment', 'Ajira za serikali'),
  ('livelihoods', 'crafts_trades',   60, 'الحرف والمهن',      'Crafts and trades',     'Ufundi na kazi za mikono'),
  ('livelihoods', 'daily_labour',    70, 'العمل اليومي',      'Daily wage labour',     'Kazi za kibarua'),
  ('livelihoods', 'tourism',         80, 'السياحة',           'Tourism',               'Utalii'),
  ('livelihoods', 'other',          990, 'أخرى',              'Other',                 'Nyingine'),

  -- religious_issues ----------------------------------------------------------
  ('religious_issues', 'weak_islamic_education',  10, 'ضعف التعليم الشرعي',          'Weak Islamic education',         'Udhaifu wa elimu ya dini'),
  ('religious_issues', 'imam_shortage',           20, 'نقص الأئمة',                  'Shortage of imams',              'Upungufu wa maimamu'),
  ('religious_issues', 'teacher_shortage',        30, 'نقص المعلمين',                'Shortage of teachers',           'Upungufu wa walimu'),
  ('religious_issues', 'weak_quran_memorization', 40, 'ضعف تحفيظ القرآن',            'Weak Qur''an memorisation',      'Udhaifu wa kuhifadhi Qur''an'),
  ('religious_issues', 'low_prayer_attendance',   50, 'ضعف حضور الصلاة',             'Low prayer attendance',          'Mahudhurio hafifu ya swala'),
  ('religious_issues', 'wrong_beliefs_practices', 60, 'معتقدات أو ممارسات خاطئة',    'Incorrect beliefs or practices', 'Imani au desturi potofu'),
  ('religious_issues', 'need_youth_programs',     70, 'حاجة لبرامج الشباب',          'Need for youth programmes',      'Uhitaji wa programu za vijana'),
  ('religious_issues', 'need_women_programs',     80, 'حاجة لبرامج النساء',          'Need for women''s programmes',   'Uhitaji wa programu za wanawake'),
  ('religious_issues', 'other',                  990, 'أخرى',                        'Other',                          'Nyingine'),

  -- religious_challenges ------------------------------------------------------
  ('religious_challenges', 'lack_qualified_staff',    10, 'نقص الكادر المؤهل',        'Shortage of qualified staff', 'Upungufu wa watumishi wenye sifa'),
  ('religious_challenges', 'weak_training',           20, 'ضعف التأهيل',              'Inadequate training',         'Mafunzo duni'),
  ('religious_challenges', 'few_teaching_materials',  30, 'قلة المواد التعليمية',     'Lack of teaching materials',  'Uhaba wa vifaa vya kufundishia'),
  ('religious_challenges', 'remote_settlements',      40, 'بُعد التجمعات السكانية',   'Remote settlements',          'Umbali wa makazi ya watu'),
  ('religious_challenges', 'low_attendance',          50, 'ضعف الحضور',               'Low attendance',              'Mahudhurio hafifu'),
  ('religious_challenges', 'multiple_languages',      60, 'تعدد اللغات',              'Multiple languages',          'Wingi wa lugha'),
  ('religious_challenges', 'sectarian_sensitivities', 70, 'حساسيات مذهبية',           'Sectarian sensitivities',     'Hisia za kimadhehebu'),
  ('religious_challenges', 'weak_funding',            80, 'ضعف التمويل',              'Insufficient funding',        'Uhaba wa fedha'),
  ('religious_challenges', 'other',                  990, 'أخرى',                     'Other',                       'Nyingine'),

  -- social_challenges ---------------------------------------------------------
  ('social_challenges', 'poverty',              10, 'الفقر',            'Poverty',              'Umaskini'),
  ('social_challenges', 'unemployment',         20, 'البطالة',          'Unemployment',         'Ukosefu wa ajira'),
  ('social_challenges', 'school_dropout',       30, 'التسرب الدراسي',   'School dropout',       'Kuacha shule'),
  ('social_challenges', 'early_marriage',       40, 'الزواج المبكر',    'Early marriage',       'Ndoa za mapema'),
  ('social_challenges', 'drugs',                50, 'المخدرات',         'Drugs',                'Dawa za kulevya'),
  ('social_challenges', 'poor_transport',       60, 'ضعف النقل',        'Poor transport',       'Usafiri duni'),
  ('social_challenges', 'scattered_population', 70, 'تشتت السكان',      'Scattered population', 'Mtawanyiko wa wakazi'),
  ('social_challenges', 'family_problems',      80, 'مشكلات أسرية',     'Family problems',      'Matatizo ya kifamilia'),
  ('social_challenges', 'other',               990, 'أخرى',             'Other',                'Nyingine'),

  -- proposed_activities -------------------------------------------------------
  ('proposed_activities', 'quran_circles',    10, 'حلقات قرآن',        'Qur''an circles',      'Halaqa za Qur''an'),
  ('proposed_activities', 'teacher_training', 20, 'تدريب المعلمين',    'Teacher training',     'Mafunzo ya walimu'),
  ('proposed_activities', 'imam_training',    30, 'تدريب الأئمة',      'Imam training',        'Mafunzo ya maimamu'),
  ('proposed_activities', 'public_lectures',  40, 'محاضرات عامة',      'Public lectures',      'Mihadhara ya hadhara'),
  ('proposed_activities', 'youth_programs',   50, 'برامج الشباب',      'Youth programmes',     'Programu za vijana'),
  ('proposed_activities', 'women_programs',   60, 'برامج النساء',      'Women''s programmes',  'Programu za wanawake'),
  ('proposed_activities', 'daawa_caravan',    70, 'قافلة دعوية',       'Da''wah caravan',      'Msafara wa da''wah'),
  ('proposed_activities', 'social_aid',       80, 'مساعدات اجتماعية',  'Social assistance',    'Misaada ya kijamii'),
  ('proposed_activities', 'other',           990, 'أخرى',              'Other',                'Nyingine')
) as v (list_key, code, sort_order, name_ar, name_en, name_sw)
on conflict do nothing;
