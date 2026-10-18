#!/usr/bin/env bash
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${BACKUP_DIR:?Set an absolute backup directory outside the checkout}"
case "$BACKUP_DIR" in /*) ;; *) echo 'BACKUP_DIR must be absolute' >&2; exit 1;; esac
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
dump="$BACKUP_DIR/platform-$stamp.dump"
trap 'rm -f "$dump.partial"' EXIT
"$here/compose.sh" exec -T platform-postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$dump.partial"
# A failed/truncated dump never acquires a final .dump filename.
mv "$dump.partial" "$dump"
"$here/compose.sh" images --format json > "$dump.images.json"
"$here/compose.sh" exec -T platform-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1"' > "$dump.migration.txt"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$dump")") > "$dump.sha256"
printf 'Backup complete: %s\n' "$dump"
# Upload the completed dump and sidecars using the operator's encrypted off-server
# backup tool. Local success is not proof of off-server durability.
