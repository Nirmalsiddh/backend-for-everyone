#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DEPLOY_ENV:?Required}"
# Serialize deploys on this server. PostgreSQL also serializes migration runners.
exec 9>"${DEPLOY_LOCK:-/tmp/private-alpha-deploy.lock}"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
"$here/compose.sh" config --quiet
"$here/compose.sh" pull backend frontend platform-postgres caddy
"$here/compose.sh" up -d --wait platform-postgres
# Existing deployments must set BACKUP_DIR to perform a pre-migration backup.
existing="$("$here/compose.sh" exec -T platform-postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1' <<'SQL'
SELECT to_regclass('public.users') IS NOT NULL;
SQL
)"
if [[ "$existing" == t ]]; then
  "$here/backup.sh"
fi
"$here/compose.sh" run --rm migrate
"$here/compose.sh" up -d --wait backend frontend caddy
printf '%s\n' 'Services started. Run the HTTPS smoke test and authenticated acceptance flow.'
