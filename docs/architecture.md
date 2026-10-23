# Architecture

## Data ownership and modules

Customer application rows, application users, password hashes and sessions live in customer-owned PostgreSQL. Platform PostgreSQL stores platform users/sessions, projects, encrypted connection configuration, schema drafts/applied definitions, endpoint policies, API-key hashes/metadata, workflow versions and sanitized runtime events. Defaults and fill intents are plaintext metadata: never use them for secrets.

`backend/src/app.ts` builds an injectable Fastify application; `server.ts` owns startup, listening and shutdown. Routes validate transport input, services enforce business rules, and repositories issue parameterized platform queries. Platform schema/lifecycle code is in `database/platform-db/`, reviewed migrations in `backend/migrations/`, and customer execution in `database/customer-db/`. There is no production in-memory persistence fallback.

The Next.js dashboard lives in `frontend/`; `shared/` carries public transport vocabulary rather than persistence models. TanStack Query manages server data, React Hook Form edits forms, and Zod provides usability validation. Fastify remains authoritative.

## Identity boundaries

| Credential | Purpose and storage |
| --- | --- |
| Platform session | Own-project management under `/internal`; digest in platform PostgreSQL; HttpOnly dashboard cookie |
| Project API key | Enabled `key_only` runtime operations; SHA-256 digest in platform PostgreSQL; secret shown once |
| Application session | Customer signup/login and `authenticated`/`owner` runtime policies; digest and user records in customer PostgreSQL |

Credentials are not interchangeable. Ownership is part of persistence queries, not just a UI or service check. Unknown and foreign resources return the same 404. Application roles are exactly `user` and `admin`; admin bypass must be enabled on the particular operation. Project keys represent shared project access, not individual application users.

Platform signup normalizes email and returns the same 202 for new/existing accounts without logging in or modifying an existing account. Passwords require 15–128 Unicode code points and at most 512 UTF-8 bytes. Argon2id uses a shared bounded hashing budget. Platform `ps_` sessions contain 256 random bits, expire absolutely after 24 hours, and check expiry, revocation and active-account status on each request. Hourly cleanup removes at most 500 sessions expired/revoked more than seven days ago; authorization never depends on cleanup.

Platform login limits are 20/minute/IP and 5/15 minutes/email+IP; signup limits are 5/15 minutes/IP and 3/hour/email+IP. Bounded counters count successes and failures, reset on restart and do not permanently lock accounts. Multi-instance operation needs redesigned shared controls.

Platform auth routes are `POST /internal/auth/signup`, `POST /internal/auth/login`, `GET /internal/auth/me` and `POST /internal/auth/logout`. Login returns an opaque session once to the trusted dashboard server; `/me` returns only ID/email and logout revokes the current session. There is no refresh token or local authentication bypass.

## Dashboard and proxy boundary

`frontend/src/lib/server/adapter.ts` allowlists routes/methods against a fixed backend origin. `/api/management/*` forwards only the server-read platform session. `/api/runtime/*` forwards only an explicitly supplied runtime credential. The public integration URL is Fastify's `/api/{project-slug}`, not the dashboard relay.

Management responses use safe DTOs. Login never returns its platform token to browser JavaScript. Production uses `__Host-platform_session`, HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=86400 and no Domain. Explicit localhost `local-http` mode uses `platform_session` without Secure; forwarded headers cannot select a weaker mode. `/projects` and descendants verify `/internal/auth/me` server-side. Pages/fetches and API responses disable caching. Logout waits for revocation or an already-invalid session before clearing the cookie; login/logout use full navigation to discard query caches.

Mutations require the exact configured Origin and canonical Host, reject missing/null/malformed origins and cross-site fetches, and require JSON payloads. GET/HEAD never mutate. SameSite is defense in depth; strict Origin checks provide this same-origin MVP's CSRF boundary.

Only configure forwarded client-IP headers behind an ingress that overwrites them and prevents direct access. Next.js and Fastify trust exact configured peers, not arbitrary X-Forwarded-For/host/protocol chains. Without that topology, browser authentication conservatively shares the relay's IP quota. Set `DASHBOARD_TRUSTED_CLIENT_IP_HEADER` only on that ingress, and backend `TRUSTED_DASHBOARD_PROXY`/`TRUSTED_PROXY_IPS` only for the exact trusted sources appropriate to the topology. Hosted ingress, destination restrictions and HTTPS are described in [deployment](../deploy/README.md).

## Connections and runtime isolation

Each project has one encrypted customer connection. AES-256-GCM uses a fresh 12-byte nonce, 16-byte tag and project/connection IDs as authenticated context; envelope version 1 identifies the format. Credentials never return through management responses. Candidate save/replacement tests precede persistence, and stale results cannot overwrite newer settings. Connection tests establish connectivity/schema existence, not every DDL/CRUD permission.

Applied resources block arbitrary target replacement/deletion. Same-target credential updates preserve host/port/database/schema, validate capabilities and catalogs, serialize with setup and retain old ciphertext on failure. The encryption key stays outside PostgreSQL; offline rotation and historical backup-key custody are operator responsibilities.

Hosted attempts resolve approved exact DNS hostname/port pairs afresh, reject non-public destinations, pin a validated address and verify TLS against the original hostname. This applies to diagnostics, schema operations, runtime and auth. Local development permits disposable local databases; production cannot enable that exception.

Runtime dispatch uses fixed Fastify routes and current metadata, not generated executable customer code or dynamically registered routes. Applied definitions allowlist quoted identifiers; values are parameterized. No unrestricted SQL, customer schema compilation as code, wildcard projections or arbitrary execution is accepted. Catalog drift fails closed, including unexpected columns, constraints, indexes and triggers.

## Drafts, publication and revisions

Draft edits do not change customer tables or runtime contracts. Preview compiles a revision-bound plan; relationship preview also checks target catalogs read-only. Apply regenerates the plan server-side and rejects stale revision/hash inputs.

`draftRevision` is an optimistic edit token. Logical `appliedRevision` represents the API contract; `appliedPhysicalRevision` records applied physical state. Normal non-unique indexes advance physical state only. Field/default/requiredness and unique-index changes advance both. Workflow dependencies remain logical; affected workflows require deliberate preview/republish. Runtime metadata fences also bind physical state.

Historical plan/catalog/hash formats are explicitly dispatched rather than rewritten. Existing unversioned/v2/v3 formats, FK naming and auth catalogs retain their own comparisons. Schema evolution uses v4 for new field bundles; fill intent is consumed on successful publication or POST reconciliation and never enters the applied/public contract.

## Transactions and uncertain outcomes

Customer operations use bounded fresh clients closed in `finally`. Admission, lock, statement and absolute deadlines constrain work; destroying an overdue connection cancels it. Current default quotas and slot budgets are in [recovery](../deploy/RECOVERY.md#limits-and-failure-semantics).

Schema Apply verifies PRE under advisory/table locks, performs supported DDL/fills, verifies POST and writes an authenticated operation-bound receipt in the same customer transaction. Customer commit precedes platform publication. The two databases do not share a distributed transaction. An unknown COMMIT result or failed finalization blocks further setup rather than guessing success or rollback.

Reconciliation serializes with setup, checks actual catalogs and receipts, and changes platform metadata only. Exact PRE marks a reviewed failed/not-applied operation; exact authenticated POST finalizes publication; DIVERGED remains blocked. A matching-looking table without provenance is insufficient. The [recovery runbook](../deploy/RECOVERY.md) contains commands and restore containment procedures.

CRUD checks catalogs and executes inside its customer transaction. Expanded reads use one repeatable-read customer snapshot and independently authorize each target; a final metadata fence rejects changed policies/revisions before commit. This is a freshness check, not distributed atomicity.

A workflow uses one customer client/transaction for every block. It verifies dependencies before execution, locks application identity records for protected requests, and constructs a bounded response before commit. Successful responses send after commit; error-status Response blocks roll back prior writes. Stock-sensitive workflows use row locks and guarded atomic decrements, not an unprotected read/check/write sequence.

Lost HTTP responses and `WRITE_OUTCOME_UNKNOWN` never trigger automatic mutation replay. Inspect state and unique business identifiers before retrying. Browser cancellation only stops waiting; it does not prove rollback. Image rollback never reverses customer DDL.

## Secrets, logs and editor state

Logs exclude credential bodies, bearer/cookie headers, raw URLs/query strings, customer rows, SQL parameters and driver details. Request IDs correlate sanitized responses with operational logs. Owner-only runtime history has a stricter metadata allowlist and best-effort persistence; see [observability](platform-reference.md#runtime-observability).

API keys appear once in a modal; failed clipboard operations can be retried. Runtime credentials stay in transient state and clear on reload, logout, explicit clearing or target navigation as applicable. Clipboard, browser tooling and intentional screenshots are outside that guarantee. Late responses are invalidated when changing credentials/targets. Mutations are not replayed automatically.

Dirty forms protect navigation with Save/Discard/Stay where save is available and Discard/Stay otherwise; browser reload uses its normal confirmation. Refetch preserves edits, revision conflicts retain input, pending submissions freeze controls, and departed callbacks are suppressed. Current blockers outrank historical setup success. Docs fail closed for unavailable deployed contracts rather than silently omitting operations.

No password reset, email verification, OAuth, MFA, teams, custom executable policies, PostgreSQL RLS integration or general write-idempotency service is provided.

## Existing platform-auth upgrades

Migration `0006_dusty_micromacro.sql` preserves old user/project identities but disables legacy users with null password hashes. Signup cannot claim them. Remove obsolete `MANAGEMENT_API_TOKEN`/`MANAGEMENT_USER_ID` configuration. A trusted administrator must explicitly provision an Argon2id hash using the shared hasher and a parameterized update for the exact user ID; do not expose passwords/hashes in argv, logs or SQL history. There is no runtime bypass/provisioning endpoint. Back up metadata and follow the maintenance deployment before upgrading.
