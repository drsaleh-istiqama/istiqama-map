-- =============================================================================
-- 0063  Reference data (4/4): default application settings
--
-- PRODUCTION DATA. Key/value defaults taken from the brief. hq_admin edits them
-- from the admin screens; ON CONFLICT DO NOTHING keeps such edits.
--
--   is_public = true   readable by every signed-in user (the web app loads them
--                      once after sign-in and falls back to the same built-in
--                      defaults when offline)
--   is_public = false  hq_admin and server-side jobs only
--
-- IMPORTANT: several server functions currently compile the same numbers in as
-- constants (project_duplicates: 150 m / 0.6, person_candidates: 0.6, the photo
-- limit trigger: 10, photo retention: 90 days, report refresh: 15 minutes).
-- Changing one of those settings here does NOT change the server behaviour
-- until the owning function reads the setting; the rows document the agreed
-- defaults and drive the client-side behaviour (warnings, timers, sizes).
--
-- id = private.ref_uuid('setting:<key>'). Values are JSON.
-- =============================================================================

insert into public.app_settings (id, key, value, description, is_public)
select private.ref_uuid('setting:' || v.key), v.key, v.value::jsonb, v.description, v.is_public
from (values
  -- Duplicate detection and matching (brief sections 2.4, 7.3) -----------------
  ('duplicates.radius_m', '150',
   'A project of the same type closer than this many metres is offered as a possible duplicate.', true),
  ('duplicates.name_similarity', '0.6',
   'Minimum trigram similarity (0..1) for a project with a similar name in the same locality.', true),
  ('persons.name_similarity', '0.6',
   'Minimum trigram similarity (0..1) for "possible matching persons". Persons are never merged automatically.', true),

  -- Location capture (brief section 7.1) ----------------------------------------
  ('gps.accuracy_warn_m', '30',
   'The form warns when the GPS accuracy is worse than this many metres.', true),

  -- Device security (brief section 3) -------------------------------------------
  ('security.pin_lock_minutes', '15',
   'The app locks behind the PIN after this many minutes without interaction.', true),

  -- Photos (brief sections 6, 11) -----------------------------------------------
  ('photos.max_per_project', '10',
   'Maximum number of live photos per project.', true),
  ('photos.full_max_px', '1600',
   'Longest edge of the full-size photo after on-device compression, in pixels.', true),
  ('photos.thumb_max_px', '400',
   'Longest edge of the thumbnail, in pixels.', true),
  ('photos.quality', '0.8',
   'Encoder quality (0..1) of the on-device WebP/JPEG compression.', true),
  ('photos.retention_days', '90',
   'Soft-deleted photos are removed from object storage after this many days.', false),

  -- Sync (brief section 4) ------------------------------------------------------
  ('sync.push_batch_size', '50',
   'Maximum number of outbox operations per sync_push call.', true),
  ('sync.pull_page_size', '500',
   'Rows per sync_pull page.', true),
  ('sync.interval_seconds', '120',
   'Automatic sync interval while online, in seconds.', true),

  -- Form, lists, search, map (brief sections 5, 7.4) ----------------------------
  ('form.autosave_seconds', '5',
   'The project form saves its draft to the device every this many seconds (and on every field change).', true),
  ('list.page_size', '50',
   'Rows per keyset page in lists.', true),
  ('search.debounce_ms', '250',
   'Delay between the last key press and the search request, in milliseconds.', true),
  ('map.local_points_min_zoom', '14',
   'From this zoom level on the map draws individual points from the local database instead of server tiles.', true),

  -- Reports (brief section 5) ---------------------------------------------------
  ('reports.refresh_minutes', '15',
   'Refresh interval of the report materialized views, in minutes.', false),

  -- Exchange rates (migration 0062) ---------------------------------------------
  ('fx.placeholder',
   '{"placeholder": true, "effective_date": "2025-01-01", "currencies": ["TZS", "KES", "UGX", "RWF", "BIF", "MZN"], "note": "Indicative rates only. The owner must confirm or replace them (docs/OWNER_DECISIONS.md)."}',
   'While "placeholder" is true the fx_rates rows dated 2025-01-01 are unconfirmed indicative values; USD figures in reports are approximate. An administrator sets it to false after entering official rates.', true)
) as v (key, value, description, is_public)
on conflict do nothing;
