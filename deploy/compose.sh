#!/usr/bin/env bash
set -euo pipefail
: "${DEPLOY_ENV:?Set DEPLOY_ENV to an absolute secrets env file outside the checkout}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$DEPLOY_ENV" in /*) ;; *) echo 'DEPLOY_ENV must be absolute' >&2; exit 1;; esac
case "$DEPLOY_ENV" in "$root"/*) echo 'Keep deployment secrets outside the checkout' >&2; exit 1;; esac
if [[ -n "${DEPLOY_COMPOSE_OVERRIDE:-}" ]]; then
  case "$DEPLOY_COMPOSE_OVERRIDE" in /*) ;; *) echo 'Override must be an absolute operator-reviewed path' >&2; exit 1;; esac
  exec docker compose --env-file "$DEPLOY_ENV" -f "$root/deploy/compose.yaml" -f "$DEPLOY_COMPOSE_OVERRIDE" "$@"
fi
exec docker compose --env-file "$DEPLOY_ENV" -f "$root/deploy/compose.yaml" "$@"
