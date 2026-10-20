#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${DEPLOY_ENV:?Required}"
: "${MAINTENANCE_DIR:?Export the same absolute maintenance directory configured in DEPLOY_ENV}"
: "${SMOKE_CONFIG:?Protected authenticated smoke JSON required}"
case "$MAINTENANCE_DIR" in /*) ;; *) echo 'Absolute maintenance directory required' >&2; exit 1;; esac
exec 9>"${DEPLOY_LOCK:-/tmp/private-alpha-deploy.lock}"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
"$here/compose.sh" config --quiet
configured_maintenance="$("$here/compose.sh" config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const c=JSON.parse(s);process.stdout.write(c.services.caddy.volumes.find(v=>v.target==="/srv/maintenance").source);})')"
[[ "$configured_maintenance" == "$MAINTENANCE_DIR" ]] || { echo 'Maintenance directory does not match deployment configuration' >&2; exit 1; }
if [[ "${DEPLOY_SKIP_PULL:-0}" != 1 ]]; then "$here/compose.sh" pull backend frontend platform-postgres caddy; fi
mkdir -p "$MAINTENANCE_DIR"
# Stop ingress first, including on the first upgrade introducing the maintenance matcher.
"$here/compose.sh" stop -t 20 caddy
touch "$MAINTENANCE_DIR/enabled"
failed() { touch "$MAINTENANCE_DIR/enabled"; "$here/compose.sh" stop -t 5 caddy >/dev/null 2>&1 || true; echo 'Deployment failed. Ingress remains closed. Do not reopen old code against changed metadata; follow the recovery runbook.' >&2; }
trap failed ERR
"$here/compose.sh" stop -t 20 frontend backend
"$here/compose.sh" up -d --wait platform-postgres
existing="$("$here/compose.sh" exec -T platform-postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1' <<'SQL'
SELECT to_regclass('public.users') IS NOT NULL;
SQL
)"
if [[ "$existing" == t ]]; then "$here/backup.sh"; fi
"$here/compose.sh" run --rm migrate
"$here/compose.sh" up -d --wait backend frontend
"$here/compose.sh" exec -T backend node dist/operations/operator.js preflight
"$here/compose.sh" up -d --wait caddy
# Only the exact smoke operator source can bypass the marker; all other clients see maintenance.
node "$here/gate-smoke.mjs"
rm "$MAINTENANCE_DIR/enabled"
trap - ERR
printf '%s\n' 'Authenticated smoke and compatibility checks passed. Traffic reopened.'
