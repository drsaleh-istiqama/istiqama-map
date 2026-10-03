-- Localised dictionaries shared by export (brief §9: "headers and values in the user's
-- language: «مسجد» and «يعمل», not mosque / active") and by the import template (brief §10).
--
--   private.enum_labels         labels of every enumerated value in ar / sw / en
--   private.export_column_defs  ordered export columns with localised headers
--
-- Both are static reference data owned by migrations (not user-editable); they live in
-- schema private and are read only through the functions of the next migrations.

create table if not exists private.enum_labels (
  enum_key text not null,
  code text not null,
  sort_order smallint not null,
  ar text not null,
  sw text not null,
  en text not null,
  primary key (enum_key, code)
);
alter table private.enum_labels enable row level security;
revoke all on private.enum_labels from public, anon, authenticated;

insert into private.enum_labels (enum_key, code, sort_order, ar, sw, en) values
  ('project_type', 'mosque', 1, 'مسجد', 'Msikiti', 'Mosque'),
  ('project_type', 'school', 2, 'مدرسة قرآن', 'Madrasa ya Qur''ani', 'Qur''an school'),
  ('project_type', 'combined', 3, 'مسجد ومدرسة', 'Msikiti na madrasa', 'Mosque and school'),

  ('project_status', 'active', 1, 'يعمل', 'Inafanya kazi', 'Active'),
  ('project_status', 'maintenance', 2, 'يحتاج صيانة', 'Inahitaji matengenezo', 'Needs maintenance'),
  ('project_status', 'building', 3, 'قيد الإنشاء', 'Inajengwa', 'Under construction'),
  ('project_status', 'inactive', 4, 'متوقف', 'Imesimama', 'Inactive'),

  ('record_state', 'draft', 1, 'مسودة', 'Rasimu', 'Draft'),
  ('record_state', 'submitted', 2, 'مُرسل للمراجعة', 'Imewasilishwa', 'Submitted'),
  ('record_state', 'approved', 3, 'معتمد', 'Imeidhinishwa', 'Approved'),
  ('record_state', 'returned', 4, 'مُعاد للتعديل', 'Imerudishwa', 'Returned'),

  ('location_source', 'gps', 1, 'GPS', 'GPS', 'GPS'),
  ('location_source', 'map', 2, 'الخريطة', 'Ramani', 'Map'),
  ('location_source', 'import', 3, 'استيراد', 'Uingizaji', 'Import'),

  ('land_ownership', 'association', 1, 'ملك الجمعية', 'Mali ya jumuiya', 'Owned by the association'),
  ('land_ownership', 'waqf', 2, 'وقف', 'Wakfu', 'Waqf (endowment)'),
  ('land_ownership', 'person', 3, 'ملك شخص', 'Mali ya mtu binafsi', 'Privately owned'),
  ('land_ownership', 'government', 4, 'حكومية', 'Ya serikali', 'Government'),
  ('land_ownership', 'other', 5, 'أخرى', 'Nyingine', 'Other'),

  ('student_transport', 'available', 1, 'حافلة متوفرة', 'Basi lipo', 'Bus available'),
  ('student_transport', 'needed', 2, 'توجد حاجة لحافلة', 'Basi linahitajika', 'Bus needed'),
  ('student_transport', 'not_needed', 3, 'لا توجد حاجة', 'Halihitajiki', 'Not needed'),

  ('students_origin', 'nearby', 1, 'من المنطقة القريبة', 'Wa eneo la karibu', 'From nearby'),
  ('students_origin', 'mixed', 2, 'قريبون ومن مناطق بعيدة', 'Wa karibu na wa mbali', 'Nearby and distant'),
  ('students_origin', 'distant', 3, 'غالبهم من مناطق بعيدة', 'Wengi wa maeneo ya mbali', 'Mostly from distant areas'),

  ('maintenance_priority', 'urgent', 1, 'عاجلة', 'Dharura', 'Urgent'),
  ('maintenance_priority', 'high', 2, 'عالية', 'Juu', 'High'),
  ('maintenance_priority', 'medium', 3, 'متوسطة', 'Wastani', 'Medium'),
  ('maintenance_priority', 'low', 4, 'منخفضة', 'Chini', 'Low'),

  ('maintenance_state', 'open', 1, 'مفتوحة', 'Wazi', 'Open'),
  ('maintenance_state', 'in_progress', 2, 'قيد التنفيذ', 'Inaendelea', 'In progress'),
  ('maintenance_state', 'done', 3, 'منجزة', 'Imekamilika', 'Done'),
  ('maintenance_state', 'cancelled', 4, 'ملغاة', 'Imefutwa', 'Cancelled'),

  ('staff_role', 'imam', 1, 'إمام', 'Imamu', 'Imam'),
  ('staff_role', 'teacher', 2, 'معلم', 'Mwalimu', 'Teacher'),
  ('staff_role', 'agent', 3, 'وكيل', 'Wakala', 'Agent'),
  ('staff_role', 'administrator', 4, 'إداري', 'Afisa utawala', 'Administrator'),
  ('staff_role', 'manager', 5, 'مدير', 'Meneja', 'Manager'),
  ('staff_role', 'other', 6, 'أخرى', 'Nyingine', 'Other'),

  ('guest_financial_capacity', 'good', 1, 'جيدة', 'Nzuri', 'Good'),
  ('guest_financial_capacity', 'limited', 2, 'محدودة', 'Finyu', 'Limited'),
  ('guest_financial_capacity', 'none', 3, 'غير متوفرة', 'Hakuna', 'None'),

  ('boolean', 'true', 1, 'نعم', 'Ndiyo', 'Yes'),
  ('boolean', 'false', 2, 'لا', 'Hapana', 'No')
on conflict (enum_key, code) do update
  set sort_order = excluded.sort_order, ar = excluded.ar, sw = excluded.sw, en = excluded.en;

-- ---------------------------------------------------------------------------------------------
-- Export columns. `capability`: all | people | restricted — people/restricted columns are
-- OMITTED (not null-filled) for callers who may not see them.
-- `kind`: text | integer | number | date | datetime | boolean | enum | list
-- ---------------------------------------------------------------------------------------------

create table if not exists private.export_column_defs (
  position smallint primary key,
  key text not null unique,
  capability text not null default 'all' check (capability in ('all', 'people', 'restricted')),
  kind text not null check (kind in ('text', 'integer', 'number', 'date', 'datetime', 'boolean', 'enum', 'list')),
  enum_key text,
  ar text not null,
  sw text not null,
  en text not null
);
alter table private.export_column_defs enable row level security;
revoke all on private.export_column_defs from public, anon, authenticated;

insert into private.export_column_defs (position, key, capability, kind, enum_key, ar, sw, en) values
  -- project
  (10, 'code', 'all', 'text', null, 'رمز المشروع', 'Namba ya mradi', 'Project code'),
  (20, 'name_ar', 'all', 'text', null, 'اسم المشروع (عربي)', 'Jina la mradi (Kiarabu)', 'Project name (Arabic)'),
  (30, 'name_latin', 'all', 'text', null, 'اسم المشروع (لاتيني)', 'Jina la mradi (Kilatini)', 'Project name (Latin)'),
  (40, 'type', 'all', 'enum', 'project_type', 'النوع', 'Aina', 'Type'),
  (50, 'status', 'all', 'enum', 'project_status', 'الحالة', 'Hali', 'Status'),
  (60, 'record_state', 'all', 'enum', 'record_state', 'حالة السجل', 'Hali ya rekodi', 'Record state'),
  (70, 'capacity', 'all', 'integer', null, 'السعة', 'Uwezo', 'Capacity'),
  (80, 'country', 'all', 'text', null, 'الدولة', 'Nchi', 'Country'),
  (90, 'country_iso2', 'all', 'text', null, 'رمز الدولة', 'Msimbo wa nchi', 'Country code'),
  (100, 'area_level1', 'all', 'text', null, 'الإقليم / المحافظة', 'Mkoa', 'Region'),
  (110, 'area_level2', 'all', 'text', null, 'المقاطعة', 'Wilaya', 'District'),
  (120, 'area_level3', 'all', 'text', null, 'البلدة / القرية', 'Kata / Kijiji', 'Ward / Village'),
  (130, 'admin_area_code', 'all', 'text', null, 'رمز المنطقة الإدارية', 'Msimbo wa eneo', 'Admin area code'),
  (140, 'locality', 'all', 'text', null, 'الموقع المحلي', 'Kijiji / Mtaa', 'Locality'),
  (150, 'branch', 'all', 'text', null, 'الفرع', 'Tawi', 'Branch'),
  (160, 'lat', 'all', 'number', null, 'خط العرض', 'Latitudo', 'Latitude'),
  (170, 'lon', 'all', 'number', null, 'خط الطول', 'Longitudo', 'Longitude'),
  (180, 'gps_accuracy_m', 'all', 'number', null, 'دقة GPS (متر)', 'Usahihi wa GPS (mita)', 'GPS accuracy (m)'),
  (190, 'location_source', 'all', 'enum', 'location_source', 'مصدر الموقع', 'Chanzo cha eneo', 'Location source'),
  (200, 'builder', 'all', 'text', null, 'الجهة البانية', 'Mjenzi', 'Builder'),
  (210, 'build_year', 'all', 'integer', null, 'سنة البناء', 'Mwaka wa ujenzi', 'Build year'),
  (220, 'build_date', 'all', 'date', null, 'تاريخ البناء', 'Tarehe ya ujenzi', 'Build date'),
  (230, 'completeness', 'all', 'integer', null, 'نسبة اكتمال البيانات (%)', 'Ukamilifu wa data (%)', 'Data completeness (%)'),
  (240, 'review_note', 'all', 'text', null, 'ملاحظة المراجعة', 'Maoni ya mapitio', 'Review note'),
  -- land
  (300, 'land_ownership', 'all', 'enum', 'land_ownership', 'ملكية الأرض', 'Umiliki wa ardhi', 'Land ownership'),
  (310, 'land_owner_name', 'all', 'text', null, 'مالك الأرض', 'Mmiliki wa ardhi', 'Land owner'),
  (320, 'land_area_m2', 'all', 'number', null, 'مساحة الأرض (م²)', 'Eneo la ardhi (m²)', 'Land area (m²)'),
  (330, 'land_utilization_pct', 'all', 'number', null, 'نسبة استغلال الأرض (%)', 'Matumizi ya ardhi (%)', 'Land utilisation (%)'),
  (340, 'land_expandable', 'all', 'boolean', 'boolean', 'قابلية التوسع', 'Inaweza kupanuliwa', 'Expandable'),
  (350, 'land_notes', 'all', 'text', null, 'ملاحظات الأرض', 'Maelezo ya ardhi', 'Land notes'),
  -- facilities
  (400, 'teacher_housing', 'all', 'boolean', 'boolean', 'سكن المعلمين', 'Makazi ya walimu', 'Teacher housing'),
  (410, 'imam_housing', 'all', 'boolean', 'boolean', 'سكن الإمام', 'Makazi ya imamu', 'Imam housing'),
  (420, 'guest_housing', 'all', 'boolean', 'boolean', 'سكن الضيوف', 'Makazi ya wageni', 'Guest housing'),
  (430, 'library', 'all', 'boolean', 'boolean', 'المكتبة', 'Maktaba', 'Library'),
  (440, 'quran_count', 'all', 'integer', null, 'عدد المصاحف', 'Idadi ya misahafu', 'Qur''an copies'),
  (450, 'quran_need', 'all', 'integer', null, 'المصاحف المطلوبة', 'Misahafu inayohitajika', 'Qur''an copies needed'),
  (460, 'hall', 'all', 'boolean', 'boolean', 'القاعة', 'Ukumbi', 'Hall'),
  (470, 'hall_capacity', 'all', 'integer', null, 'سعة القاعة', 'Uwezo wa ukumbi', 'Hall capacity'),
  (480, 'student_transport', 'all', 'enum', 'student_transport', 'نقل الطلاب', 'Usafiri wa wanafunzi', 'Student transport'),
  (490, 'students_origin', 'all', 'enum', 'students_origin', 'نطاق سكن الطلاب', 'Makazi ya wanafunzi', 'Students'' origin'),
  -- community profile
  (500, 'community_branch_name', 'all', 'text', null, 'اسم الفرع', 'Jina la tawi', 'Branch name'),
  (510, 'population', 'all', 'integer', null, 'عدد السكان', 'Idadi ya watu', 'Population'),
  (520, 'muslim_pct', 'all', 'number', null, 'نسبة المسلمين (%)', 'Waislamu (%)', 'Muslims (%)'),
  (530, 'daawa_activities', 'all', 'list', null, 'الأنشطة الدعوية', 'Shughuli za daawa', 'Da''wah activities'),
  (540, 'social_features', 'all', 'list', null, 'المظاهر الاجتماعية', 'Sifa za kijamii', 'Social features'),
  (550, 'livelihoods', 'all', 'list', null, 'سبل المعيشة', 'Njia za kujipatia riziki', 'Livelihoods'),
  (560, 'religious_issues', 'all', 'list', null, 'القضايا الدينية', 'Masuala ya kidini', 'Religious issues'),
  (570, 'religious_challenges', 'all', 'list', null, 'التحديات الدينية', 'Changamoto za kidini', 'Religious challenges'),
  (580, 'social_challenges', 'all', 'list', null, 'التحديات الاجتماعية', 'Changamoto za kijamii', 'Social challenges'),
  (590, 'proposed_activities', 'all', 'list', null, 'الأنشطة المقترحة', 'Shughuli zinazopendekezwa', 'Proposed activities'),
  -- donors, maintenance, counts
  (600, 'donors', 'all', 'list', null, 'المتبرعون', 'Wafadhili', 'Donors'),
  (610, 'maintenance_open', 'all', 'integer', null, 'الصيانة المفتوحة (عدد)', 'Matengenezo yaliyo wazi', 'Open maintenance entries'),
  (620, 'maintenance_total', 'all', 'integer', null, 'إجمالي سجلات الصيانة', 'Jumla ya rekodi za matengenezo', 'Maintenance entries (all)'),
  (630, 'maintenance_last_reported', 'all', 'date', null, 'آخر بلاغ صيانة', 'Ripoti ya mwisho ya matengenezo', 'Last maintenance report'),
  (640, 'maintenance_open_details', 'all', 'list', null, 'تفاصيل الصيانة المفتوحة', 'Maelezo ya matengenezo yaliyo wazi', 'Open maintenance details'),
  (650, 'maintenance_open_cost', 'all', 'list', null, 'التكلفة التقديرية للصيانة المفتوحة', 'Gharama inayokadiriwa ya matengenezo', 'Estimated open maintenance cost'),
  (660, 'photo_count', 'all', 'integer', null, 'عدد الصور', 'Idadi ya picha', 'Photos'),
  (670, 'staff_count', 'all', 'integer', null, 'عدد الكادر', 'Idadi ya wafanyakazi', 'Staff count'),
  -- people (omitted for viewers)
  (700, 'manager_name', 'people', 'text', null, 'المسؤول', 'Msimamizi', 'Manager'),
  (710, 'manager_phone', 'people', 'text', null, 'هاتف المسؤول', 'Simu ya msimamizi', 'Manager phone'),
  (720, 'staff_list', 'people', 'list', null, 'أسماء الكادر', 'Majina ya wafanyakazi', 'Staff names'),
  (730, 'entered_by', 'people', 'text', null, 'المُدخِل', 'Aliyeingiza', 'Entered by'),
  -- restricted (omitted unless the caller may see restricted data)
  (800, 'monthly_payroll', 'restricted', 'list', null, 'إجمالي الرواتب الشهرية (بالعملة المحلية)', 'Jumla ya mishahara ya mwezi (sarafu ya ndani)', 'Monthly payroll (local currency)'),
  (810, 'monthly_payroll_usd', 'restricted', 'number', null, 'إجمالي الرواتب الشهرية (دولار أمريكي)', 'Jumla ya mishahara ya mwezi (USD)', 'Monthly payroll (USD)'),
  (820, 'ibadi_families', 'restricted', 'integer', null, 'العوائل الإباضية', 'Familia za Kiibadhi', 'Ibadi families'),
  (830, 'omani_families', 'restricted', 'integer', null, 'العوائل العُمانية', 'Familia za Kiomani', 'Omani families'),
  (840, 'omani_student_pct', 'restricted', 'number', null, 'نسبة الطلاب العُمانيين (%)', 'Wanafunzi Waomani (%)', 'Omani students (%)'),
  (850, 'ibadi_student_pct', 'restricted', 'number', null, 'نسبة الطلاب الإباضيين (%)', 'Wanafunzi Waibadhi (%)', 'Ibadi students (%)'),
  (860, 'omani_teacher_pct', 'restricted', 'number', null, 'نسبة المعلمين العُمانيين (%)', 'Walimu Waomani (%)', 'Omani teachers (%)'),
  (870, 'ibadi_teacher_pct', 'restricted', 'number', null, 'نسبة المعلمين الإباضيين (%)', 'Walimu Waibadhi (%)', 'Ibadi teachers (%)'),
  (880, 'guest_financial_capacity', 'restricted', 'enum', 'guest_financial_capacity', 'القدرة المالية لاستقبال الضيوف', 'Uwezo wa kifedha wa kupokea wageni', 'Financial capacity to host guests'),
  -- identifiers and timestamps (last: rarely read by people, needed for re-import / merge)
  (900, 'external_id', 'all', 'text', null, 'المعرّف الخارجي', 'Kitambulisho cha nje', 'External ID'),
  (910, 'id', 'all', 'text', null, 'معرّف النظام', 'Kitambulisho cha mfumo', 'System ID'),
  (920, 'created_at', 'all', 'datetime', null, 'تاريخ الإدخال', 'Tarehe ya kuingizwa', 'Created at'),
  (930, 'updated_at', 'all', 'datetime', null, 'آخر تحديث', 'Imesasishwa mwisho', 'Updated at')
on conflict (position) do update
  set key = excluded.key, capability = excluded.capability, kind = excluded.kind,
      enum_key = excluded.enum_key, ar = excluded.ar, sw = excluded.sw, en = excluded.en;

-- Localised label of one enumerated value (fallback: the code itself).
create or replace function private.enum_label(p_enum text, p_code text, p_lang text)
returns text
language sql
stable
set search_path = public, extensions, private, pg_temp
as $$
  select coalesce(
    (select case p_lang when 'ar' then l.ar when 'sw' then l.sw else l.en end
     from private.enum_labels l
     where l.enum_key = p_enum and l.code = p_code),
    p_code)
$$;

revoke execute on function private.enum_label(text, text, text) from public, anon, authenticated;
