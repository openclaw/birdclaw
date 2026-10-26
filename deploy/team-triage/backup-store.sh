#!/usr/bin/env bash
# Nightly online backup of the Team triage SQLite store to S3.
# Runs as root from birdclaw-team-backup.timer. S3 expires backups after 30 days.
set -euo pipefail

db=/var/lib/birdclaw-team/mentions/birdclaw.sqlite
bucket=birdclaw-team-releases-631860342038
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# sqlite3 .backup is consistent while the service keeps writing (WAL mode).
sqlite3 "$db" ".backup '$tmp/birdclaw.sqlite'"
sqlite3 "$tmp/birdclaw.sqlite" "pragma integrity_check" | grep -qx ok
gzip -9 "$tmp/birdclaw.sqlite"
aws s3 cp "$tmp/birdclaw.sqlite.gz" "s3://$bucket/backups/birdclaw-$stamp.sqlite.gz" \
	--only-show-errors --region us-west-1
echo "backed up to s3://$bucket/backups/birdclaw-$stamp.sqlite.gz"
