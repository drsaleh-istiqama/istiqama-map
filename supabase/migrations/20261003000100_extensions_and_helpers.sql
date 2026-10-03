-- =============================================================================
-- 0001  Extensions, schema "private" and generic helpers
--       (docs/ARCHITECTURE.md section 2, Appendix A.3; brief sections 1 and 5)
--
--   private.current_xid()   id of the current top-level transaction (sync cursor)
--   private.safe_xid()      xmin of the current snapshot (upper bound of a pull round)
--   private.device_id()     x-device-id request header / app.device_id setting
--   private.f_unaccent()    IMMUTABLE wrapper around extensions.unaccent()
--   private.norm()          search normalisation (Arabic + Latin), IMMUTABLE
--   private.uuid_v7()       server-side UUIDv7
--   private.mask_phone()    masks the middle of a phone number
--
-- Reference for other teams: docs/contracts/schema.md
--
-- This file is kept pure ASCII on purpose: every non-ASCII character is written
-- as a U&'\XXXX' escape, so no editor or tool can silently alter the invisible
-- and combining characters the normalisation deals with.
-- =============================================================================

-- Schema "extensions" is provided by Supabase (locally by the shim).
create extension if not exists postgis  with schema extensions;
create extension if not exists pg_trgm  with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- Schema "private": helpers and bookkeeping tables. It is never listed in the
-- PostgREST exposed schemas, so nothing in it is reachable through the API.
-- `authenticated` needs USAGE because column defaults, triggers and RLS
-- policies evaluate private.* functions with the privileges of the caller.
-- -----------------------------------------------------------------------------
create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

comment on schema private is
  'Internal helpers, trigger functions and bookkeeping tables. Not exposed through the API.';

-- -----------------------------------------------------------------------------
-- Transaction ids used by the sync protocol (ARCHITECTURE 3.2, decision D2).
-- xid8 is the 64-bit, never-wrapping transaction id; inside a sub-transaction
-- pg_current_xact_id() still returns the id of the top-level transaction.
-- -----------------------------------------------------------------------------
create or replace function private.current_xid()
returns bigint
language sql
stable
set search_path = public, extensions, private, pg_temp
as $$
  select pg_current_xact_id()::text::bigint;
$$;

comment on function private.current_xid() is
  'Id of the current top-level transaction as bigint; stored in sync_xid by private.tg_std().';

create or replace function private.safe_xid()
returns bigint
language sql
stable
set search_path = public, extensions, private, pg_temp
as $$
  select pg_snapshot_xmin(pg_current_snapshot())::text::bigint;
$$;

comment on function private.safe_xid() is
  'xmin of the current snapshot: every transaction with a smaller id has finished. Exclusive upper bound of a sync_pull round.';

-- -----------------------------------------------------------------------------
-- Device id of the current request: PostgREST exposes request headers as the
-- JSON setting request.headers (lower-cased names). Server-side code and tests
-- may use "set local app.device_id = ..." instead.
-- -----------------------------------------------------------------------------
create or replace function private.device_id()
returns text
language sql
stable
set search_path = public, extensions, private, pg_temp
as $$
  select left(
    coalesce(
      nullif(btrim(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-device-id'), ''),
      nullif(btrim(current_setting('app.device_id', true)), '')
    ),
    128
  );
$$;

comment on function private.device_id() is
  'x-device-id request header, else the app.device_id setting, else NULL (max 128 characters).';

-- -----------------------------------------------------------------------------
-- Search normalisation (brief section 5).
--
-- unaccent(regdictionary, text) is only STABLE because the dictionary could be
-- altered; we never alter it, so the wrapper is declared IMMUTABLE. That makes
-- private.norm() usable in indexes and lets the planner fold norm('constant').
-- -----------------------------------------------------------------------------
create or replace function private.f_unaccent(p text)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, p);
$$;

comment on function private.f_unaccent(text) is
  'IMMUTABLE wrapper around extensions.unaccent(''extensions.unaccent'', text).';

-- private.norm(text): the canonical algorithm (the TypeScript twin is
-- apps/web/src/lib/normalize.ts; both run against supabase/tests/fixtures/normalize.json):
--
--   0. Unicode NFC, so that composed and decomposed input behave the same;
--   1. remove Arabic tashkeel U+064B..U+065F, U+0670, U+06D6..U+06ED, tatweel U+0640
--      and the invisible format characters U+200B..U+200F, U+202A..U+202E,
--      U+2066..U+2069, U+FEFF;
--   2. strip Latin diacritics (unaccent rules), then drop any combining mark
--      U+0300..U+036F that is left;
--   3. lower-case;
--   4. alef variants U+0623 U+0625 U+0622 -> U+0627, alef maqsura U+0649 -> yeh U+064A,
--      teh marbuta U+0629 -> heh U+0647;
--   5. every run of white space (U+0009..U+000D, U+0020, U+0085, U+00A0, U+1680,
--      U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 - an explicit list,
--      independent of the database locale) becomes one space; trim both ends.
--
-- NULL in, NULL out. Diacritics are removed BEFORE lower-casing so that the
-- result does not depend on LC_CTYPE (lower() only has to handle ASCII).
create or replace function private.norm(p text)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select btrim(
    regexp_replace(
      translate(
        lower(
          regexp_replace(
            private.f_unaccent(
              regexp_replace(
                normalize(p, NFC),
                U&'[\064B-\065F\0670\06D6-\06ED\0640\200B-\200F\202A-\202E\2066-\2069\FEFF]',
                '',
                'g'
              )
            ),
            U&'[\0300-\036F]',
            '',
            'g'
          )
        ),
        U&'\0623\0625\0622\0649\0629',
        U&'\0627\0627\0627\064A\0647'
      ),
      U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]+',
      ' ',
      'g'
    ),
    ' '
  );
$$;

comment on function private.norm(text) is
  'Search normalisation: strips tashkeel/tatweel and Latin diacritics, lower-cases, unifies alef/yeh/teh-marbuta, collapses white space. IMMUTABLE, NULL-safe.';

-- -----------------------------------------------------------------------------
-- UUIDv7 (time-ordered): 48-bit Unix milliseconds + random bits from a v4 UUID
-- with the version nibble rewritten to 7. Clients generate their own ids; this
-- is the column default for rows created on the server.
-- -----------------------------------------------------------------------------
create or replace function private.uuid_v7()
returns uuid
language sql
volatile
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          placing substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;

comment on function private.uuid_v7() is 'Server-side UUIDv7 generator (RFC 9562).';

-- -----------------------------------------------------------------------------
-- Phone masking for anything a viewer can reach (brief section 11):
-- keep the first 4 characters ("+" and the country code) and the last 3,
-- replace the rest by bullets (U+2022).
-- -----------------------------------------------------------------------------
create or replace function private.mask_phone(p text)
returns text
language sql
immutable
parallel safe
set search_path = public, extensions, private, pg_temp
as $$
  select case
    when p is null then null
    when length(p) < 8 then repeat(U&'\2022', length(p))
    else left(p, 4) || repeat(U&'\2022', length(p) - 7) || right(p, 3)
  end;
$$;

comment on function private.mask_phone(text) is
  'Masks a phone number: first 4 and last 3 characters stay, the rest become bullets (+255712345678 -> +255, six bullets, 678). Shorter than 8 characters: fully masked.';
