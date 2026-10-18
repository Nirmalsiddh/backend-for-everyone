# Local deployment validation

Validated with disposable data on 2026-10-18. This records executable local evidence, not a claim of deployment to an external VPS.

- Backend: clean npm install, typecheck, production build; 56 unit/HTTP tests passed.
- PostgreSQL integration: 44 tests passed, zero skipped, including customer Alice/Bob ownership, workflow transactions and legacy migration preservation.
- Frontend: clean npm install, typecheck, production build; 21 focused tests passed.
- Existing authenticated Playwright suite: 10 tests passed, including the full product flow.
- Both production Dockerfiles built. Compiled backend and ordinary Next.js production images ran as non-root users.
- Compose parsed; executable publication/network/role checks passed. Only Caddy published ports, bound to loopback for this lab.
- Fresh PostgreSQL volume initialized separate bootstrap/migrator/application roles; one explicit compiled migration job succeeded. The runtime application role was denied DDL.
- Private backend/frontend readiness passed. With platform PostgreSQL stopped, liveness remained 200 and readiness returned sanitized 503; recovery succeeded after restarting PostgreSQL.
- Caddy 2.11.4 served app.alpha.localhost and api.alpha.localhost over HTTPS with a trusted lab CA. Public /internal and backend health paths returned 404.
- Disposable HTTPS acceptance provisioned a platform account/project, rejected private/unapproved and plaintext destinations, connected a verified-TLS customer fixture, applied schema, and executed generated API and workflow requests.
- Original session/project/encrypted connection/runtime/workflow remained usable after backend/frontend restart and the final backend image recreation.
- Verified-HTTPS browser checks (certificate verification enabled) passed for Secure HttpOnly SameSite cookies, absence from document.cookie/storage/browser JSON, public runtime URL, reload, logout and protected redirect.
- Caddy rejected an unapproved client despite forged forwarding headers. Smoke checks passed for hostile Origin and configured runtime CORS.
- Timestamped custom pg_dump backup and metadata/checksum were created. Restore into a separate internal-network PostgreSQL container passed migration/metadata/decryption checks, rejected a wrong key, and invalidated restored sessions without customer network access.
- Actual service logs were checked against test passwords, platform/runtime tokens, database passwords and encryption key; none were present.
- CI YAML, shell scripts and git diff whitespace checks passed. The GitHub-hosted workflow and registry publishing have not been run from this workspace.

The customer TLS fixture used a synthetic public-classified address on an isolated Docker network and an explicitly trusted test CA. This exercises the production DNS-pinning/TLS path; it is not an external customer service. Public DNS/ACME issuance, real remote database access from the VPS, provider/IPv6 firewall verification, and encrypted off-server backup upload still require validation on the actual deployment target. No real customer databases were modified.
