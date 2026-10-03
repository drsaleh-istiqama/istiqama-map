-- =============================================================================
-- supabase-shim.sql — what a real Supabase project provides out of the box
--
-- LOCAL STACK ONLY. Run by the superuser on a fresh database BEFORE the
-- migrations (scripts/local-stack/db-reset.ts). On Supabase Cloud, self-hosted
-- Supabase and the Supabase CLI all of this already exists, so nothing in
-- supabase/migrations may depend on anything that is not also present there.
--
-- Provides:
--   * roles      anon, authenticated, service_role, authenticator,
--                supabase_auth_admin, supabase_storage_admin (+ API timeouts)
--   * schemas    extensions, auth, storage (+ grants and DEFAULT PRIVILEGES:
--                everything created in "public" is granted to the API roles,
--                exactly like Supabase — migrations must revoke explicitly)
--   * auth       GoTrue tables (users, identities, sessions, refresh_tokens,
--                mfa_factors, mfa_challenges, mfa_amr_claims, one_time_tokens)
--                and auth.uid() / auth.role() / auth.email() / auth.jwt()
--   * storage    buckets, objects (RLS enabled), foldername/filename/extension
--   * PostgREST  schema-cache reload event triggers (pgrst_ddl_watch)
--
-- Not provided (absent locally, see docs/contracts/local-gateway.md):
--   pg_cron, pg_net, vault, realtime, pg_graphql, supautils, pg-safeupdate.
--
-- Idempotent and safe to run concurrently against different databases of the
-- same cluster (roles are cluster-wide).
-- =============================================================================

set client_min_messages = warning;

-- -----------------------------------------------------------------------------
-- 1. Roles (cluster-wide)
-- -----------------------------------------------------------------------------
do $roles$
declare
  r record;
begin
  for r in
    select *
    from (values
      -- name, options used on creation, attributes enforced on an existing role
      ('anon',                   'nologin noinherit',                                     'nologin noinherit'),
      ('authenticated',          'nologin noinherit',                                     'nologin noinherit'),
      ('service_role',           'nologin noinherit bypassrls',                           'nologin noinherit bypassrls'),
      ('authenticator',          'login noinherit password ''postgres''',                 'login noinherit'),
      ('supabase_auth_admin',    'login noinherit createrole noreplication password ''postgres''', 'login noinherit createrole'),
      ('supabase_storage_admin', 'login noinherit createrole noreplication password ''postgres''', 'login noinherit createrole')
    ) as t (name, create_options, enforce_options)
  loop
    begin
      if not exists (select 1 from pg_catalog.pg_roles where rolname = r.name) then
        execute format('create role %I %s', r.name, r.create_options);
      elsif exists (
        -- stub roles created by hand before the shim existed: fix their attributes
        select 1
        from pg_catalog.pg_roles x
        where x.rolname = r.name
          and (x.rolinherit
               or x.rolcanlogin is distinct from (r.enforce_options like 'login%')
               or x.rolbypassrls is distinct from (r.enforce_options like '%bypassrls%')
               or x.rolcreaterole is distinct from (r.enforce_options like '%createrole%'))
      ) then
        execute format('alter role %I %s', r.name, r.enforce_options);
      end if;
    exception
      -- another db:reset created/altered the same role at the same moment
      when duplicate_object or unique_violation or internal_error then null;
    end;
  end loop;
end
$roles$;

-- PostgREST logs in as "authenticator" and switches to the role named in the JWT.
do $members$
declare
  m text;
begin
  foreach m in array array['anon', 'authenticated', 'service_role'] loop
    begin
      if not pg_catalog.pg_has_role('authenticator', m, 'MEMBER') then
        execute format('grant %I to authenticator', m);
      end if;
    exception
      when duplicate_object or unique_violation or internal_error then null;
    end;
  end loop;
end
$members$;

-- Statement timeouts of the API roles, as on Supabase (PostgREST applies the
-- settings of the impersonated role to every request). A request that needs
-- more than 8 s fails in production too.
do $settings$
declare
  r record;
begin
  for r in
    select *
    from (values
      ('anon',                   'statement_timeout', '3s'),
      ('authenticated',          'statement_timeout', '8s'),
      ('authenticator',          'statement_timeout', '8s'),
      ('authenticator',          'lock_timeout',      '8s'),
      ('supabase_auth_admin',    'search_path',       'auth'),
      ('supabase_storage_admin', 'search_path',       'storage')
    ) as t (role_name, setting, value)
  loop
    begin
      if not exists (
        select 1
        from pg_catalog.pg_db_role_setting s
        join pg_catalog.pg_roles x on x.oid = s.setrole
        where s.setdatabase = 0
          and x.rolname = r.role_name
          and (r.setting || '=' || r.value) = any (s.setconfig)
      ) then
        execute format('alter role %I set %I = %L', r.role_name, r.setting, r.value);
      end if;
    exception
      when internal_error or unique_violation then null;   -- concurrent ALTER ROLE
    end;
  end loop;
end
$settings$;

-- -----------------------------------------------------------------------------
-- 2. Schemas, grants and Supabase's default privileges
-- -----------------------------------------------------------------------------
create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;

alter schema auth owner to supabase_auth_admin;
alter schema storage owner to supabase_storage_admin;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant all on schema auth to supabase_auth_admin;
grant all on schema storage to supabase_storage_admin;

-- THE Supabase footgun, reproduced on purpose (docs/ARCHITECTURE.md Appendix A.1):
-- every table, function and sequence created in "public" by the migration role is
-- granted to anon, authenticated and service_role. Migrations revoke explicitly.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

alter default privileges in schema storage grant all on tables to anon, authenticated, service_role;
alter default privileges in schema storage grant all on routines to anon, authenticated, service_role;
alter default privileges in schema storage grant all on sequences to anon, authenticated, service_role;

-- New sessions: "$user", public, extensions (as on Supabase).
do $search_path$
begin
  execute format('alter database %I set search_path to "$user", public, extensions', current_database());
end
$search_path$;

set search_path to "$user", public, extensions;

-- -----------------------------------------------------------------------------
-- 3. Extensions that Supabase pre-installs in schema "extensions"
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

do $ext$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'uuid-ossp') then
    create extension if not exists "uuid-ossp" with schema extensions;
  end if;
end
$ext$;

-- -----------------------------------------------------------------------------
-- 4. auth schema (GoTrue). Same column names and types as the real schema.
-- -----------------------------------------------------------------------------
do $types$
begin
  if to_regtype('auth.aal_level') is null then
    create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
  end if;
  if to_regtype('auth.factor_type') is null then
    create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
  end if;
  if to_regtype('auth.factor_status') is null then
    create type auth.factor_status as enum ('unverified', 'verified');
  end if;
  if to_regtype('auth.code_challenge_method') is null then
    create type auth.code_challenge_method as enum ('s256', 'plain');
  end if;
  if to_regtype('auth.one_time_token_type') is null then
    create type auth.one_time_token_type as enum (
      'confirmation_token', 'reauthentication_token', 'recovery_token',
      'email_change_token_new', 'email_change_token_current', 'phone_change_token');
  end if;
end
$types$;

create table if not exists auth.users (
  instance_id                 uuid,
  id                          uuid not null primary key,
  aud                         varchar(255),
  role                        varchar(255),
  email                       varchar(255),
  encrypted_password          varchar(255),
  email_confirmed_at          timestamptz,
  invited_at                  timestamptz,
  confirmation_token          varchar(255),
  confirmation_sent_at        timestamptz,
  recovery_token              varchar(255),
  recovery_sent_at            timestamptz,
  email_change_token_new      varchar(255),
  email_change                varchar(255),
  email_change_sent_at        timestamptz,
  last_sign_in_at             timestamptz,
  raw_app_meta_data           jsonb,
  raw_user_meta_data          jsonb,
  is_super_admin              boolean,
  created_at                  timestamptz,
  updated_at                  timestamptz,
  phone                       text default null,
  phone_confirmed_at          timestamptz,
  phone_change                text default '',
  phone_change_token          varchar(255) default '',
  phone_change_sent_at        timestamptz,
  confirmed_at                timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current  varchar(255) default '',
  email_change_confirm_status smallint default 0,
  banned_until                timestamptz,
  reauthentication_token      varchar(255) default '',
  reauthentication_sent_at    timestamptz,
  is_sso_user                 boolean not null default false,
  deleted_at                  timestamptz,
  is_anonymous                boolean not null default false,
  constraint users_phone_key unique (phone),
  constraint users_email_change_confirm_status_check
    check (email_change_confirm_status >= 0 and email_change_confirm_status <= 2)
);

comment on table auth.users is 'Auth: Stores user login data within a secure schema.';

create unique index if not exists users_email_partial_key on auth.users (email) where (is_sso_user = false);
create index if not exists users_instance_id_idx on auth.users (instance_id);
create index if not exists users_instance_id_email_idx on auth.users (instance_id, lower(email::text));
create index if not exists users_is_anonymous_idx on auth.users (is_anonymous);

create table if not exists auth.identities (
  provider_id     text not null,
  user_id         uuid not null references auth.users (id) on delete cascade,
  identity_data   jsonb not null,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz,
  email           text generated always as (lower(identity_data ->> 'email')) stored,
  id              uuid not null default gen_random_uuid() primary key,
  constraint identities_provider_id_provider_unique unique (provider_id, provider)
);

create index if not exists identities_user_id_idx on auth.identities (user_id);
create index if not exists identities_email_idx on auth.identities (email text_pattern_ops);

create table if not exists auth.sessions (
  id           uuid not null primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz,
  updated_at   timestamptz,
  factor_id    uuid,
  aal          auth.aal_level,
  not_after    timestamptz,
  refreshed_at timestamp without time zone,
  user_agent   text,
  ip           inet,
  tag          text
);

create index if not exists sessions_user_id_idx on auth.sessions (user_id);
create index if not exists user_id_created_at_idx on auth.sessions (user_id, created_at);
create index if not exists sessions_not_after_idx on auth.sessions (not_after desc);

create table if not exists auth.refresh_tokens (
  instance_id uuid,
  id          bigserial primary key,
  token       varchar(255),
  user_id     varchar(255),
  revoked     boolean,
  created_at  timestamptz,
  updated_at  timestamptz,
  parent      varchar(255),
  session_id  uuid references auth.sessions (id) on delete cascade,
  constraint refresh_tokens_token_unique unique (token)
);

create index if not exists refresh_tokens_instance_id_idx on auth.refresh_tokens (instance_id);
create index if not exists refresh_tokens_instance_id_user_id_idx on auth.refresh_tokens (instance_id, user_id);
create index if not exists refresh_tokens_parent_idx on auth.refresh_tokens (parent);
create index if not exists refresh_tokens_session_id_revoked_idx on auth.refresh_tokens (session_id, revoked);
create index if not exists refresh_tokens_updated_at_idx on auth.refresh_tokens (updated_at desc);

create table if not exists auth.mfa_factors (
  id                           uuid not null primary key,
  user_id                      uuid not null references auth.users (id) on delete cascade,
  friendly_name                text,
  factor_type                  auth.factor_type not null,
  status                       auth.factor_status not null,
  created_at                   timestamptz not null,
  updated_at                   timestamptz not null,
  secret                       text,
  phone                        text,
  last_challenged_at           timestamptz unique,
  web_authn_credential         jsonb,
  web_authn_aaguid             uuid,
  last_webauthn_challenge_data jsonb
);

create unique index if not exists mfa_factors_user_friendly_name_unique
  on auth.mfa_factors (friendly_name, user_id) where (trim(friendly_name) <> '');
create index if not exists factor_id_created_at_idx on auth.mfa_factors (user_id, created_at);
create index if not exists mfa_factors_user_id_idx on auth.mfa_factors (user_id);
create unique index if not exists unique_phone_factor_per_user on auth.mfa_factors (user_id, phone);

create table if not exists auth.mfa_challenges (
  id                    uuid not null primary key,
  factor_id             uuid not null references auth.mfa_factors (id) on delete cascade,
  created_at            timestamptz not null,
  verified_at           timestamptz,
  ip_address            inet not null,
  otp_code              text,
  web_authn_session_data jsonb
);

create index if not exists mfa_challenge_created_at_idx on auth.mfa_challenges (created_at desc);

create table if not exists auth.mfa_amr_claims (
  session_id            uuid not null references auth.sessions (id) on delete cascade,
  created_at            timestamptz not null,
  updated_at            timestamptz not null,
  authentication_method text not null,
  id                    uuid not null primary key,
  constraint mfa_amr_claims_session_id_authentication_method_pkey unique (session_id, authentication_method)
);

create table if not exists auth.one_time_tokens (
  id         uuid not null primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  token_type auth.one_time_token_type not null,
  token_hash text not null check (char_length(token_hash) > 0),
  relates_to text not null,
  created_at timestamp without time zone not null default now(),
  updated_at timestamp without time zone not null default now()
);

create index if not exists one_time_tokens_token_hash_hash_idx on auth.one_time_tokens using hash (token_hash);
create index if not exists one_time_tokens_relates_to_hash_idx on auth.one_time_tokens using hash (relates_to);
create unique index if not exists one_time_tokens_user_id_token_type_key on auth.one_time_tokens (user_id, token_type);

-- auth.uid() / role() / email() / jwt(): identical to Supabase (PostgREST exposes
-- the verified JWT as the transaction-local setting request.jwt.claims).
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

comment on function auth.uid() is 'Deprecated. Use auth.jwt() -> ''sub'' instead.';

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

comment on function auth.role() is 'Deprecated. Use auth.jwt() -> ''role'' instead.';

create or replace function auth.email()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

comment on function auth.email() is 'Deprecated. Use auth.jwt() -> ''email'' instead.';

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

-- Ownership, RLS and privileges as on Supabase: the tables belong to the auth
-- service role, RLS is on without policies, API roles get no table privilege.
do $auth_owner$
declare
  t text;
begin
  foreach t in array array[
    'users', 'identities', 'sessions', 'refresh_tokens', 'mfa_factors', 'mfa_challenges',
    'mfa_amr_claims', 'one_time_tokens']
  loop
    execute format('alter table auth.%I owner to supabase_auth_admin', t);
    execute format('alter table auth.%I enable row level security', t);
    execute format('revoke all on table auth.%I from public, anon, authenticated, service_role', t);
  end loop;
end
$auth_owner$;

alter function auth.uid() owner to supabase_auth_admin;
alter function auth.role() owner to supabase_auth_admin;
alter function auth.email() owner to supabase_auth_admin;
alter function auth.jwt() owner to supabase_auth_admin;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to public;

-- -----------------------------------------------------------------------------
-- 5. storage schema (Supabase Storage). The local gateway keeps the files on
--    disk; access is decided by the RLS policies on storage.objects that the
--    migrations create, exactly as the real Storage API does.
-- -----------------------------------------------------------------------------
create table if not exists storage.buckets (
  id                 text not null primary key,
  name               text not null,
  owner              uuid,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  public             boolean default false,
  avif_autodetection boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  owner_id           text
);

create unique index if not exists bname on storage.buckets (name);

comment on column storage.buckets.owner is 'Field is deprecated, use owner_id instead';

create table if not exists storage.objects (
  id               uuid not null default gen_random_uuid() primary key,
  bucket_id        text references storage.buckets (id),
  name             text,
  owner            uuid,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata         jsonb,
  path_tokens      text[] generated always as (string_to_array(name, '/')) stored,
  version          text,
  owner_id         text,
  user_metadata    jsonb
);

create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);
create index if not exists name_prefix_search on storage.objects (name text_pattern_ops);
create index if not exists idx_objects_bucket_id_name on storage.objects (bucket_id, name collate "C");

comment on column storage.objects.owner is 'Field is deprecated, use owner_id instead';

create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$$;

create or replace function storage.filename(name text)
returns text
language plpgsql
immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end
$$;

create or replace function storage.extension(name text)
returns text
language plpgsql
immutable
as $$
declare
  _parts text[];
  _filename text;
begin
  select string_to_array(name, '/') into _parts;
  select _parts[array_length(_parts, 1)] into _filename;
  return reverse(split_part(reverse(_filename), '.', 1));
end
$$;

create or replace function storage.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

drop trigger if exists update_objects_updated_at on storage.objects;
create trigger update_objects_updated_at
  before update on storage.objects
  for each row execute function storage.update_updated_at_column();

alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
alter function storage.foldername(text) owner to supabase_storage_admin;
alter function storage.filename(text) owner to supabase_storage_admin;
alter function storage.extension(text) owner to supabase_storage_admin;
alter function storage.update_updated_at_column() owner to supabase_storage_admin;

-- RLS on, not forced, no default policy: nothing is reachable until a migration
-- adds policies. The API roles hold table privileges (as on Supabase) so that the
-- policies alone decide.
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

grant all on table storage.buckets, storage.objects to anon, authenticated, service_role;
grant execute on function storage.foldername(text), storage.filename(text), storage.extension(text)
  to public;

-- -----------------------------------------------------------------------------
-- 6. PostgREST schema-cache reload on DDL (same event triggers as Supabase)
-- -----------------------------------------------------------------------------
create or replace function extensions.pgrst_ddl_watch()
returns event_trigger
language plpgsql
as $$
declare
  cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
  loop
    if cmd.command_tag in (
      'CREATE SCHEMA', 'ALTER SCHEMA',
      'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE',
      'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE',
      'CREATE VIEW', 'ALTER VIEW',
      'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW',
      'CREATE FUNCTION', 'ALTER FUNCTION',
      'CREATE TRIGGER',
      'CREATE TYPE', 'ALTER TYPE',
      'CREATE RULE',
      'COMMENT'
    )
    -- no reload for temporary objects
    and cmd.schema_name is distinct from 'pg_temp'
    then
      notify pgrst, 'reload schema';
    end if;
  end loop;
end
$$;

create or replace function extensions.pgrst_drop_watch()
returns event_trigger
language plpgsql
as $$
declare
  obj record;
begin
  for obj in select * from pg_event_trigger_dropped_objects()
  loop
    if obj.object_type in (
      'schema', 'table', 'foreign table', 'view', 'materialized view', 'function',
      'trigger', 'type', 'rule'
    )
    and obj.is_temporary is false
    then
      notify pgrst, 'reload schema';
    end if;
  end loop;
end
$$;

do $evt$
begin
  if not exists (select 1 from pg_catalog.pg_event_trigger where evtname = 'pgrst_ddl_watch') then
    create event trigger pgrst_ddl_watch on ddl_command_end
      execute function extensions.pgrst_ddl_watch();
  end if;
  if not exists (select 1 from pg_catalog.pg_event_trigger where evtname = 'pgrst_drop_watch') then
    create event trigger pgrst_drop_watch on sql_drop
      execute function extensions.pgrst_drop_watch();
  end if;
end
$evt$;

reset client_min_messages;
