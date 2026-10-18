# One-server private alpha

One backend instance, one Next.js instance, Caddy, and PostgreSQL 18. This is deployment tooling, not a high-availability system. Only Caddy publishes TCP 80/443. Backend and frontend listen on container interfaces with no published ports. PostgreSQL has an internal network and a persistent named volume. Never use `docker compose down --volumes` on a deployment you intend to keep.

## Prerequisites and DNS

Use a maintained Linux VPS, roughly 2 vCPU/4 GB RAM to start; measure actual load. Install current Docker Engine and Compose v2 using the distribution/vendor instructions. The deployment shell scripts require Bash, flock and standard checksum tools. Run Node-based smoke/acceptance scripts from a Node.js 24-equipped allowlisted operator machine (or install Node 24 on the server for those checks). Docker access is root-equivalent. Build images in CI or separately from the running workload when possible.

Point app.example.com and api.example.com A records at the VPS; add AAAA only if IPv6 routing/firewall is correctly configured. Caddy must receive direct public connections in this topology: do not put an unconfigured CDN/load balancer in front. Open inbound TCP 80/443 in provider and host firewalls, restrict SSH to administrator IPs, and check both IPv4 and IPv6. Never publish 5432, 3000, or 3001. Docker-published ports can bypass assumptions made by host firewall tools; verify externally.

Use SSH keys, disable password and direct root SSH login after verifying alternate admin access, install security updates, and limit administrator/Docker-group membership. No Kubernetes or additional control plane is required.

## Secrets and release images

Copy `deploy/env.example` to `/etc/private-alpha/deploy.env` outside Git. Set mode 0600 and restrict its parent directory. Replace all placeholders. Generate distinct hexadecimal passwords (URL-safe without extra escaping) and a 64-character hex connection encryption key. Do not pass credentials as shell arguments, commit env files, use NEXT_PUBLIC_ secrets, or put secrets in Docker build arguments.

The three database roles are initialized only on a fresh volume:

- `platform_bootstrap`: PostgreSQL administrator, available only to the PostgreSQL container and explicit operational backup/restore commands.
- `platform_migrator`: owns platform database/schema objects; used only by the one-shot migration job.
- `platform_app`: long-running backend; CONNECT/USAGE and table DML/sequence grants, no superuser/role creation/schema ownership. Read-only access to the migration journal permits readiness checks.

Compose constructs private `PLATFORM_DATABASE_URL` values using these passwords. The frontend receives no database/encryption credentials. Do not upgrade PostgreSQL major versions by changing the image tag on an existing volume; plan a separate tested upgrade/restore. Bootstrap env changes do not change passwords in an existing volume: perform deliberate role-password changes and update the env file together. Use a separate restore database/stack for recovery drills.

`CONNECTION_ENCRYPTION_KEY` MUST be backed up independently in an encrypted password manager/offline copy. Losing it makes saved customer credentials unreadable. Changing the env value does NOT rotate ciphertext. Restore requires the corresponding original key; online key rotation is not supported. Keep historical keys needed by retained backups. A platform dump contains password hashes and encrypted secrets and must be treated as sensitive.

For private GHCR packages, authenticate the deployment account with `docker login ghcr.io` using an interactive read-packages credential. Never pass a registry token as an argument or store it in Git.

Images use Node 24 Debian/glibc, non-root runtime users and compiled backend code. Root build context includes shared contracts. No .env files enter the image. Use a release such as `v0.3.0-alpha.1`, commit tags `sha-COMMIT`, and preferably resolved image digests in production. Never rely solely on `latest` or reassign release tags; record/pin digests. CI publishes release images only for version tags after checks pass; it never deploys. Set BACKEND_IMAGE/FRONTEND_IMAGE to the actual GHCR repository names produced by your repository's workflow.

## Network and proxy trust

The proxy bridge contains Caddy, Next.js and Fastify. A separate internal bridge contains backend, migration job and platform PostgreSQL. The frontend cannot directly reach the database through that network. Choose PROXY_SUBNET and CADDY_IP/FRONTEND_IP/BACKEND_IP that do not overlap host/VPN networks. Compose gives stable exact addresses; changing the subnet requires changing all peer addresses together. Avoid Docker host networking.

Caddy accepts only configured domains. The dashboard domain has an operator-maintained TESTER_CIDRS allowlist; use space-separated exact IPs or narrow CIDRs, never 0.0.0.0/0 or ::/0. It includes signup/login and all dashboard routes. If tester IPs are too dynamic, use a separately managed VPN/access gateway with a fixed ingress address and explicitly reviewed proxy trust rather than opening signup or adding product invitations in this milestone.

Caddy overwrites X-Real-IP and X-Forwarded-For from its connection peer and removes Forwarded. Next.js reads only the configured overwritten X-Real-IP for auth forwarding and creates a fresh X-Forwarded-For. Fastify trusts forwarding only from the exact configured Caddy/Next.js source addresses. No unrestricted trustProxy or public forwarding chains are accepted. Internal network membership and Docker administrator access are part of the trust boundary.

On app.example.com all requests route to Next.js after the IP check. On api.example.com only /api/* routes to Fastify; /internal, /health and all other paths return 404. Internal /internal calls use http://backend:3000. The public runtime origin is independently https://api.example.com. The API domain remains publicly reachable with runtime credentials/policies enforced by Fastify.

## HTTPS, cookies, headers and CORS

Caddy obtains/renews certificates and redirects HTTP to HTTPS. Persist caddy-data and caddy-config. DASHBOARD_ORIGIN must be the exact HTTPS app origin; BACKEND_ORIGIN is private HTTP; DASHBOARD_COOKIE_MODE=secure; PUBLIC_RUNTIME_ORIGIN is the HTTPS API origin. Compose supplies these from the domain settings. Do not use local-http in hosted deployment.

Platform cookie: __Host-platform_session; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400; no Domain. The proxy preserves the canonical Host. Dashboard mutations reject missing/null/malformed/hostile Origin and cross-site fetch signals; same-site cookies alone are not the CSRF control. Forwarded host/protocol cannot downgrade cookies. The browser never receives session tokens in readable JSON/storage.

Dashboard headers include nosniff, strict-origin-when-cross-origin, DENY and CSP frame-ancestors 'none'. HSTS starts at 86400 seconds without includeSubDomains/preload. Do not enable HSTS for local plain HTTP. Broader CSP is deferred to avoid breaking Next.js.

Set RUNTIME_ALLOWED_ORIGINS to comma-separated exact HTTPS tester application origins, e.g. https://tester-app.example.com. No wildcard/credentialed CORS. CORS is browser policy, not runtime authentication; server clients still need the configured runtime credentials.

## Customer PostgreSQL policy

Hosted policy is always restricted, even if someone attempts a development override. CUSTOMER_DB_ALLOWED_DESTINATIONS is a comma-separated list of exact DNS hostname:port pairs. No wildcard, IP literal, URL, private-destination exception or arbitrary customer-provided CA is supported. Require a trusted-certificate remote endpoint and ssl=true. Customer roles should be limited to their dedicated database/schema. Customers must allowlist the VPS's stable outbound IP, including any chosen IPv6 egress.

Every connection attempt (save/retest/replacement, schema apply, CRUD, auth provisioning/sessions and workflows) resolves the allowlisted hostname afresh, rejects any non-public/mapped/transition answer and cloud metadata destinations, and pins the socket to a validated address. TLS still validates the original approved hostname. DNS is bounded and re-resolved on the next connection. Changes to the allowlist apply to saved connections on their next attempt. Outbound DNS and approved database TCP ports must be reachable. This is an application destination boundary, not a general egress proxy or complete defence against a compromised application process.

Development/test mode permits disposable local databases. It is unavailable when NODE_ENV=production. Returned policy errors are sanitized DESTINATION_NOT_ALLOWED/TLS_REQUIRED, with no DNS/private-address/socket/SQL details. A database requiring a private endpoint is outside this hosted-alpha policy and needs a deliberate future network design.

## Fresh deploy and upgrade

From the checked-out release at the repository root:

```sh
export DEPLOY_ENV=/etc/private-alpha/deploy.env
export BACKUP_DIR=/var/backups/private-alpha
./deploy/deploy.sh
```

The script uses a host flock, validates Compose, pulls release images, starts/waits for PostgreSQL, backs up an existing schema, runs one migration container, then starts/waits for backend/frontend/Caddy. The migration runner also takes a PostgreSQL advisory lock, so concurrent manual migration jobs serialize. No application startup performs migrations.

Equivalent explicit commands (serialize them with the same operator/deploy lock):

```sh
./deploy/compose.sh config --quiet
./deploy/compose.sh pull
./deploy/compose.sh up -d --wait platform-postgres
# Existing deployment only, before migrations:
./deploy/backup.sh
./deploy/compose.sh run --rm migrate
./deploy/compose.sh up -d --wait backend frontend caddy
./deploy/compose.sh ps
```

For a local build, set immutable local validation image tags in an external env file and run `./deploy/compose.sh build backend frontend` instead of pull. Production images run node dist/server.js and ordinary Next.js production start on 0.0.0.0:3001. The compiled migration runner and reviewed SQL/journal are included. Schema migration generation remains a development task.

Health: PostgreSQL uses pg_isready; backend /health/live is independent of DB; /health/ready uses a separate bounded connection to verify latest migration hash and minimum auth schema; frontend /health/ready checks origin/cookie configuration. Health responses contain only generic status. Backend health routes are private and require no platform session. Compose dependency conditions aid startup; an unhealthy running container is not automatically restarted just because a health check fails. A DB outage should make readiness fail without restart loops.

## Smoke and acceptance

Use disposable data first. Create a mode-0600 JSON file outside Git with appOrigin, apiOrigin, email, password (15+ characters), runtimePath (GET /api/SLUG/RESOURCE), runtimeKey, and corsOrigin. The runtime fixture must already exist from the product acceptance flow; the smoke script does not silently provision customer schemas.

```sh
SMOKE_CONFIG=/etc/private-alpha/smoke.json node deploy/smoke.mjs
```

Run it from an allowlisted source; an on-server request may appear as a Docker gateway IP and is not automatically approved. It checks both HTTPS hosts, private paths, signup/login, Secure HttpOnly cookie, no token in JSON, authenticated project listing, hostile Origin, authenticated runtime and configured CORS. It logs only a generic pass/fail. Do not enable verbose HTTP tracing with secrets. For a local Caddy CA use NODE_EXTRA_CA_CERTS pointing to its exported root, not TLS verification bypass.

Acceptance on a fresh stack:

1. Verify PostgreSQL health, one migration job, backend/frontend readiness and HTTPS.
2. Signup/login, create project, connect an approved TLS disposable customer DB, create/apply a table, issue a runtime key, and call its public generated API.
3. Create/publish/enable a representative workflow and verify its runtime result.
4. Keep the browser session open; run `./deploy/compose.sh restart backend frontend`, wait for health, reload. Verify session/project persist, retest saved encrypted connection and call API/workflow again.
5. Verify public /internal and /health return 404; verify unapproved/private DB destinations and ssl=false are rejected. Verify two-user project isolation and hostile Origin rejection.
6. Perform the backup/isolated restore drill below. Check published ports externally on IPv4/IPv6. Verify renewal/storage configuration and restricted dashboard access before adding testers.

For scripted disposable provisioning, create a mode-0600 ACCEPTANCE_CONFIG JSON outside Git with `disposable: true`, appOrigin, apiOrigin, email, password, stateFile (absolute outside Git), and customerConnection (label, host, port, database, username, password, schema, ssl=true). Run:

```sh
ACCEPTANCE_CONFIG=/secure/acceptance.json node deploy/acceptance.mjs
./deploy/compose.sh restart backend frontend
# Add verifyState pointing to stateFile in the protected JSON, then rerun:
ACCEPTANCE_CONFIG=/secure/acceptance.json node deploy/acceptance.mjs
```

This creates real disposable schema/rows and a workflow. The state file contains a session cookie and runtime key: protect and delete it after the drill. It is never printed. The restart run uses the original session rather than logging in again. It deliberately does not clean up platform/customer artifacts automatically.

## Backup, restore and recovery

Nightly and before migrations:

```sh
DEPLOY_ENV=/etc/private-alpha/deploy.env BACKUP_DIR=/var/backups/private-alpha ./deploy/backup.sh
```

The script creates a timestamped custom-format pg_dump with restricted file permissions, SHA-256 checksum, deployed image metadata and latest migration hash. Errors are non-zero; partial dumps never receive a final filename. Upload the dump and sidecars encrypted to an off-server destination using your existing backup tool/credentials. Local backup success is not off-server success: monitor upload success separately. Keep seven daily and four weekly copies. Store off-server credentials outside Git with minimal access. VPS snapshots/volumes alone are insufficient. Customer application data is not backed up by us.

Test restore before alpha access, monthly, and after backup/migration changes:

1. Start a separate PostgreSQL/container/volume with no customer-network access, and restore using the matching release and role setup. Never point these commands at the running platform.
2. Check checksum, use `pg_restore --exit-on-error --no-owner --no-acl` into the empty isolated database under the migration owner. Retain/recreate the restricted app grants separately if needed. Do not apply a newer release's migrations just to make old backup verification pass.
3. Supply the isolated PLATFORM_DATABASE_URL and corresponding CONNECTION_ENCRYPTION_KEY to the matching backend image. Run `node dist/database/platform-db/verify-restore.js` with CONFIRM_ISOLATED_RESTORE=yes. It checks migration/schema, counts users/projects, decrypts all customer connection records only in memory, and revokes all restored platform sessions. It never connects to customer databases or prints decrypted data.
4. Verify expected metadata counts and sampled owned records. Test wrong-key failure safely. Any schema/runtime write validation must use disposable customer targets, not real restored connections.
5. For actual disaster recovery, keep traffic closed until verification/session invalidation succeeds, then reopen with correct secrets and compatible images. Expect downtime and up to roughly 24 hours' platform-data loss with nightly-only backups.

An example isolated restore using an already prepared separate PostgreSQL service is:

```sh
# Destination credentials must be provided by a restricted env/pgpass file.
pg_restore --exit-on-error --no-owner --no-acl /secure/backup.dump
# Run via an isolated container env-file; never put secret values in command arguments:
docker run --rm --network RESTORE_NETWORK --env-file /secure/restore.env BACKEND_IMAGE node dist/database/platform-db/verify-restore.js
```

Set PGHOST/PGPORT/PGUSER/PGDATABASE and a mode-0600 PGPASSFILE for the isolated destination; never shell-expand a credential-bearing URL into a command-line argument.

## Logging, operation and rollback

Application logs are structured stdout/stderr with request ID, route template, status, elapsed time and safe principal IDs. Never enable body/SQL/header dumps. Caddy error logs strip request/response-header objects, and access logging is not enabled; do not add raw URL/query/header logs. Compose rotates json-file logs at 10 MB x 3 per service. Monitor availability, disk/memory, backup/upload failures and certificate health. External error tracking is deferred.

Platform/customer auth counters and hashing/runtime capacity are process-local; counters reset on restart. One backend only. Current fresh-client limits are appropriate for low-volume alpha, not a global total connection limit: runtime/workflows share ten transaction slots, customer auth has its own budget, diagnostics/schema operations are separate. No pooling redesign or Redis is introduced. Horizontal scaling needs shared limits, coordinated budgets and migration discipline.

For application rollback, deploy previous compatible immutable image tags/digests and wait for readiness/smoke checks. Never automatically down-migrate. Prefer forward repair; backup restore is a deliberate downtime/data-loss recovery operation. A newer schema may be incompatible with old readiness/application code. Customer schema changes are independent and are not undone by platform-image rollback.

Limitations: no email verification/reset, invitations, teams, billing, enterprise secrets manager, multi-region/HA, automatic failover or scaling. Customer availability, TLS certificates and connection quotas affect runtime. Schema/workflow mutation limits and uncertain-write recovery remain as documented in the product README. This milestone adds no production email, queues, observability platform, Kubernetes or Terraform.

## Generated API documentation

Set `PUBLIC_RUNTIME_ORIGIN` consistently for backend and frontend. Compose supplies
`https://${API_DOMAIN}` to both; `BACKEND_ORIGIN` remains private. Backend production
startup requires an exact HTTPS origin. No migration is required for API Docs.

Project owners can open Docs and download OpenAPI 3.1 JSON. Documents are generated
on demand from applied schema, current enabled operations/auth, and published enabled
workflows. They are never public routes. Blocked deployment metadata, unavailable
applied definitions, or stale enabled workflows return sanitized `API_DOCS_UNAVAILABLE`
(503); resolve deployment state or republish/disable the stale workflow and retry.
Generation does not connect to customer databases or detect live external drift.
The document's fixed `info.version` identifies the document contract, not versioned API releases.

Verify after deployment: sign in, open a project's Docs page, confirm the public API
server URL, download JSON, and use Try in Playground. It must select and populate an
operation without sending a request. A second platform account must receive 404 for
that project's management OpenAPI endpoint. Public `/internal` stays blocked by Caddy.

For independent local validation with backend dev dependencies installed:
`cd backend && npm exec -- validate-api /path/to/project-openapi.json`.
Workflow dynamic database results deliberately use unconstrained JSON schemas.
Examples are synthetic; stored defaults and workflow literal values are never copied.
