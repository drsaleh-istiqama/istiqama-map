#!/usr/bin/env sh
# Photo replication (brief §11): one-way copy of the Supabase Storage bucket "photos" to an
# S3-compatible bucket in ANOTHER account / region. PLACEHOLDER — the owner chooses the target
# (decision #1); no credentials live in this repository.
#
# Requirements: rclone >= 1.60 with two remotes configured OUTSIDE the repository
# (~/.config/rclone/rclone.conf or RCLONE_CONFIG_* environment variables of the CI secret store):
#
#   [istiqama-supabase]           # Supabase Storage S3 endpoint of the production project
#   type = s3
#   provider = Other
#   endpoint = https://<project-ref>.supabase.co/storage/v1/s3
#   region = <project region>
#   access_key_id = <Storage S3 access key>        # dashboard → Storage → S3 connection
#   secret_access_key = <secret>
#
#   [istiqama-offsite]            # S3-compatible bucket in another account / region,
#   type = s3                     # versioning + object lock (compliance, 35 days) enabled
#   provider = <AWS | Wasabi | Cloudflare | Backblaze …>
#   ...
#
# Usage:
#   PHOTOS_SOURCE=istiqama-supabase:photos PHOTOS_TARGET=istiqama-offsite:istiqama-photos \
#     sh scripts/backup/replicate-photos.sh            # copy new / changed objects
#   ... sh scripts/backup/replicate-photos.sh --check  # verify only (no transfer)
#   ... sh scripts/backup/replicate-photos.sh --dry-run
#
# "copy", never "sync": objects removed from the source (90-day retention purge) are NOT
# deleted from the replica here; the replica's own lifecycle rule expires them (RUNBOOK §6).
# The photos referenced by a backup are listed in its storage-manifest.json.
set -eu

: "${PHOTOS_SOURCE:?set PHOTOS_SOURCE, e.g. istiqama-supabase:photos}"
: "${PHOTOS_TARGET:?set PHOTOS_TARGET, e.g. istiqama-offsite:istiqama-photos}"
RCLONE="${RCLONE_BIN:-rclone}"
LOG_DIR="${PHOTOS_LOG_DIR:-.local/backups/photo-replication}"
mkdir -p "$LOG_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

case "${1:-}" in
  --check)
    exec "$RCLONE" check "$PHOTOS_SOURCE" "$PHOTOS_TARGET" --one-way --size-only \
      --log-file "$LOG_DIR/check-$STAMP.log" --log-level INFO
    ;;
  --dry-run)
    exec "$RCLONE" copy "$PHOTOS_SOURCE" "$PHOTOS_TARGET" --dry-run --log-level INFO
    ;;
  "")
    "$RCLONE" copy "$PHOTOS_SOURCE" "$PHOTOS_TARGET" \
      --checksum --transfers 8 --checkers 16 --retries 5 --low-level-retries 10 \
      --log-file "$LOG_DIR/copy-$STAMP.log" --log-level INFO --stats-one-line
    "$RCLONE" check "$PHOTOS_SOURCE" "$PHOTOS_TARGET" --one-way --size-only \
      --log-file "$LOG_DIR/check-$STAMP.log" --log-level INFO
    echo "photo replication done: $PHOTOS_SOURCE -> $PHOTOS_TARGET ($STAMP)"
    ;;
  *)
    echo "usage: $0 [--check | --dry-run]" >&2
    exit 64
    ;;
esac
