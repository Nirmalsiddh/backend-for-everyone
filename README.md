# Backend Platform

A PostgreSQL-backed API builder, with a management API foundation, encrypted customer PostgreSQL connection management, a Schema Builder MVP, predefined runtime APIs, customer-owned end-user authentication, and custom transactional workflows. Customer application data will remain in customer-owned databases; platform PostgreSQL stores management metadata only.

## Implemented milestone

- Node.js 24 LTS, strict TypeScript, Fastify, and Drizzle with `pg`.
- Validated environment configuration and bounded platform connection pool/query timeouts.
- Versioned migrations for platform users and projects.
- Authenticated project creation and owner-scoped retrieval.
- One encrypted PostgreSQL connection per project, tested before creation or replacement.
- Editable schema drafts, deterministic SQL previews, transactional customer table creation, and nullable-column additions.
- Versioned schema metadata, migration outcomes, and conservative drift checks.
- Configurable list/get/create/patch/delete APIs for applied tables, revocable project API keys, and bounded customer query execution.
- Customer-owned Argon2id users, revocable sessions, fixed roles, and operation-level ownership authorization.
- Versioned custom POST workflows with branching, owner-aware database blocks, guarded stock decrements, and atomic execution.
- Request validation, sanitized error responses/logs, and unit and PostgreSQL integration tests.

General relationship-builder foreign keys and destructive schema edits are future milestones. Customer DDL is generated exclusively from validated typed definitions; arbitrary customer SQL or code execution is not supported.

## Repository structure

```text
AGENTS.md                         durable contributor instructions
backend/
  src/
    app.ts                        injectable Fastify application
    server.ts                     startup checks, listener, shutdown
    config/env.ts                 configuration validation
    database/platform-db/         platform pool, Drizzle schema, migrations runner
    modules/projects/             project management
    modules/database-connections/ encrypted connection lifecycle
    modules/schema-builder/       drafts, plans, management routes, metadata persistence
    modules/endpoints/            table API configuration
    modules/api-keys/             runtime key issuance and revocation
    modules/project-auth/         auth configuration, hashing, sessions, attempt limits
    modules/workflows/            workflow drafts, publication, validation, interpreter
    runtime/                      fixed routes, validation, safe query compilation
    database/customer-db/         short-lived diagnostics and transactional schema executor
    security/                     shared password hashing and AES-GCM encryption
  migrations/                     generated SQL and Drizzle metadata
  tests/                          unit and HTTP injection tests
    integration/                  real PostgreSQL tests
```

Add workflow modules when that milestone starts. Keep platform repositories separate from the future dynamic customer query layer.

## Local setup

Install Node.js 24 LTS and PostgreSQL 16 or newer. Run commands below from `backend/`.

```sh
npm ci
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use the generated value for `CONNECTION_ENCRYPTION_KEY` (exactly 64 hex characters). Keep the encryption key outside PostgreSQL and source control; retain it across restarts. Losing or changing it makes saved customer credentials unreadable. Configure `PLATFORM_DATABASE_URL` for an existing, dedicated platform database. The migration role needs DDL permissions; use a restricted application role for normal operation. Do not use customer database credentials here. PostgreSQL TLS can be configured through the connection URL; do not disable certificate verification for remote databases.

```sh
npm run db:migrate
```

Start the backend with `npm run dev`, configure the dashboard as described in [frontend/README.md](frontend/README.md), then visit `/signup` and `/login`. No manually inserted operator or fixed management token is required. The backend listens on `127.0.0.1:3000` by default. Migrations remain an explicit deployment step.

## Platform authentication and management API

Platform users live in the platform `users` table. Customer application users and sessions remain in customer PostgreSQL and are independent. Public `POST /internal/auth/signup` accepts email/password, normalizes email by trimming/lowercasing, and returns the same 202 for new/existing emails. It does not create a session or change existing accounts. Passwords require 15–128 Unicode code points and at most 512 UTF-8 bytes. Login verifies Argon2id and returns a fresh opaque `ps_` session once to the trusted Next.js server. `/internal/auth/me` returns only ID/email; `/internal/auth/logout` revokes only the current session.

All protected `/internal` requests require a platform session bearer credential. The database stores only its SHA-256 digest; sessions expire absolutely after 24 hours. Every request checks expiry, revocation, and active user status. Hourly cleanup deletes at most 500 sessions expired/revoked more than seven days ago; authorization never depends on cleanup. There is no refresh token or local bypass.

Projects and nested management resources derive ownership from the validated platform principal and retain owner-scoped persistence queries. Unknown/foreign resources return 404. Platform sessions cannot authorize customer runtime routes; customer `us_` sessions and project API keys cannot authorize management routes.

Login limits: 20/minute/IP and 5/15 minutes/email+IP. Signup: 5/15 minutes/IP and 3/hour/email+IP. Counters are bounded to 10,000 entries, count successes/failures, return 429/Retry-After, and never permanently lock an account. Limits are single-process, reset at restart, and require shared storage before multi-instance deployment. Password hashing shares a process-wide default budget of two concurrent operations with customer auth.

### Upgrading existing alpha data

Back up the platform database, stop the old dashboard/backend, and apply migration `0006_dusty_micromacro.sql` before starting the new code. Existing user IDs, emails, creation times and project owners are preserved. Existing users receive `status=disabled` and a null password hash. Signup cannot claim these accounts. Remove obsolete `MANAGEMENT_API_TOKEN` and `MANAGEMENT_USER_ID` environment settings; neither is used by the application.

New development/test accounts use signup/login. An existing operator remains unable to log in until explicitly provisioned by a trusted database administrator: generate an Argon2id hash using the shared backend hasher through a private local tool, then parameterize an UPDATE for that exact user ID setting `password_hash`, `status='active'`, and `updated_at=now()`. Do not put the password/hash in shell arguments, logs, SQL history, or source control. This is a one-off migration task, not a runtime fallback; no provisioning endpoint is provided.

No email verification or password recovery exists in this milestone. Email is a login identifier, not proof of mailbox ownership. HTTPS is mandatory in production. Never log credential bodies, password hashes, session tokens/digests, Authorization, Cookie or Set-Cookie headers.

## Validation and migrations

```sh
npm run typecheck
npm test
npm run build
npm start
npm run db:generate
```

`.editorconfig` defines two-space indentation and LF line endings; no formatter or linter is configured yet. `npm test` runs environment and injected HTTP tests without PostgreSQL. `npm run build` emits production code to `dist/`. Schema changes belong in `src/database/platform-db/schema.ts`; generate and review SQL migrations before applying them. Commit migration metadata and `package-lock.json`.

For real database tests, create a separate disposable database and provide its URL:

```sh
TEST_DATABASE_URL=postgresql://platform:password@localhost:5432/platform_test \
TEST_CUSTOMER_DATABASE_URL=postgresql://customer:password@localhost:5432/customer_test \
npm run test:integration
```

For the optional alpha-upgrade preservation test, also provide `TEST_LEGACY_DATABASE_URL` pointing to a separate **empty** disposable database. This fixture applies alpha migrations, inserts a legacy operator/project, then applies the auth migration; use a fresh database for each run.

This command requires both URLs explicitly, applies migrations to the platform test database, and inserts/deletes test-owned records. The customer test database must be separate, have a `public` schema, accept non-TLS connections for this local fixture, and enforce password authentication (SCRAM recommended); trust authentication cannot verify the invalid-password test. Integration files run sequentially to avoid competing migration setup. Never target a production database. It checks persistence, owner isolation, duplicate conflicts, foreign keys, checks, SQL value parameterization, and repeat migration application. No coverage threshold is set yet.

## Customer PostgreSQL connections

Each project supports one connection. All five routes require the platform session bearer credential and project ownership:

| Method | Route                                                    | Behavior                                         |
| ------ | -------------------------------------------------------- | ------------------------------------------------ |
| POST   | `/internal/projects/:projectId/database-connection`      | Test and create; `201`                           |
| GET    | `/internal/projects/:projectId/database-connection`      | Safe metadata; `200`                             |
| POST   | `/internal/projects/:projectId/database-connection/test` | Test saved settings, with no request body; `200` |
| PUT    | `/internal/projects/:projectId/database-connection`      | Test and fully replace settings; `200`           |
| DELETE | `/internal/projects/:projectId/database-connection`      | Remove saved configuration only; `204`           |

POST and PUT require all of these fields:

```json
{
  "label": "My PostgreSQL",
  "host": "db.example.com",
  "port": 5432,
  "database": "myapp",
  "username": "myapp_service",
  "password": "your-database-password",
  "schema": "public",
  "ssl": true
}
```

A successful response contains only `id`, `projectId`, `label`, `lastTestStatus`, `lastTestedAt`, `createdAt`, and `updatedAt`. Connection settings and encryption metadata are never returned. PUT requires the password again; it does not use masked or omitted password values. A failed candidate test changes nothing in the saved record. Duplicate creation returns `409`; missing or foreign-owned projects return `404`.

The complete configuration is encrypted with AES-256-GCM using a fresh 12-byte nonce, 16-byte tag, and project/connection IDs as authenticated context. Version `1` identifies the encryption format; advanced key rotation is not implemented. The platform table enforces a unique project foreign key. Tests and replacement writes match the encrypted configuration to avoid applying stale results to newer credentials.

Diagnostics use a fresh `pg.Client`, `SELECT 1`, and a parameterized schema-existence query. Clients are closed in `finally`. Connection timeout is five seconds, statement timeout two seconds, and client query timeout three seconds per query. Tests never create schemas or modify customer rows. Schema existence does not imply permissions to create tables or perform CRUD. Use restricted customer database roles.

Failures return sanitized `AUTHENTICATION_FAILED`, `CONNECTION_FAILED`, or `SCHEMA_UNAVAILABLE` errors with `422`, or `CONNECTION_TIMEOUT` with `504`. A failed explicit retest records `lastTestStatus: "failed"`; success records `"success"`. Status represents the latest completed check, not continuous monitoring.

`ssl: true` verifies certificates using the system trust roots. Certificate configuration is deferred. `ssl: false` explicitly disables TLS; use it only on trusted local/private connections. Socket paths, connection URLs, and extra driver settings are rejected as input. Private hosts remain supported; advanced destination/DNS protection and network egress controls are deferred. Keep this MVP management API accessible only to trusted operators. Runtime pooling, customer schema/namespace creation, and multiple connections remain out of scope. Schema Builder creates tables inside the configured existing schema.

## Architecture decisions and next steps

Routes perform transport validation, services hold business rules, and repositories own parameterized platform queries. `buildApp` receives a repository, allowing HTTP tests without a live database. Production uses PostgreSQL, with no in-memory persistence fallback. Logs record route templates and status codes, excluding raw URLs, headers, bodies, and database error details.

Implement per-user management authentication before onboarding real customers. The Schema Builder MVP below remains restricted to trusted operators. Customer queries need their own schema-aware identifier allowlist and parameterized values rather than static ORM schemas. Schema edits are versioned, previewed operations; unexpected drift blocks apply and requires operator review. Later workflows should use typed, validated blocks, bounded execution, and transaction boundaries for related writes; stock checks and decrements must be atomic to prevent overselling. Keep arbitrary code execution out of the MVP.

The dependency audit currently reports four moderate development-only findings in Drizzle Kit’s legacy esbuild loader chain. The affected development-server functionality is not used here; production dependencies audit clean. Recheck upstream tooling before widening its use.

## Schema Builder MVP

Run `npm run db:migrate` before starting the updated server. Migration `0002_schema_builder.sql` adds `schema_tables`, `schema_fields`, and `schema_migrations`. These are platform metadata; customer rows remain in the connected database. No additional environment variables or dependencies are required. PostgreSQL 16+ is supported.

All seven routes require management authentication and project ownership. Foreign-owned resources return `404`:

| Method | Route                                                          | Behavior                                                             |
| ------ | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/internal/projects/:projectId/schema`                         | List managed table drafts and applied metadata                       |
| POST   | `/internal/projects/:projectId/schema/tables`                  | Create a draft; `201`                                                |
| GET    | `/internal/projects/:projectId/schema/tables/:tableId`         | Retrieve a definition                                                |
| PUT    | `/internal/projects/:projectId/schema/tables/:tableId/draft`   | Replace the draft at an expected revision                            |
| DELETE | `/internal/projects/:projectId/schema/tables/:tableId`         | Delete a never-applied definition; `204`                             |
| POST   | `/internal/projects/:projectId/schema/tables/:tableId/preview` | Compile SQL without connecting to or modifying the customer database |
| POST   | `/internal/projects/:projectId/schema/tables/:tableId/apply`   | Verify the plan and execute it transactionally                       |

Example creation body:

```json
{
  "name": "products",
  "fields": [
    { "name": "sku", "type": "text", "nullable": false, "unique": true },
    { "name": "title", "type": "varchar", "options": { "length": 200 } },
    {
      "name": "price",
      "type": "decimal",
      "options": { "precision": 12, "scale": 2 },
      "default": { "kind": "literal", "value": "0.00" }
    },
    {
      "name": "created_at",
      "type": "timestamp",
      "default": { "kind": "current_timestamp" }
    }
  ]
}
```

`fields` contains custom fields only. Every physical table additionally receives an immutable `id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid()`. The generated key is not a configurable field. Custom fields default to nullable and non-unique. An empty custom field list creates a table containing just the generated key.

To edit, send `name`, the complete `fields` list, and `expectedDraftRevision`. Retain returned field IDs for existing fields; omit IDs for new fields. Do not send server-controlled `position`. Omit `default` to remove a draft default; literal JSON null is accepted only for JSONB. Draft revisions increment on successful edits. GET returns both current draft and last applied revision; draft writes never modify customer tables.

Preview accepts no body and returns `{ planHash, draftRevision, operation, sql }`. It validates the supported changes and compiles the stored definition; it does not verify current customer permissions or object conflicts. Apply accepts only:

```json
{
  "expectedDraftRevision": 1,
  "planHash": "the-64-character-hash-returned-by-preview"
}
```

Apply regenerates SQL on the server. A stale revision/hash returns `409`. Success returns `{ migrationId, status: "applied", table }`. Applying an already applied plan with no further additions returns `409`; it does not rerun DDL. No endpoint accepts SQL. Literal defaults may appear in the authorized definition/preview response, so do not use schema defaults to store secrets. Routine logs exclude bodies, SQL, driver errors, and credentials.

### Types and validation

Supported types are `text`, `varchar`, `integer`, `bigint`, `decimal`, `boolean`, `uuid`, `date`, `timestamp`, and `jsonb`. `timestamp` always means PostgreSQL timestamp with timezone. Varchar requires `options.length` from 1 to 10,000. Decimal requires precision 1–38 and scale 0–precision. Other types reject type options. Bigint and decimal literal defaults are strings to preserve precision. Integer defaults must fit signed 32-bit values; bigint defaults must fit signed 64-bit values. Date literals use real `YYYY-MM-DD` dates; timestamp literals require an ISO date/time with timezone. JSONB literal defaults are limited to 8 KiB and nesting depth 20. Text defaults are limited to 10,000 characters. Existing rows do not receive automatic updated-at behavior.

Defaults are `{ "kind": "literal", "value": ... }` or, for timestamps only, `{ "kind": "current_timestamp" }`. Functions and SQL expressions are rejected. SQL-like text remains an escaped literal string. Single-column uniqueness is supported on scalar fields; nullable unique fields allow multiple nulls. JSONB uniqueness is deferred.

Table/column names must start with a lowercase ASCII letter and consist of lowercase letters, digits, and single internal underscores, up to 63 characters. Reserved SQL names, PostgreSQL system column names, and `pg_`, `sql_`, `platform_`, `internal_`, and `schema_` prefixes are rejected. The name `id` is reserved for the primary key. Names cannot contain dots, quotes, whitespace, or SQL comments. The configured existing customer schema is quoted separately, and PostgreSQL system schemas are rejected. Tables support at most 100 custom fields; the existing 64 KiB HTTP body limit also applies.

### Allowed changes and connection lifecycle

Before first apply, drafts can be renamed, fields can be added/removed, and types/constraints/defaults can be edited. Once applied, only new nullable columns without defaults or unique constraints may be added. Existing applied fields, their identities, and their ordering are immutable. Foreign keys, renames, column drops, type changes, constraint changes, physical table deletion, imports, custom SQL, custom indexes, triggers, and functions are unsupported.

Deleting a never-applied definition removes platform metadata only. It never drops an existing customer object with the same name. Connection replacement/deletion returns `409 CONNECTION_IN_USE` while any schema definition depends on it. Unapplied drafts may be removed first; rebinding applied schemas to another connection is deferred. Retesting a saved connection remains supported.

### Apply failures and operator recovery

Apply reserves a durable migration record, then uses one short-lived customer client and one PostgreSQL transaction. A project can have only one unresolved apply. Customer operations acquire an advisory lock per target schema; additive changes also lock the managed table before checking its catalog snapshot. DDL uses a two-second lock timeout and five-second statement timeout. PostgreSQL statement errors roll back the transaction and produce a sanitized failed migration. Applied metadata advances only after customer commit succeeds.

Apply compares managed table columns, defaults, constraints, indexes, triggers, and relevant table flags with the last applied catalog snapshot. External changes block further alterations with `409`; existing customer tables are never silently imported or adopted. Preview is compilation only, so apply can still fail due to drift, permissions, conflicts, or connectivity.

The platform and customer databases do not share a transaction. A lost commit response produces `outcome_unknown`; a process crash or failed platform finalization can leave `applying`. Both statuses block new drafts, draft edits, deletion, and further applies for the project. They must not be automatically retried or treated as rollback.

For an interrupted attempt, a trusted operator must first ensure the original request/process and customer transaction have ended. Inspect the platform migration's target definition and the customer catalog using a separate administrator connection, and establish whether the intended transaction committed. Matching object shape alone does not establish provenance. If rollback is established, record the attempt as failed. If commit is established, atomically finalize the matching applied definition/revision and the migration outcome, using a catalog snapshot in the executor's format. If the result cannot be established, keep the project blocked. Back up metadata before manual repair. There is intentionally no public reconciliation endpoint, background recovery worker, or automatic schema adoption in this milestone.

## Predefined Endpoint Runtime MVP

Apply migration `0003_predefined_runtime.sql` with `npm run db:migrate`. It adds `endpoints` and `api_keys`; a composite foreign key prevents linking an endpoint to another project's table. No new package dependencies are introduced. Only customer schema metadata, endpoint configuration, key hashes, and connection settings are stored in the platform database. Customer rows are queried and returned directly from customer PostgreSQL.

### Configure table APIs

These owner-scoped routes use the existing management bearer credential:

| Method | Route                                                      | Behavior                                   |
| ------ | ---------------------------------------------------------- | ------------------------------------------ |
| GET    | `/internal/projects/:projectId/endpoints`                  | List table API configurations              |
| GET    | `/internal/projects/:projectId/schema/tables/:tableId/api` | Retrieve one configuration                 |
| PUT    | `/internal/projects/:projectId/schema/tables/:tableId/api` | Create/replace configuration               |
| POST   | `/internal/projects/:projectId/api-keys`                   | Create a runtime key; secret returned once |
| GET    | `/internal/projects/:projectId/api-keys`                   | List safe metadata, including revoked keys |
| DELETE | `/internal/projects/:projectId/api-keys/:keyId`            | Revoke a key; `204`                        |

After applying a table, PUT its API configuration:

```json
{
  "enabledOperations": ["list", "get", "create", "update", "delete"],
  "expectedAppliedRevision": 1,
  "expectedConfigRevision": 0
}
```

First creation uses configuration revision `0`; updates require the returned revision. Mismatched revisions or an unapplied table return `409`. Empty operations disable the table API. The resource name is always the applied table name; custom paths, PUT replacement operations, and custom SQL are unsupported. Configurations take effect on subsequent requests without a restart.

Create a key with `{ "name": "Frontend reads", "scope": "read" }` or `{ "name": "Server writes", "scope": "read_write" }`. Creation returns metadata plus `key`, with `Cache-Control: no-store`. Copy the secret immediately: subsequent listing returns neither it nor its hash. Keys contain 256 random bits, use SHA-256 hashes at rest, and are revoked through the management DELETE route. `keyPrefix` is a short display identifier. Revocation affects subsequent authentication checks; an already authorized request may finish.

### Runtime routes and authentication

For key_only table operations, send `Authorization: Bearer <project-api-key>`. Protected operations use application sessions as described below:

| Method | Route                             | Result                           |
| ------ | --------------------------------- | -------------------------------- |
| GET    | `/api/:projectSlug/:resource`     | Paginated list                   |
| GET    | `/api/:projectSlug/:resource/:id` | Row or `404`                     |
| POST   | `/api/:projectSlug/:resource`     | Created row; `201` with Location |
| PATCH  | `/api/:projectSlug/:resource/:id` | Updated row or `404`             |
| DELETE | `/api/:projectSlug/:resource/:id` | `204`, or `404` when absent      |

Read keys permit list/get. Read-write keys permit all enabled operations. Missing, invalid, revoked, wrong-project, and management credentials return `401`; insufficient scope returns `403`. Disabled or unknown resources/operations return `404`. These fixed Fastify routes resolve configurations from PostgreSQL on every request; no generated source code or dynamic route registration is involved.

Project keys grant shared project-level access. They are not application-user identities and provide no row-level authorization. A key embedded in frontend JavaScript is visible to its users. Use browser read keys only for data acceptable to expose to key holders, and keep private write keys in a trusted backend/BFF. End-user sessions and ownership policies are available in the auth milestone below; field permissions remain deferred.

### Request and response contract

Bodies use applied schema field names directly. Unknown fields and supplied `id` are rejected. POST requires non-nullable fields without defaults; omitted defaulted columns are left for PostgreSQL, including the generated UUID key. Empty objects are accepted on POST only when all required fields can be omitted. PATCH requires a nonempty object, updates supplied fields only, and never applies creation defaults. Null is permitted only for nullable fields. For JSONB, request null means SQL NULL; a distinct JSON-null sentinel is deferred. Arrays and other JSON values are explicitly serialized as JSONB parameters.

Text/varchar and UUID use strings; integer uses a JSON integer; bigint/decimal use exact decimal strings; boolean uses JSON booleans; date uses real `YYYY-MM-DD` values; timestamp requires timezone-aware ISO input and is returned as a UTC ISO string at JavaScript millisecond precision. JSONB uses JSON values. Varchar, numeric, JSON size/depth, and scalar validation reuse the Schema Builder limits. Runtime bodies retain the 64 KiB HTTP limit. Bigint/decimal/date projections avoid implicit driver number/date conversion.

List accepts only `limit`, `offset`, `sort`, `direction`, and literal equality-filter query keys:

```text
/api/my-shop/products?limit=25&offset=0&sort=price&direction=desc&filter[active]=true
```

Defaults are limit 25, offset 0, and id ascending. Limit is 1–100; offset is 0–10,000. One applied scalar sort field is allowed; JSONB sorting is rejected. Custom sort uses id ascending as a tie-breaker, with nulls last. Numeric fields sort by their PostgreSQL numeric columns, even though responses represent them as strings. Offset pagination can move between requests when rows change.

At most five scalar equality filters are combined with AND. Query values are validated against their field types. Duplicate query keys, unknown fields, nested operators, JSONB filters, SQL-null filters, and unknown query options are rejected. A text filter value `null` is literal text, not SQL NULL. No OR, IN, ranges, search, regex, joins, or JSON paths are supported.

List returns `{ "data": [...], "pagination": { "limit": 25, "offset": 0, "hasMore": false } }`. It fetches one extra row and does not calculate total counts. GET by ID, PATCH, and DELETE validate the UUID and target exactly that key. DELETE uses RETURNING id internally and returns no body. Updates use last-write-wins behavior; bulk operations, upserts, optimistic row versions, and idempotency keys are deferred.

### Runtime safety and lifecycle

Only `appliedDefinition.definition` supplies runtime columns; draft `schema_fields` are never queried for runtime allowlisting. Unapplied edits have no effect. Newly applied nullable fields automatically become readable/writable through already enabled operations. Applying such additions therefore also publishes those fields. Every SELECT/RETURNING explicitly names applied fields plus id, and response serialization applies the same allowlist. No wildcard projections are used. All values are bound parameters; identifiers come from metadata and are quoted separately. Queries use ONLY to avoid including inherited child tables.

Before CRUD, the executor inspects the existing catalog snapshot on the same connection and transaction, holding an ACCESS SHARE table lock. Detected changes to columns, defaults, constraints, indexes, triggers, or recorded table flags return sanitized `503`; no external columns are exposed or imported. This conservative check performs catalog queries per request; caching and automatic reconciliation are deferred. Projects with applying/outcome_unknown migrations are blocked. A race with schema application may conservatively fail a request, which can be retried for reads once application finishes.

Customer execution uses a short-lived client closed in finally, five-second connection timeout, two-second statement timeout, three-second client query timeout, and one-second lock timeout. At most ten customer requests execute concurrently per app executor; capacity exhaustion returns `503`. The platform's existing metadata pool remains in use; there is no customer runtime pool or distributed rate limiter. A lost commit response returns a sanitized uncertain-outcome error; writes are never automatically retried.

Runtime errors include `{ code, message, requestId }`: `400` invalid input, `401` invalid credentials, `403` insufficient scope, `404` unavailable resource/row, `409` unique conflict, `413` excessive body size, `503` customer/schema/capacity unavailable, `504` timeout, and `500` unexpected internal failure. SQL, SQLSTATE, constraint names, driver errors, connection settings, and credentials are excluded. Runtime responses use Cache-Control: no-store.

### Browser CORS and logs

Set `RUNTIME_ALLOWED_ORIGINS` to comma-separated exact HTTP(S) origins, such as `http://localhost:5173,https://app.example`. The default is empty. Wildcards, URL paths, credentials, and trailing slashes are rejected. CORS is scoped to `/api`; allowed methods are GET, POST, PATCH, DELETE, OPTIONS and allowed headers are Authorization and Content-Type. Preflight requires no key; actual requests still authenticate. Cookie credentials and project-managed origin settings are unsupported. CORS does not prevent non-browser clients from using a valid key.

Runtime logs contain request ID, route template, method, status, duration, resolved project/endpoint/key record IDs, operation, row count, and sanitized error category. They exclude authorization headers, secrets, bodies, returned rows, raw URLs/query strings, SQL values, and database errors. Customer data is not persisted in a platform log table. Distributed rate limiting, customer pooling, field permissions, workflows, relationships, and custom execution remain deferred; end-user sessions and owner policies are described below.

## End-user Authentication and Ownership Authorization MVP

Apply `0004_end_user_auth.sql` with `npm run db:migrate`. The platform stores `project_auth_configs` and per-operation endpoint policies. Application users, password hashes, roles, and sessions remain in the project's customer PostgreSQL database. Platform users and application users are separate identities.

### Enable and provision

These routes require the management bearer credential and project ownership:

| Method | Route                                                   | Behavior                                   |
| ------ | ------------------------------------------------------- | ------------------------------------------ |
| GET    | `/internal/projects/:projectId/auth`                    | Safe configuration and provisioning status |
| PUT    | `/internal/projects/:projectId/auth`                    | Configure auth with optimistic revision    |
| POST   | `/internal/projects/:projectId/auth/provision`          | Provision fixed internal tables            |
| PATCH  | `/internal/projects/:projectId/auth/users/:userId/role` | Set exactly `user` or `admin`              |

Create configuration with `{ "enabled": true, "signupEnabled": true, "expectedRevision": 0 }`. Optional `sessionLifetimeSeconds` defaults to 86400 and is bounded to 300–604800 seconds. Updates require the current `expectedRevision`; omitted lifetime resets to the default. Configure and provision need an existing saved connection. Auth requests become available only when enabled and provisioning is ready.

Call provisioning with `{ "expectedRevision": 1 }`, using the actual current revision. Status moves from `unprovisioned` or `failed` to `provisioning`, then `ready` or `failed`. Each transition increments the revision. Fixed DDL creates two reserved, project-specific tables in the configured customer schema: `platform_auth_users_<project_uuid_without_hyphens>` and `platform_auth_sessions_<project_uuid_without_hyphens>`. Customers cannot supply table names or SQL. Provisioning is transactional and never uses IF NOT EXISTS or adopts conflicting objects. User email and session token hash UNIQUE constraints provide lookup indexes; sessions additionally index user_id and reference auth users with a foreign key.

The `auth` runtime resource is reserved when enabling auth. A conflicting existing table API causes `409`; it is not overwritten. Internal auth tables never appear in Schema Builder or generic endpoint configuration and are rejected by generic runtime routing. Auth configuration also prevents connection replacement/deletion, even when no normal managed tables exist.

Provisioning spans two databases. A lost customer commit response records `outcome_unknown`; a process crash or failed platform finalization can leave `provisioning`. Both states block configuration changes and reprovisioning. Auth requests require ready status. A trusted operator must establish the original transaction's outcome and repair metadata explicitly; there is no automatic retry, adoption, or reconciliation endpoint. Disabling auth does not delete customer users or sessions.

### Signup, login, logout, current user

| Method | Runtime route                   | Contract                                                                                                   |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| POST   | `/api/:projectSlug/auth/signup` | `{ "email": "alice@example.test", "password": "a long private passphrase" }`; returns safe user with `201` |
| POST   | `/api/:projectSlug/auth/login`  | Same body; returns `{ token, expiresIn, user }`                                                            |
| POST   | `/api/:projectSlug/auth/logout` | Revoke bearer session; `204`; repeated logout is safe                                                      |
| GET    | `/api/:projectSlug/auth/me`     | Return `{ id, email, role }` for bearer session                                                            |

Signup/login require neither a project API key nor a management token. Signup must be enabled separately. Email normalization trims surrounding whitespace and lowercases; it does not apply provider-specific transformations. Normalized email is unique in customer PostgreSQL. Signup accepts only email/password and always creates an active `user`; there is no first-user admin shortcut. Duplicate or failed account creation returns a generic response. Email is unverified, and successful signup necessarily exposes some account-existence information.

Passwords are never trimmed, lowercased, logged, or stored in plaintext. Signup accepts 15–128 Unicode code points, at most 512 UTF-8 bytes. Login accepts bounded nonempty passwords so incorrect short passwords still receive generic invalid-credentials responses. Argon2id uses the `argon2` package, explicitly configured with memoryCost 19456 KiB, timeCost 2, parallelism 1, and a 32-byte hash. The library supplies fresh random salts. Hash verification accepts only the approved PHC parameter set, preventing a corrupted stored hash from requesting unbounded work. Unknown users receive dummy hash verification. Hashing happens outside customer transactions and is limited to two active jobs per app; excess work returns sanitized `503`.

Successful login generates a fresh `us_` token containing 256 random bits and returns it once. Only SHA-256(token) is persisted in customer sessions. Sessions expire at a fixed time with no sliding extension, refresh, or automatic renewal. A new login creates a separate session; logout revokes only the presented one. Current role, active account status, session expiry, and revocation are read from customer PostgreSQL, never token claims. Protected CRUD rechecks and locks the session/user records inside its transaction before executing SQL. A concurrently changed role can conservatively reject an in-flight request; the next request reloads the new role.

For protected routes, send `Authorization: Bearer <us_token>`. Browser SPAs should retain the token in memory; reload requires login again. Native clients should use OS secure storage. Persistent browser login through platform cookies is not implemented. Use HTTPS outside local development. All auth responses inherit Cache-Control: no-store; passwords, hashes, and tokens are excluded from logs. `/auth/me` intentionally returns the signed-in user's email, while generic auth logs omit email addresses.

### Endpoint policies and ownership

Endpoint configuration PUT accepts optional `policies`, keyed by operation (`list`, `get`, `create`, `update`, `delete`). Existing configurations default to key_only. Omitting policies on an update preserves the current policies; explicitly supplying an object replaces that policy map, and omitted operations in it default to key_only. Review policy changes as access-control changes.

```json
{
  "enabledOperations": ["list", "get", "create", "update", "delete"],
  "expectedAppliedRevision": 1,
  "expectedConfigRevision": 1,
  "policies": {
    "list": {
      "mode": "owner",
      "ownerFieldId": "APPLIED_UUID_FIELD_ID",
      "allowAdmin": false
    },
    "get": {
      "mode": "owner",
      "ownerFieldId": "APPLIED_UUID_FIELD_ID",
      "allowAdmin": false
    },
    "create": {
      "mode": "owner",
      "ownerFieldId": "APPLIED_UUID_FIELD_ID",
      "allowAdmin": false
    },
    "update": {
      "mode": "owner",
      "ownerFieldId": "APPLIED_UUID_FIELD_ID",
      "allowAdmin": false
    },
    "delete": {
      "mode": "owner",
      "ownerFieldId": "APPLIED_UUID_FIELD_ID",
      "allowAdmin": false
    }
  }
}
```

Modes:

- `key_only`: existing project API-key scopes and behavior.
- `authenticated`: any active application user with a valid session.
- `owner`: an authenticated user restricted by a configured applied UUID field.

Protected policy configuration requires enabled, successfully provisioned auth. Ownership uses the stable field ID from the applied definition; draft-only fields, arbitrary column names, non-UUID fields, and the implicit primary key are rejected. Policies never contain expressions or SQL. Client filters add AND predicates and cannot replace ownership. List ownership is applied before sorting/pagination. GET/PATCH/DELETE match both UUID id and owner inside the same SQL statement; absent and foreign-owned rows return identical `404` messages.

Owner POST rejects caller-supplied ownership and injects the authenticated user's UUID. Owner PATCH rejects ownership submission and updates fields only where both row id and owner match. Any column referenced by an owner policy is immutable through generic PATCH, even if another operation uses authenticated/key_only mode. NULL-owned legacy rows are inaccessible under owner restrictions; no existing rows are reassigned automatically.

Roles are exactly user/admin and live in customer auth records. The management role route accepts `{ "role": "admin" }` or `{ "role": "user" }`; only the trusted project owner can invoke it. Application sessions cannot access management APIs. With allowAdmin=false, admins remain owner-restricted. With allowAdmin=true, admins may access other users' rows for that operation, but disabled operations still reject access, creates still belong to the admin, and ownership cannot be transferred through generic CRUD. Role changes apply to existing sessions on subsequent validation.

Project keys never satisfy authenticated/owner policies, and user sessions never satisfy key_only policies. A read_write project key confers no application-admin authority. Protected frontend calls require only the user session, not both credentials. Existing key_only table APIs continue to work without user login. Schema drafts do not change runtime policies or allowlists; customer schema drift still blocks execution.

### Attempts, deployment limits, and deferred work

Signup and login each have independent in-memory one-minute windows: 20 attempts per project/IP and 10 per project/normalized identifier. Limits run before hashing, expire without permanent lockouts, and return `429` with Retry-After. Identifier counters use a process-secret HMAC, not raw email keys. Counter storage is capped at 10,000 entries; capacity fails closed until entries expire. Forwarded IP headers are ignored because Fastify trustProxy remains disabled. Deployment behind a proxy needs explicit trusted-proxy configuration before relying on client IP limits. Multi-instance deployments need shared or edge rate limiting; in-memory counters are process-local and reset on restart.

Auth database work uses short-lived clients with timeouts and a separate ten-request capacity cap. No customer runtime pools are introduced. Auth tables use catalog snapshots and fixed SQL; unexpected structural changes fail closed. Login failures for wrong password, unknown email, and disabled users share one generic response. Expected failures use sanitized categories, and runtime errors include request IDs. No bodies, passwords, hashes, bearer secrets, raw email addresses, SQL values, or PostgreSQL errors are logged.

JWT, refresh tokens, cookies, OAuth, password reset, email verification, custom user-table mapping, custom roles/policies, PostgreSQL RLS, field permissions, teams, persistent browser sessions, and automatic account recovery are deferred. There is no self-service account recovery or verified-email guarantee in this MVP.

## Custom Workflow Endpoint MVP

Apply migration `0005_custom_workflows.sql`. Platform metadata now includes `workflow_endpoints` (identity, editable draft, enable state, published-version pointer) and `workflow_versions` (append-only published snapshots and applied-schema dependencies). There are no separate step/connection tables, background workers, customer workflow-history tables, or new dependencies.

Workflow endpoints are POST-only, at `/api/:projectSlug/:workflowPath`. Paths are immutable single lowercase URL slugs up to 63 characters, using single internal hyphens. `auth`, reserved prefixes, underscores, slashes, route parameters, wildcards, and encoded separators are rejected. Workflows and predefined resources share a project-scoped transaction advisory lock when reserving names. Conflicts are rejected across all methods; disabling a workflow keeps its reservation. Metadata dispatch uses the existing fixed POST resource route; no customer routes are dynamically registered.

### Management lifecycle

All routes below require management authentication and project ownership:

| Method | Route                                                 | Contract                                                                                         |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| POST   | `/internal/projects/:projectId/workflows`             | `{ path, definition }`; creates disabled draft, `201`                                            |
| GET    | `/internal/projects/:projectId/workflows`             | List configurations                                                                              |
| GET    | `/internal/projects/:projectId/workflows/:workflowId` | Read configuration/draft                                                                         |
| PUT    | `.../:workflowId/draft`                               | `{ expectedDraftRevision, definition }`; replace draft and increment revision                    |
| POST   | `.../:workflowId/preview`                             | No body; static validation, dependency/hash/access summaries                                     |
| POST   | `.../:workflowId/publish`                             | `{ expectedDraftRevision, definitionHash }`; revalidate and atomically publish immutable version |
| PATCH  | `.../:workflowId`                                     | `{ expectedDraftRevision, enabled }`; change enabled state only                                  |

Runtime uses only an enabled endpoint's published snapshot. Unpublished/disabled paths return `404`. Editing a draft does not alter a published API. Preview never opens a customer connection, runs a workflow, acquires customer locks, or executes writes. It returns a deterministic definition hash, draft revision, required key scope, configured step counts, applied schema dependencies, and DB operation/access summaries with parameterized SQL templates. Values are omitted from those templates; owner templates show the owner-restricted case, with configured admin bypass handled at execution. Publish rechecks metadata and the hash server-side. Newly applied schema revisions require preview and republish, including nullable additions; workflows never automatically expose new fields.

### Definition and values

The document contains `input`, `auth`, and `steps`:

```json
{
  "input": {
    "product_id": { "type": "uuid", "required": true },
    "quantity": { "type": "integer", "required": true, "min": 1 }
  },
  "auth": "authenticated",
  "steps": []
}
```

Every reachable path must end in a Response, so this skeleton must be completed before saving. Inputs are flat body properties only: uuid/string/integer/boolean, required/optional, explicitly nullable, integer min/max, and string minLength/maxLength. Integer values fit signed 32-bit; strings default to a 10,000-character maximum. Unknown body fields, query parameters, regexes, nested schemas, unions, and arbitrary schemas are rejected. Runtime context contains validated request body, empty query/params, safe auth user id/role, and available step outputs. It contains no headers, bearer tokens, credentials, clients, repositories, or password/session hashes.

Every step has a stable UUID `id`, unique lowercase editor-facing `name`, and `type`. References use IDs, not names. Values are tagged JSON:

```json
{ "kind": "literal", "value": 1 }
{ "kind": "reference", "source": "request", "path": ["body", "quantity"] }
{ "kind": "reference", "source": "auth", "path": ["user", "id"] }
{ "kind": "reference", "source": "step", "stepId": "QUERY_STEP_UUID", "path": ["row", "FIELD_UUID"] }
{ "kind": "object", "fields": { "quantity": { "kind": "reference", "source": "request", "path": ["body", "quantity"] } } }
{ "kind": "array", "items": [{ "kind": "literal", "value": true }] }
```

These are separate example value objects, not a single JSON request. Template-looking strings remain literal strings. No expressions or functions are evaluated. References traverse own properties only, exclude prototype-related keys, and can use only declared request fields, safe auth fields, and earlier selected step outputs. Missing values fail rather than silently becoming null. Branch-local outputs never merge into the parent scope.

### Blocks

Database blocks specify a managed applied `tableId` and explicit `access` policy. Select lists contain stable applied field UUIDs plus the special `"id"` selector for the implicit primary key. Output row keys are those selected IDs; map them to frontend-facing names in Response. Only selected fields are returned, without wildcard projections.

- **query:** `tableId`, `access`, `select`, `idValue`, optional `forUpdate`, `onMissing: "null" | "404"`. UUID lookup only; output `{ row: object | null }`. A locked query uses FOR UPDATE on the workflow transaction's client.
- **insert:** `tableId`, `access`, `values` mapping field UUIDs to structured values, and `select`. One row only; output `{ row }`. Resolved values use applied scalar validation; omitted fields retain database defaults.
- **update:** `tableId`, `access`, `idValue`, `assignments`, `select`, `onNoMatch: 404 | 409 | 422`. Each assignment has `operation`, `fieldId`, and `value`. `set` performs a typed assignment. `decrement` requires an integer column, positive integer amount, and `guard: "gte_value"`; SQL atomically checks column >= amount while subtracting it. No bulk updates or general arithmetic.
- **delete:** `tableId`, `access`, `idValue`. Deletes at most one UUID-selected row; output `{ id }`.
- **condition:** `operator`, `left`, optional `right`, `then`, `else`. Operators are equals/not_equals, greater_than/greater_or_equal, less_than/less_or_equal, is_null/is_not_null. Null tests have one operand; other comparisons reject null or unlike types. Ordering is restricted to safe integers; bigint/decimal strings are never converted to Number. Branches execute sequentially and can terminate or continue into the following parent steps. Unreachable steps are rejected.
- **response:** `status` and structured `body`. Allowed statuses are 200/201/204/400/403/404/409/422. A 204 must omit body; other statuses require it. No custom headers, redirects, cookies, or access to internal exceptions.

### Access and atomic execution

Endpoint auth is key_only or authenticated. Key-only workflows require a project key; any configured reachable write, including a conditional branch, requires read_write scope. Authenticated workflows require a user session and cannot use project keys. Session, active status, and current role are rechecked and locked inside the customer transaction.

Each DB block explicitly grants key_only/authenticated/owner access consistent with the endpoint auth mode, reusing the existing owner UUID field policy and allowAdmin behavior. Owner queries and mutations include ownership predicates. Owner insert injects auth.user.id and rejects mappings for its ownership field. Owner updates cannot transfer ownership. Admin bypass remains explicit and inserts still belong to the current user. Internal auth tables and cross-project/cross-connection targets are rejected. Generic CRUD does not have to be enabled: a published workflow is a separately reviewed, bounded capability. For stock control, keep generic product updates disabled while granting only the workflow's guarded decrement.

CRUD and workflows share a customer transaction runner and ten-request capacity budget per app. One workflow uses one client and one transaction. It verifies all dependency revisions and customer catalog snapshots before running steps. Success responses are constructed and bounded before COMMIT and sent only after COMMIT succeeds. Business-error Response blocks roll back earlier writes before returning the configured body. SQL failures, missing required rows, bad references/types, or missing responses also roll back. Unique conflicts return sanitized 409; missing/inaccessible rows return 404; invalid input 400; runtime definition/value errors 500; stale dependencies/drift 503; timeouts 504. Runtime errors include request IDs and omit SQL, driver details, credentials, and stack traces. Ambiguous commit returns an uncertain-outcome failure and is never automatically retried.

A safe place-order workflow queries a product with FOR UPDATE, handles a null product with 404, checks integer stock >= quantity, inserts an owner-injected order, performs a guarded decrement, and returns a mapped order with 201. Locking and the guarded SQL update protect competing purchases; a transaction alone would not protect an ordinary read/check/write sequence. Integration tests send two concurrent orders against stock insufficient for both and require one commit, nonnegative stock, and no orphan order.

### Bounds and logging

Limits: 30 total configured steps across branches, 3 condition levels, 10 DB blocks, 5 tables, a 64 KiB definition, 32 KiB individual literals, 256 KiB response, and 512 KiB intermediate context. Body size retains the app's 64 KiB limit. There are no loops, parallel steps, jumps, or general graphs, so execution count is statically bounded.

The runner starts a ten-second deadline after capacity admission, bounds connection establishment to five seconds, uses a one-second lock timeout, and adjusts each statement timeout to min(two seconds, remaining deadline). Expiry closes an active pg client, and statement timeouts terminate database work; this is not a Promise.race that leaves work running. Clients close in finally and capacity is released on every outcome. No customer pool or background execution is added.

Logs contain route/request/principal IDs, safe workflow/version IDs, configured step count, executed DB count, terminal response ID, response status, duration, commit/rollback outcome, and sanitized error categories. They exclude request values, step outputs, response bodies, SQL parameters, tokens, credentials, and PostgreSQL errors. No persistent workflow history is stored.

Set Variable, find_many, additional HTTP methods, route parameters, arbitrary SQL/code, functions, external calls, secrets, loops, parallelism, custom headers, manual transactions, cross-database operations, background jobs, and idempotency keys are deferred.

## Dashboard MVP

The authenticated Next.js dashboard lives in `frontend/`. See [frontend setup and complete demo](frontend/README.md) for signup/login, environment configuration, running both applications, and disposable Playwright testing. Fastify validates platform sessions and enforces project ownership.

`GET /internal/projects?limit=20&offset=0` lists only the authenticated platform user's projects. `limit` is 1–100, `offset` is 0–999999, and unknown query parameters are rejected. The response is `{ items, nextOffset }`; `nextOffset` is null at the end. Results are ordered by creation timestamp and ID. Offset pagination can shift if records are concurrently changed. Existing create/get responses are unchanged.

Management and runtime responses now include `X-Request-Id`, including errors. Error response bodies retain their existing contracts.

The existing owned workflow GET response also includes `publishedDefinition` (or null), allowing the dashboard to distinguish unpublished draft changes after reload. This is a read-only publication snapshot; workflow execution and publication behavior are unchanged.

## Developer usability and reliability

Management schema responses now exclude internal catalog snapshots and include safe latest-apply status. Owned connection GET includes safe identity plus replacement blockers. Workflow responses include dependency readiness; previews omit internal SQL templates. Existing error envelopes and runtime authorization/transaction semantics are unchanged. The dashboard preserves intentional runtime JSON responses (including rejection bodies), uses targeted failure/success status refresh, protects dirty forms, and suppresses late responses after clearing credentials. Public transport vocabulary lives in `shared/`; it contains no persistence models. See [external testing and performance limitations](frontend/README.md#external-tester-boundary-and-reliability).

## Private-alpha deployment

See [the one-server deployment runbook](deploy/README.md) for Docker Compose, HTTPS, approved customer destinations, backup/restore, smoke checks, release and rollback. Local development remains separate.

### Generated API Docs

Open **Docs** inside a project to inspect deployed runtime CRUD, application authentication,
and published enabled workflows, download OpenAPI 3.1 JSON, or select an operation in
Playground without executing it. Set backend and frontend `PUBLIC_RUNTIME_ORIGIN` to
the same public runtime origin (local example: `http://127.0.0.1:3000`). Docs are owner-only
and use applied/published metadata; drafts are excluded. No database migration is needed.
A 503 `API_DOCS_UNAVAILABLE` means deployment metadata needs review, or an enabled
workflow needs republishing after a schema change. Generation does not inspect customer DBs.

## Private Alpha Reliability & Recovery

See [the operator recovery runbook](deploy/RECOVERY.md) for same-target credential updates, dry-run setup reconciliation, project suspension, contained restore, encryption-key maintenance, limits and maintenance-gated upgrades. These controls do not delete customer tables or automatically retry writes.

The [hardening validation record and release checklist](deploy/ALPHA-VALIDATION.md) describe disposable upgrade, restore, interruption and deployment-gate evidence and the remaining alpha limits.
