#!/usr/bin/env sh
# Two-session proof for the last-hq_admin guard on the DIRECT UPDATE path
# (migration 20261003007300, triggers t84_lock_hq_admins + t85_keep_hq_admin).
#
# pgTAP runs in ONE session inside one transaction, so it cannot show a race between two
# transactions; this script does, with two psql sessions against a PRIVATE database.
#
# Usage (from the repository root, local stack running):
#   npm run db:reset -- --db imap_race --no-seed
#   psql ... -d imap_race -f supabase/tests/00_helpers.test.sql     (installs schema "tests")
#   sh supabase/tests/concurrency/hq_admin_race.sh imap_race
#
# Scenarios (two active hq_admins A and B; every scenario starts from that state):
#   1. user_roles, READ COMMITTED: session 1 (as A) soft-deletes B's grant and waits 3 s
#      before COMMIT; session 2 (as B), started 1 s later, soft-deletes A's grant.
#      Expected: session 2 waits for session 1, then fails with PT409 last_hq_admin.
#   2. profiles, READ COMMITTED: the same with "active = false" on the two profiles.
#   3. user_roles, REPEATABLE READ: session 2 takes its snapshot BEFORE session 1 commits.
#      Expected: session 2 fails (40001 serialization failure, or PT409).
# After each scenario at least one live hq_admin must remain. Exit code 0 = all passed.
# Never point this at the shared database "istiqama": it commits rows (removed at the end).
set -u

DB="${1:?usage: hq_admin_race.sh <private database>}"
case "$DB" in
  istiqama|postgres) echo "refusing to run against the shared database $DB" >&2; exit 2 ;;
esac
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PSQL="${PSQL:-$ROOT/.local/pg/bin/psql.exe}"
[ -x "$PSQL" ] || PSQL=psql
CONN="-h ${PGHOST:-127.0.0.1} -p ${PGPORT:-54322} -U ${PGUSER:-postgres} -X -q -v ON_ERROR_STOP=0 -d $DB"
TMP="${TMPDIR:-/tmp}/hq_admin_race.$$"
mkdir -p "$TMP"

A=$("$PSQL" $CONN -At -c "select tests.create_user('race_a@example.org', 'hq_admin', 'global', null)")
B=$("$PSQL" $CONN -At -c "select tests.create_user('race_b@example.org', 'hq_admin', 'global', null)")
if [ -z "$A" ] || [ -z "$B" ]; then
  echo "setup failed (is schema tests installed? run 00_helpers.test.sql first)" >&2
  exit 2
fi

reset_state() {
  "$PSQL" $CONN -c "
    update public.user_roles set deleted_at = null
     where user_id in ('$A', '$B') and role = 'hq_admin' and scope_type = 'global';
    update public.profiles set active = true, deleted_at = null where id in ('$A', '$B');" >/dev/null
}

live_admins() {
  "$PSQL" $CONN -At -c "
    select count(*) from public.user_roles ur join public.profiles p on p.id = ur.user_id
     where ur.role = 'hq_admin' and ur.scope_type = 'global' and ur.deleted_at is null
       and p.active and p.deleted_at is null"
}

FAIL=0
run_case() {
  name="$1"; iso="$2"; sql1="$3"; sql2="$4"; pre2="$5"
  reset_state
  cat > "$TMP/s1.sql" <<EOF
begin;
select tests.login_as('$A', 'aal2');
$sql1
select pg_sleep(3);
commit;
EOF
  cat > "$TMP/s2.sql" <<EOF
begin isolation level $iso;
select tests.login_as('$B', 'aal2');
$pre2
select pg_sleep(1);
$sql2
commit;
EOF
  "$PSQL" $CONN -f "$TMP/s1.sql" > "$TMP/s1.out" 2>&1 &
  p1=$!
  "$PSQL" $CONN -f "$TMP/s2.sql" > "$TMP/s2.out" 2>&1 &
  p2=$!
  wait $p1; wait $p2
  left=$(live_admins)
  s1err=$(grep -E "ERROR" "$TMP/s1.out" | head -1)
  s2err=$(grep -E "ERROR" "$TMP/s2.out" | head -1)
  if [ -n "$s1err" ]; then
    echo "not ok - $name: session 1 should commit ($s1err)"; FAIL=1
  elif [ -z "$s2err" ]; then
    echo "not ok - $name: session 2 committed too ($left live hq_admins)"; FAIL=1
  elif [ "$left" -lt 1 ]; then
    echo "not ok - $name: no live hq_admin left"; FAIL=1
  else
    echo "ok - $name: session 2 refused [$s2err]; live hq_admins = $left"
  fi
}

# The session-2 snapshot of the REPEATABLE READ case is taken by its first query, before
# session 1 commits.
run_case "user_roles, read committed" "read committed" \
  "update public.user_roles set deleted_at = now() where user_id = '$B' and role = 'hq_admin' and deleted_at is null;" \
  "update public.user_roles set deleted_at = now() where user_id = '$A' and role = 'hq_admin' and deleted_at is null;" \
  ""
run_case "profiles, read committed" "read committed" \
  "update public.profiles set active = false where id = '$B';" \
  "update public.profiles set active = false where id = '$A';" \
  ""
run_case "user_roles, repeatable read" "repeatable read" \
  "update public.user_roles set deleted_at = now() where user_id = '$B' and role = 'hq_admin' and deleted_at is null;" \
  "update public.user_roles set deleted_at = now() where user_id = '$A' and role = 'hq_admin' and deleted_at is null;" \
  "select count(*) from public.user_roles;"

# Cleanup: remove the two users again (best effort).
"$PSQL" $CONN -c "
  set session_replication_role = replica;
  delete from public.user_roles where user_id in ('$A', '$B');
  delete from public.profiles where id in ('$A', '$B');
  delete from auth.users where id in ('$A', '$B');
  set session_replication_role = origin;" >/dev/null 2>&1
rm -rf "$TMP"
exit $FAIL
