-- =============================================================================
-- 0033  search (brief §5: pg_trgm + unaccent over project names (ar/latin), code,
--       locality, staff names and donors; ARCHITECTURE §2.4)
--
-- public.search(p_q, p_limit default 20 (max 50), p_kinds default all) -> jsonb array
--
--   kind "project"  : { kind, id, score, name_ar, name_latin, code, type, status,
--                       record_state, lon, lat, country_id, admin_area_id, locality_id }
--   kind "locality" : { kind, id, score, name_ar, name_latin, status, lon, lat,
--                       country_id, admin_area_id }
--   kind "staff"    : { kind, id (person), score, name_ar, name_latin,
--                       projects_count, projects: [<= 5 x { id, code, name_ar, name_latin,
--                                                           type, status, lon, lat, role }] }
--   kind "donor"    : { kind, id (donor), score, name_ar, name_latin,
--                       projects_count, projects: [<= 5 x { id, code, name_ar, name_latin,
--                                                           type, status, lon, lat }] }
--
-- Matching
--   * The query is normalised with private.norm (Arabic + Latin folding), exactly
--     like the indexed columns (projects.search_norm, localities.name_norm,
--     persons.name_normalized, donors.name_norm).
--   * Every word of the query must occur in the text (substring match, any order).
--     The three longest words drive the trigram GIN index; when every word is
--     shorter than three characters the first one must start a word.
--   * Only when nothing at all matches, a typo-tolerant pass (word_similarity >= 0.6,
--     also served by the trigram indexes) is tried.
--   * Queries shorter than two characters return [].
--   * score = 1 for an exact match (or an exact project code), otherwise
--     0.9 * word_similarity(query, text) + 0.1 * similarity(query, text).
--
-- Authorisation (SECURITY DEFINER, explicit scope filtering)
--   * projects: read scope; localities: countries the caller can read;
--   * staff: people scope on the person AND read scope on the project, so a
--     viewer never gets staff hits; donors: only donors of readable projects.
--   * "readable project" includes the unreviewed-records rule (migration 0013,
--     owner decision ح): a project that is not approved counts only inside the
--     caller's people scope, so a viewer finds approved projects only (applied
--     in step 2, after the candidate step).
--
-- Performance (500k persons, 100k projects)
--   * Step 1, private.search_candidates(): at most 400 ids per kind straight from
--     the trigram index. The statement is built from fixed fragments (all values
--     are bound parameters) and planned for the actual words and scope, with
--     sequential and plain index scans disabled: the only plans left are bitmap
--     scans of the trigram index (ANDed with the scope index for a narrow scope),
--     whose cost is bounded - no plan that hopes to find matches early in a table.
--   * Step 2: the candidates are checked for a readable project (staff, donors),
--     ranked, cut to the limit and decorated by static statements driven by
--     primary keys.
--   * A single very common word is capped at 400 candidates rather than ranked
--     exhaustively (the user refines the query).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Step 1: candidate ids of one kind.
--   p_kind       project | locality | staff | donor
--   p_fuzzy      false: every word must occur; true: word_similarity(p_q, text) >= 0.6
--   p_q          normalised query;  p_tokens  its words
--   p_all / p_countries / p_branches   scope on the searched table itself
--                (projects: read scope; staff: people scope on persons;
--                 locality: readable countries, branches unused; donor: no scope here)
-- Not callable through the API: only public.search() (same owner) uses it.
-- -----------------------------------------------------------------------------
create or replace function private.search_candidates(
  p_kind text,
  p_fuzzy boolean,
  p_q text,
  p_tokens text[],
  p_all boolean,
  p_countries uuid[],
  p_branches uuid[],
  p_cap integer
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, extensions, private, pg_temp
set pg_trgm.word_similarity_threshold = 0.6
set enable_seqscan = off
set enable_indexscan = off
set enable_indexonlyscan = off
set max_parallel_workers_per_gather = 0
as $$
declare
  v_table text;
  v_col text;
  v_where text;
  v_long text[];
  v_p1 text;
  v_p2 text;
  v_p3 text;
  v_pats text[];
  v_ids uuid[];
begin
  case p_kind
    when 'project' then
      v_table := 'public.projects t';
      v_col := 't.search_norm';
      v_where := 't.deleted_at is null';
    when 'locality' then
      v_table := 'public.localities t';
      v_col := 't.name_norm';
      v_where := 't.deleted_at is null';
    when 'staff' then
      v_table := 'public.persons t';
      v_col := 't.name_normalized';
      v_where := 't.deleted_at is null and t.merged_into_id is null';
    when 'donor' then
      v_table := 'public.donors t';
      v_col := 't.name_norm';
      v_where := 't.deleted_at is null';
    else
      raise exception 'unknown search kind %', p_kind;
  end case;

  -- Scope: only the non-empty id lists are mentioned, so that the planner gets a
  -- plain index condition for the usual "one branch" / "one country" caller.
  --   $6 countries, $7 branches
  if p_kind = 'locality' then
    if not p_all then
      v_where := v_where || ' and t.country_id = any ($6)';
    end if;
  elsif p_kind in ('project', 'staff') and not p_all then
    v_where := v_where || case
      when cardinality(p_branches) = 0 then ' and t.country_id = any ($6)'
      when cardinality(p_countries) = 0 then ' and t.branch_id = any ($7)'
      else ' and (t.country_id = any ($6) or t.branch_id = any ($7))' end;
  end if;

  -- Name predicate.  $1 query, $2..$4 patterns, $5 LIKE patterns of all words.
  if p_fuzzy then
    v_where := v_where || ' and ' || v_col || ' %> $1';
  else
    select array_agg('%' || private.like_escape(t.tok) || '%')
    into v_pats
    from unnest(p_tokens) as t(tok);

    select array_agg(s.tok order by s.len desc, s.ord)
    into v_long
    from (
      select t.tok, t.ord, char_length(t.tok) as len
      from unnest(p_tokens) with ordinality as t(tok, ord)
      where char_length(t.tok) >= 3
      order by char_length(t.tok) desc, t.ord
      limit 3
    ) s;

    if v_long is not null then
      -- '%word%' has at least one trigram: served by the GIN index, all ANDed.
      v_p1 := '%' || private.like_escape(v_long[1]) || '%';
      v_where := v_where || ' and ' || v_col || ' like $2';
      if cardinality(v_long) >= 2 then
        v_p2 := '%' || private.like_escape(v_long[2]) || '%';
        v_where := v_where || ' and ' || v_col || ' like $3';
      end if;
      if cardinality(v_long) >= 3 then
        v_p3 := '%' || private.like_escape(v_long[3]) || '%';
        v_where := v_where || ' and ' || v_col || ' like $4';
      end if;
      if cardinality(p_tokens) > cardinality(v_long) then
        v_where := v_where || ' and ' || v_col || ' like all ($5)';   -- the remaining short words
      end if;
    else
      -- Every word is shorter than a trigram: the first two-character word must
      -- start the text or a word. As a regular expression this is one condition,
      -- which pg_trgm serves with a single scan of its blank-padded trigram (" xy").
      select t.tok
      into v_p1
      from unnest(p_tokens) with ordinality as t(tok, ord)
      where char_length(t.tok) = 2
      order by t.ord
      limit 1;
      if v_p1 is null then
        return '{}'::uuid[];        -- single letters only: nothing an index can use
      end if;
      v_p1 := '(^| )' || regexp_replace(v_p1, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g');
      v_where := v_where || ' and ' || v_col || ' ~ $2';
      if cardinality(p_tokens) > 1 then
        v_where := v_where || ' and ' || v_col || ' like all ($5)';
      end if;
    end if;
  end if;

  execute 'select array_agg(s.id) from (select t.id from ' || v_table
       || ' where ' || v_where || ' limit $8) s'
    into v_ids
    using p_q, v_p1, v_p2, v_p3, v_pats, p_countries, p_branches, p_cap;

  return coalesce(v_ids, '{}'::uuid[]);
end;
$$;

comment on function private.search_candidates(text, boolean, text, text[], boolean, uuid[], uuid[], integer) is
  'Step 1 of public.search(): up to p_cap ids of one kind whose normalised text matches the query words (or is trigram-similar when p_fuzzy), limited to the given scope. Bitmap index plans only.';

revoke execute on function
  private.search_candidates(text, boolean, text, text[], boolean, uuid[], uuid[], integer)
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- public.search
-- -----------------------------------------------------------------------------
create or replace function public.search(
  p_q text,
  p_limit integer default 20,
  p_kinds text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, private, pg_temp
-- Interactive lookups: never pay for starting parallel workers.
set max_parallel_workers_per_gather = 0
as $$
declare
  c_candidates constant integer := 400;
  c_max_tokens constant integer := 6;
  c_projects_per_hit constant integer := 5;
  c_rate_per_minute constant integer := 300;
  v_q text := btrim(coalesce(private.norm(p_q), ''));
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_kinds text[] := coalesce(p_kinds, array['project', 'locality', 'staff', 'donor']);
  v_tokens text[];
  v_all boolean;
  v_countries uuid[];
  v_branches uuid[];
  v_people_all boolean := false;
  v_people_countries uuid[] := '{}'::uuid[];
  v_people_branches uuid[] := '{}'::uuid[];
  v_has_people boolean := false;
  v_rev_all boolean;      -- sees unreviewed projects wherever he reads (no viewer-only area)
  v_geo_countries uuid[] := '{}'::uuid[];
  -- Pass 1: exact words, every kind. Pass 2: typo-tolerant for projects,
  -- localities and donors. Pass 3: typo-tolerant for staff (the 500k-row persons
  -- index is only consulted when nothing else produced a hit).
  v_pass integer := 1;
  v_fuzzy boolean := false;
  v_match_q text;         -- text handed to the candidate step
  v_cand uuid[];
  v_hits jsonb := '[]'::jsonb;
  v_part jsonb;
  v_result jsonb;
begin
  -- Per-caller budget (the client debounces at 250 ms, i.e. at most 240 calls a minute).
  perform private.rate_limit('search', c_rate_per_minute, interval '1 minute');

  -- Too short, or nothing a trigram index can work with (punctuation only).
  if char_length(v_q) < 2 or cardinality(show_trgm(v_q)) = 0 then
    return '[]'::jsonb;
  end if;

  v_all := private.read_all();
  v_countries := private.read_countries();
  v_branches := private.read_branches();
  if not v_all and cardinality(v_countries) = 0 and cardinality(v_branches) = 0 then
    return '[]'::jsonb;
  end if;

  v_people_all := private.people_all();
  v_people_countries := private.people_countries();
  v_people_branches := private.people_branches();
  v_has_people := v_people_all
    or cardinality(v_people_countries) > 0
    or cardinality(v_people_branches) > 0;
  v_rev_all := v_people_all
    or (not v_all and v_countries <@ v_people_countries and v_branches <@ v_people_branches);

  if 'locality' = any (v_kinds) and not v_all then
    select coalesce(array_agg(distinct s.country_id), '{}'::uuid[])
    into v_geo_countries
    from (
      select unnest(v_countries) as country_id
      union
      select b.country_id from public.branches b where b.id = any (v_branches)
    ) s
    where s.country_id is not null;
  end if;

  -- Words of the query (at most c_max_tokens).
  select array_agg(t.tok order by t.ord)
  into v_tokens
  from (
    select w.tok, w.ord
    from unnest(string_to_array(v_q, ' ')) with ordinality as w(tok, ord)
    where w.tok <> ''
    order by w.ord
    limit c_max_tokens
  ) t;

  v_match_q := v_q;

  loop
    -- ----------------------------------------------------------------- projects
    if 'project' = any (v_kinds) and v_pass <> 3 then
      v_cand := private.search_candidates(
        'project', v_fuzzy, v_match_q, v_tokens, v_all, v_countries, v_branches, c_candidates);

      if cardinality(v_cand) > 0 then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'kind', 'project',
                 'id', r.id,
                 'score', round(r.score::numeric, 3),
                 'name_ar', r.name_ar,
                 'name_latin', r.name_latin,
                 'code', r.code,
                 'type', r.type,
                 'status', r.status,
                 'record_state', r.record_state,
                 'lon', st_x(r.geom),
                 'lat', st_y(r.geom),
                 'country_id', r.country_id,
                 'admin_area_id', r.admin_area_id,
                 'locality_id', r.locality_id) order by r.score desc, r.sort_name, r.id), '[]'::jsonb)
        into v_part
        from (
          select p.id, p.name_ar, p.name_latin, p.code, p.type, p.status, p.record_state, p.geom,
                 p.country_id, p.admin_area_id, p.locality_id,
                 p.name_ar collate "C" as sort_name,
                 case when lower(p.code) = v_q or p.search_norm = v_q then 1::real
                      else (0.9 * word_similarity(v_q, p.search_norm)
                            + 0.1 * similarity(v_q, p.search_norm))::real end as score
          from unnest(v_cand) as u(id)
          join public.projects p on p.id = u.id
          where v_rev_all or p.record_state = 'approved'
             or p.country_id = any (v_people_countries) or p.branch_id = any (v_people_branches)
          order by score desc, sort_name, p.id
          limit v_limit
        ) r;
        v_hits := v_hits || v_part;
      end if;
    end if;

    -- --------------------------------------------------------------- localities
    if 'locality' = any (v_kinds) and v_pass <> 3 and (v_all or cardinality(v_geo_countries) > 0) then
      v_cand := private.search_candidates(
        'locality', v_fuzzy, v_match_q, v_tokens, v_all, v_geo_countries, '{}'::uuid[], c_candidates);

      if cardinality(v_cand) > 0 then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'kind', 'locality',
                 'id', r.id,
                 'score', round(r.score::numeric, 3),
                 'name_ar', r.name_ar,
                 'name_latin', r.name_latin,
                 'status', r.status,
                 'lon', st_x(r.geom),
                 'lat', st_y(r.geom),
                 'country_id', r.country_id,
                 'admin_area_id', r.admin_area_id) order by r.score desc, r.sort_name, r.id), '[]'::jsonb)
        into v_part
        from (
          select l.id, l.name_ar, l.name_latin, l.status, l.geom, l.country_id, l.admin_area_id,
                 coalesce(l.name_ar, l.name_latin) collate "C" as sort_name,
                 case when l.name_norm = v_q then 1::real
                      else (0.9 * word_similarity(v_q, l.name_norm)
                            + 0.1 * similarity(v_q, l.name_norm))::real end as score
          from unnest(v_cand) as u(id)
          join public.localities l on l.id = u.id
          order by score desc, sort_name, l.id
          limit v_limit
        ) r;
        v_hits := v_hits || v_part;
      end if;
    end if;

    -- -------------------------------------------------------------------- staff
    if 'staff' = any (v_kinds) and v_pass <> 2 and v_has_people then
      v_cand := private.search_candidates(
        'staff', v_fuzzy, v_match_q, v_tokens, v_people_all, v_people_countries, v_people_branches,
        c_candidates);

      if cardinality(v_cand) > 0 then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'kind', 'staff',
                 'id', r.id,
                 'score', round(r.score::numeric, 3),
                 'name_ar', r.name_ar,
                 'name_latin', r.name_latin,
                 'projects_count', cnt.n,
                 'projects', pr.projects) order by r.score desc, r.sort_name, r.id), '[]'::jsonb)
        into v_part
        from (
          select pe.id, pe.name_ar, pe.name_latin,
                 coalesce(pe.name_ar, pe.name_latin) collate "C" as sort_name,
                 case when pe.name_normalized = v_q then 1::real
                      else (0.9 * word_similarity(v_q, pe.name_normalized)
                            + 0.1 * similarity(v_q, pe.name_normalized))::real end as score
          from unnest(v_cand) as u(id)
          join public.persons pe on pe.id = u.id
          -- a person is a hit only through a project the caller can read
          where exists (
            select 1
            from public.project_staff ps
            join public.projects p on p.id = ps.project_id
            where ps.person_id = pe.id
              and ps.deleted_at is null
              and p.deleted_at is null
              and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
              and (v_rev_all or p.record_state = 'approved'
                   or p.country_id = any (v_people_countries) or p.branch_id = any (v_people_branches)))
          order by score desc, sort_name, pe.id
          limit v_limit
        ) r
        cross join lateral (
          select count(distinct ps.project_id) as n
          from public.project_staff ps
          join public.projects p on p.id = ps.project_id
          where ps.person_id = r.id
            and ps.deleted_at is null
            and p.deleted_at is null
            and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
              and (v_rev_all or p.record_state = 'approved'
                   or p.country_id = any (v_people_countries) or p.branch_id = any (v_people_branches))
        ) cnt
        cross join lateral (
          select coalesce(jsonb_agg(t.j order by t.ord), '[]'::jsonb) as projects
          from (
            select jsonb_build_object(
                     'id', p.id,
                     'code', p.code,
                     'name_ar', p.name_ar,
                     'name_latin', p.name_latin,
                     'type', p.type,
                     'status', p.status,
                     'lon', st_x(p.geom),
                     'lat', st_y(p.geom),
                     'role', ps.role) as j,
                   row_number() over (
                     order by (ps.end_date is null) desc, ps.start_date desc nulls last, p.id, ps.id) as ord
            from public.project_staff ps
            join public.projects p on p.id = ps.project_id
            where ps.person_id = r.id
              and ps.deleted_at is null
              and p.deleted_at is null
              and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
              and (v_rev_all or p.record_state = 'approved'
                   or p.country_id = any (v_people_countries) or p.branch_id = any (v_people_branches))
            order by (ps.end_date is null) desc, ps.start_date desc nulls last, p.id, ps.id
            limit c_projects_per_hit
          ) t
        ) pr;
        v_hits := v_hits || v_part;
      end if;
    end if;

    -- ------------------------------------------------------------------- donors
    if 'donor' = any (v_kinds) and v_pass <> 3 then
      v_cand := private.search_candidates(
        'donor', v_fuzzy, v_match_q, v_tokens, true, '{}'::uuid[], '{}'::uuid[], c_candidates);

      if cardinality(v_cand) > 0 then
        select coalesce(jsonb_agg(jsonb_build_object(
                 'kind', 'donor',
                 'id', r.id,
                 'score', round(r.score::numeric, 3),
                 'name_ar', r.name_ar,
                 'name_latin', r.name_latin,
                 'projects_count', cnt.n,
                 'projects', pr.projects) order by r.score desc, r.sort_name, r.id), '[]'::jsonb)
        into v_part
        from (
          select d.id, d.name_ar, d.name_latin,
                 coalesce(d.name_ar, d.name_latin) collate "C" as sort_name,
                 case when d.name_norm = v_q then 1::real
                      else (0.9 * word_similarity(v_q, d.name_norm)
                            + 0.1 * similarity(v_q, d.name_norm))::real end as score
          from unnest(v_cand) as u(id)
          join public.donors d on d.id = u.id
          -- a donor is a hit only through a project the caller can read
          where exists (
            select 1
            from public.project_donors pd
            join public.projects p on p.id = pd.project_id
            where pd.donor_id = d.id
              and pd.deleted_at is null
              and p.deleted_at is null
              and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
              and (v_rev_all or p.record_state = 'approved'
                   or p.country_id = any (v_people_countries) or p.branch_id = any (v_people_branches)))
          order by score desc, sort_name, d.id
          limit v_limit
        ) r
        cross join lateral (
          select count(distinct pd.project_id) as n
          from public.project_donors pd
          join public.projects p on p.id = pd.project_id
          where pd.donor_id = r.id
            and pd.deleted_at is null
            and p.deleted_at is null
            and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
              and (v_rev_all or p.record_state = 'approved'
                   or p.country_id = any (v_people_countries) or p.branch_id = any (v_people_branches))
        ) cnt
        cross join lateral (
          select coalesce(jsonb_agg(t.j order by t.ord), '[]'::jsonb) as projects
          from (
            select g.j, row_number() over (order by g.sort_name, g.id) as ord
            from (
              select distinct on (p.id)
                     p.id,
                     p.name_ar collate "C" as sort_name,
                     jsonb_build_object(
                       'id', p.id,
                       'code', p.code,
                       'name_ar', p.name_ar,
                       'name_latin', p.name_latin,
                       'type', p.type,
                       'status', p.status,
                       'lon', st_x(p.geom),
                       'lat', st_y(p.geom)) as j
              from public.project_donors pd
              join public.projects p on p.id = pd.project_id
              where pd.donor_id = r.id
                and pd.deleted_at is null
                and p.deleted_at is null
                and (v_all or p.country_id = any (v_countries) or p.branch_id = any (v_branches))
              and (v_rev_all or p.record_state = 'approved'
                   or p.country_id = any (v_people_countries) or p.branch_id = any (v_people_branches))
              order by p.id
            ) g
            order by g.sort_name, g.id
            limit c_projects_per_hit
          ) t
        ) pr;
        v_hits := v_hits || v_part;
      end if;
    end if;

    -- The typo-tolerant passes run only while nothing at all has matched.
    exit when v_pass = 3 or jsonb_array_length(v_hits) > 0;

    if v_pass = 1 then
      -- Compare on the words of three or more characters only: particles such as
      -- "بن" / "bin" / "al" occur in almost every name, carry no information and
      -- are the most expensive trigrams to look up.
      select string_agg(t.tok, ' ' order by t.ord)
      into v_match_q
      from unnest(v_tokens) with ordinality as t(tok, ord)
      where char_length(t.tok) >= 3;

      -- Nothing to compare when every word is shorter than three characters.
      exit when v_match_q is null or cardinality(show_trgm(v_match_q)) = 0;
      v_fuzzy := true;
    end if;
    v_pass := v_pass + 1;
  end loop;

  -- Best hits first; on equal score: projects, localities, staff, donors.
  select coalesce(jsonb_agg(s.hit order by s.ord), '[]'::jsonb)
  into v_result
  from (
    select e.hit,
           row_number() over (
             order by (e.hit ->> 'score')::numeric desc,
                      array_position(array['project', 'locality', 'staff', 'donor'], e.hit ->> 'kind'),
                      (e.hit ->> 'name_ar') collate "C",
                      e.hit ->> 'id') as ord
    from jsonb_array_elements(v_hits) as e(hit)
  ) s
  where s.ord <= v_limit;

  return v_result;
end;
$$;

comment on function public.search(text, integer, text[]) is
  'Scope-filtered global search over projects (names + code), localities, staff names (never for viewers) and donors; trigram-indexed, Arabic/Latin normalised, ranked, max 50 hits.';

revoke execute on function public.search(text, integer, text[]) from public, anon;
grant execute on function public.search(text, integer, text[]) to authenticated, service_role;
