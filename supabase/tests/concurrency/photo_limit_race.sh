#!/usr/bin/env sh
# Two-session proof for the 10-photo limit under CONCURRENT sync_push calls
# (trigger t20_rules of migration 20261003000900: lock the parent project row
# FOR NO KEY UPDATE, then count). pgTAP runs in one transaction and cannot show
# a race between two transactions; this script does, with two psql sessions.
#
# Usage (from the repository root, local stack running):
#   npm run db:reset -- --db imap_race --no-seed
#   psql ... -d imap_race -f supabase/tests/00_helpers.test.sql     (installs schema "tests")
#   sh supabase/tests/concurrency/photo_limit_race.sh imap_race
#
# Scenario: a project with 9 live photos. Session 1 pushes photo 10 and keeps its
# transaction open for 3 s; session 2, started 1 s later from another device,
# pushes photo 11. Expected: session 2 waits for session 1, then its op is
# rejected with photo_limit_exceeded; exactly 10 live photos remain.
# Never point this at the shared database "istiqama": it commits rows.
set -u

DB="${1:?usage: photo_limit_race.sh <private database>}"
case "$DB" in
  istiqama|postgres) echo "refusing to run against the shared database $DB" >&2; exit 2 ;;
esac
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PSQL="${PSQL:-$ROOT/.local/pg/bin/psql.exe}"
[ -x "$PSQL" ] || PSQL=psql
CONN="-h ${PGHOST:-127.0.0.1} -p ${PGPORT:-54322} -U ${PGUSER:-postgres} -X -q -v ON_ERROR_STOP=0 -d $DB"
TMP="${TMPDIR:-/tmp}/photo_limit_race.$$"
mkdir -p "$TMP"

P=$("$PSQL" $CONN -At -c "select gen_random_uuid()" | tr -d '\r')
# project + 9 photos, committed (a private database only)
"$PSQL" $CONN -At -c "
do \$\$
declare r jsonb;
begin
  perform set_config('app.rate_limit', 'off', true);
  perform tests.fixture();
  perform tests.login_as(tests.id('u_col_pemba'), 'aal1', 'race-a');
  r := public.sync_push(
    jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'table', 'projects', 'id', '$P'::uuid,
      'kind', 'upsert', 'base_version', 0, 'fields', jsonb_build_object(
        'name_ar', 'race', 'type', 'mosque', 'status', 'active', 'lon', 39.713, 'lat', -5.013)))
    || (select jsonb_agg(jsonb_build_object('op_id', gen_random_uuid(), 'table', 'project_photos',
          'id', gen_random_uuid(), 'kind', 'upsert', 'base_version', 0,
          'fields', jsonb_build_object('project_id', '$P'::uuid))) from generate_series(1, 9)),
    'race-a');
  perform tests.logout();
  if (select count(*) from jsonb_array_elements(r -> 'results') e where e ->> 'status' <> 'applied') > 0 then
    raise exception 'setup failed: %', r;
  end if;
end \$\$;" || { echo "setup failed (is schema tests installed?)" >&2; exit 2; }

photo_op() {
  printf "jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'table', 'project_photos', 'id', gen_random_uuid(), 'kind', 'upsert', 'base_version', 0, 'fields', jsonb_build_object('project_id', '%s'::uuid)))" "$P"
}

"$PSQL" $CONN -At > "$TMP/s1.out" 2>&1 <<SQL &
begin;
select set_config('app.rate_limit', 'off', true);
select tests.login_as(tests.id('u_col_pemba'), 'aal1', 'race-a');
select public.sync_push($(photo_op), 'race-a') -> 'results' -> 0 ->> 'status';
select pg_sleep(3);
commit;
SQL
S1=$!
sleep 1
"$PSQL" $CONN -At > "$TMP/s2.out" 2>&1 <<SQL
begin;
select set_config('app.rate_limit', 'off', true);
select tests.login_as(tests.id('u_col_pemba2'), 'aal1', 'race-b');
select coalesce(public.sync_push($(photo_op), 'race-b') -> 'results' -> 0 -> 'error' ->> 'code', 'applied');
commit;
SQL
wait $S1

N=$("$PSQL" $CONN -At -c "select count(*) from public.project_photos where project_id = '$P' and deleted_at is null" | tr -d '\r')
R1=$(grep -E '^(applied|rejected)' "$TMP/s1.out" | tr -d '\r' | head -1)
R2=$(grep -E '^(applied|photo_limit_exceeded|[a-z_]+)$' "$TMP/s2.out" | tr -d '\r' | grep -v '^$' | tail -1)
echo "session 1 (photo 10): ${R1:-?}   session 2 (photo 11): ${R2:-?}   live photos: $N"
rm -rf "$TMP"
if [ "$R1" = "applied" ] && [ "$R2" = "photo_limit_exceeded" ] && [ "$N" = "10" ]; then
  echo "PASS"; exit 0
fi
echo "FAIL"; exit 1
