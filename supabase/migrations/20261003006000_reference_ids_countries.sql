-- =============================================================================
-- 0060  Reference data (1/4): deterministic ids + countries
--       (brief section 0 "countries are managed from the database", section 2.1)
--
-- PRODUCTION DATA. Everything in migrations 0060-0069 is real reference data
-- that every environment needs; demo branches, users and projects live only in
-- supabase/seed.staging.sql (brief section 7.8).
--
-- Rules followed by all reference-data migrations:
--   * idempotent: INSERT ... ON CONFLICT DO NOTHING (no target, so an existing
--     row with the same id OR the same natural key is left alone). Rows that an
--     administrator already changed are therefore never overwritten.
--   * deterministic ids: private.ref_uuid(<key>), so the same row has the same
--     id in every environment (local, CI, staging, production) and offline
--     devices can be moved between environments without re-mapping.
--
-- Contract for other teams: docs/contracts/reference-data.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private.ref_uuid(key): name-based UUID (RFC 9562 version 3 layout) derived
-- from md5('istiqama-map:' || key). The version nibble is forced to 3 and the
-- variant nibble to 8..b, so strict UUID validators accept the value.
--
-- TypeScript twin: scripts/import-boundaries/ref-uuid.ts (refUuid).
--
-- Key scheme (docs/contracts/reference-data.md, section 1):
--   country:<ISO2>                       option:<list_key>:<code>
--   fx:<CUR>:<YYYY-MM-DD>                setting:<key>
--   admin_area:<ISO3>:<level>:<code>     locality:v2:<ISO2>:<region>:<name>
--   seed:<kind>:<key>                    (staging seed only)
-- -----------------------------------------------------------------------------
create or replace function private.ref_uuid(p_key text)
returns uuid
language sql
immutable
strict
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select (
    substr(s.h, 1, 12)
    || '3'
    || substr(s.h, 14, 3)
    || substr('89ab', (('x' || substr(s.h, 17, 1))::bit(4)::integer % 4) + 1, 1)
    || substr(s.h, 18)
  )::uuid
  from (select md5('istiqama-map:' || p_key) as h) s;
$$;

comment on function private.ref_uuid(text) is
  'Deterministic name-based UUID (version-3 layout) of md5(''istiqama-map:'' || key). Used for reference data and the staging seed.';

-- Pure function without side effects; still not something an API caller needs.
revoke all on function private.ref_uuid(text) from public, anon, authenticated;
grant execute on function private.ref_uuid(text) to service_role;

-- -----------------------------------------------------------------------------
-- Countries: the seven countries of v2 (reference/v2/src/locations.js).
-- Tanzania includes Zanzibar and Pemba. Arabic names exactly as in v2.
-- The final list is owner decision #3 (docs/OWNER_DECISIONS.md): further
-- countries are added, or these deactivated, from the admin screens.
-- -----------------------------------------------------------------------------
insert into public.countries (id, iso2, iso3, name_ar, name_en, name_sw, default_currency, active)
values
  (private.ref_uuid('country:TZ'), 'TZ', 'TZA', 'تنزانيا', 'Tanzania',   'Tanzania', 'TZS', true),
  (private.ref_uuid('country:KE'), 'KE', 'KEN', 'كينيا',   'Kenya',      'Kenya',    'KES', true),
  (private.ref_uuid('country:UG'), 'UG', 'UGA', 'أوغندا',  'Uganda',     'Uganda',   'UGX', true),
  (private.ref_uuid('country:RW'), 'RW', 'RWA', 'رواندا',  'Rwanda',     'Rwanda',   'RWF', true),
  (private.ref_uuid('country:BI'), 'BI', 'BDI', 'بوروندي', 'Burundi',    'Burundi',  'BIF', true),
  (private.ref_uuid('country:MZ'), 'MZ', 'MOZ', 'موزمبيق', 'Mozambique', 'Msumbiji', 'MZN', true),
  (private.ref_uuid('country:OM'), 'OM', 'OMN', 'عُمان',   'Oman',       'Omani',    'OMR', true)
on conflict do nothing;
