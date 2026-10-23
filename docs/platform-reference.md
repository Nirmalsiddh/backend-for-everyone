# Platform reference

This document describes the broader backend platform. The [Taskforge walkthrough](../TASKFORGE.md) deliberately uses only a fixed Tasks template and key-only CRUD. For identity boundaries and failure semantics see [architecture](architecture.md); for operator commands see [recovery](../deploy/RECOVERY.md).

- [Projects and connections](#project-and-connection-management)
- [Schema management](#schema-management), [evolution](#schema-evolution) and [indexes](#managed-indexes)
- [Table APIs](#table-apis-and-runtime), [querying](#advanced-querying) and [relationships](#relationship-aware-reads)
- [Application auth](#application-authentication-and-ownership) and [workflows](#transactional-workflows)
- [TypeScript client](#generated-typescript-client) and [observability](#runtime-observability)

## Project and connection management

Management requests require a valid platform bearer session and owner-scoped persistence queries. `GET /internal/projects?limit=20&offset=0` returns `{ items, nextOffset }` ordered by creation time and ID. Limit is 1–100, offset 0–999999; unknown query parameters are rejected. Offset pages may shift under concurrent changes.

The connection base path is `/internal/projects/:projectId/database-connection`:

| Method / suffix | Behavior |
| --- | --- |
| POST | Test candidate and create, 201 |
| GET | Safe metadata, identity, revision and replacement blockers |
| POST `/test` | Retest saved settings; no request body |
| PUT | Test and fully replace when no dependent configuration blocks it |
| PUT `/credentials` | Revision-bound same-target username/password/TLS update |
| DELETE | Remove saved configuration only, 204; dependent resources block deletion |

Creation/full replacement requires all of `label`, `host`, `port`, `database`, `username`, `password`, `schema`, `ssl`. For example:

```json
{
  "label": "Demo database",
  "host": "db.example.com",
  "port": 5432,
  "database": "demo",
  "username": "demo_service",
  "password": "<DATABASE_PASSWORD>",
  "schema": "public",
  "ssl": true
}
```

The credentials route accepts `expectedRevision`, `username`, `password` and `ssl`; it cannot move the target. The password is required again, never a masked/omitted placeholder. A failed candidate changes nothing in saved settings. Duplicate creation returns 409; missing/foreign projects return 404. Safe metadata includes IDs, label, latest test status/timestamp and creation/update times; owner GET can include non-secret identity and replacement blockers, never passwords or encryption metadata.

Diagnostics open a fresh bounded client, run `SELECT 1` and a parameterized schema-existence check, then close in `finally`. They never create schemas or modify customer rows. Failures are sanitized `AUTHENTICATION_FAILED`, `CONNECTION_FAILED`, `SCHEMA_UNAVAILABLE` (422), or `CONNECTION_TIMEOUT` (504); hosted policy failures have separate sanitized destination/TLS categories. Retest records its latest completed success/failure, not continuous health.

`ssl=true` verifies certificates using system trust roots. Disable it only for trusted local development; hosted mode requires approved destinations and verified TLS. Socket paths, connection URLs and arbitrary driver options are not accepted as connection-form input. Multiple customer connections, customer schema provisioning and arbitrary target rebinding remain unsupported. See [deployment policy](../deploy/README.md#customer-postgresql-policy) and [credential recovery](../deploy/RECOVERY.md#same-target-credentials).

## Schema management

Platform migrations prepare schema metadata; customer DDL runs only through explicit Apply.

All schema routes require management authentication and project ownership. Foreign-owned resources return `404`:

| Method | Route                                                          | Behavior                                                             |
| ------ | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| GET    | `/internal/projects/:projectId/schema`                         | List managed table drafts and applied metadata                       |
| GET | `/internal/projects/:projectId/schema/reference-targets` | Check eligible applied reference targets read-only |
| POST   | `/internal/projects/:projectId/schema/tables`                  | Create a draft; `201`                                                |
| GET    | `/internal/projects/:projectId/schema/tables/:tableId`         | Retrieve a definition                                                |
| PUT    | `/internal/projects/:projectId/schema/tables/:tableId/draft`   | Replace the draft at an expected revision                            |
| DELETE | `/internal/projects/:projectId/schema/tables/:tableId`         | Delete a never-applied definition; `204`                             |
| POST   | `/internal/projects/:projectId/schema/tables/:tableId/preview` | Compile changes; references also check target catalogs read-only |
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

Preview accepts no body and returns a revision-bound plan/hash. Legacy previews include generated SQL; newer field-evolution previews use structured effects without values or SQL. It validates the supported changes and compiles the stored definition; it does not verify current customer permissions or object conflicts. Apply uses the saved draft revision and preview hash:

```json
{
  "expectedDraftRevision": 1,
  "planHash": "the-64-character-hash-returned-by-preview"
}
```

Apply regenerates SQL on the server. A stale revision/hash returns `409`. Success returns `{ migrationId, status: "applied", table }`. Applying an already applied plan with no further supported changes returns `409`; it does not rerun DDL. No endpoint accepts SQL. Literal defaults are visible in authorized definitions and legacy SQL previews; structured v4 previews omit them. Do not use defaults to store secrets. Routine logs exclude bodies, SQL, driver errors, and credentials.

### Types and validation

Supported types are `text`, `varchar`, `integer`, `bigint`, `decimal`, `boolean`, `uuid`, `date`, `timestamp`, and `jsonb`. `timestamp` always means PostgreSQL timestamp with timezone. Varchar requires `options.length` from 1 to 10,000. Decimal requires precision 1–38 and scale 0–precision. Other types reject type options. Bigint and decimal literal defaults are strings to preserve precision. Integer defaults must fit signed 32-bit values; bigint defaults must fit signed 64-bit values. Date literals use real `YYYY-MM-DD` dates; timestamp literals require an ISO date/time with timezone. JSONB literal defaults are limited to 8 KiB and nesting depth 20. Text defaults are limited to 10,000 characters. Existing rows do not receive automatic updated-at behavior.

Defaults are `{ "kind": "literal", "value": ... }` or, for timestamps only, `{ "kind": "current_timestamp" }`. Functions and SQL expressions are rejected. SQL-like text remains an escaped literal string. Single-column uniqueness is supported on scalar fields; nullable unique fields allow multiple nulls. JSONB uniqueness is deferred.

Table/column names must start with a lowercase ASCII letter and consist of lowercase letters, digits, and single internal underscores, up to 63 characters. Reserved SQL names, PostgreSQL system column names, and `pg_`, `sql_`, `platform_`, `internal_`, and `schema_` prefixes are rejected. The name `id` is reserved for the primary key. Names cannot contain dots, quotes, whitespace, or SQL comments. The configured existing customer schema is quoted separately, and PostgreSQL system schemas are rejected. Tables support at most 100 custom fields; the existing 64 KiB HTTP body limit also applies.

### Allowed changes and connection lifecycle

Before first apply, drafts can be renamed, fields can be added/removed, and types/constraints/defaults can be edited. After Apply, identities/order/types remain fixed. Supported changes include nullable/reference additions, managed index additions and the bounded requiredness/default/fill operations below. Foreign-key removal/retargeting, renames, drops, type changes, imports, arbitrary SQL/index definitions, triggers and functions remain unsupported.

Deleting a never-applied definition removes platform metadata only. It never drops an existing customer object with the same name. Connection replacement/deletion returns `409 CONNECTION_IN_USE` while any schema definition depends on it. Unapplied drafts may be removed first; rebinding applied schemas to another connection is deferred. Retesting a saved connection remains supported.

## Schema evolution

Applied tables can evolve one field per Apply: add a nullable field with a supported literal default; add/change/remove a supported future default; make a nullable field required with an optional NULL-only fill; or add a required field with a declared fill, supported future default, or both. Ordinary nullable/reference additions, indexes and no-fill requiredness retain their existing paths. A field bundle cannot share Apply with a user index addition.

| Type | New managed default evolution | Requiredness fill |
| --- | --- | --- |
| text, varchar | Yes | Yes |
| integer | Yes, int32 | Yes, int32 |
| bigint | Yes, exact int64 string | Yes, exact int64 string |
| decimal | Yes, exact precision/scale string | Yes, exact precision/scale string |
| boolean | Yes, actual boolean | Yes, actual boolean |
| date | Deferred for defaults | Yes, validated calendar string |
| timestamp | Deferred for defaults | Yes, timezone-qualified string, up to six fractional digits |
| ordinary UUID / managed UUID reference | No | Yes; real FK remains enforced |
| JSONB | No | No |

Date/timestamp default evolution is unsupported because environment-independent canonicalization is not established for it. Legacy defaults, including structured current-timestamp and JSONB defaults, retain their historical verification. A legacy default may remain unchanged. Removing a legacy date/timestamp default is safe because the new managed state is absence; UUID/reference/JSONB default evolution remains excluded. New default expressions/functions, generated UUID defaults and explicit SQL DEFAULT NULL are unsupported. Absence of a default means no managed default.

A future default applies when an INSERT omits the field. Changing it never replaces existing non-NULL values. A one-time fill replaces SQL NULL only and is allowed only with final requiredness. JSON null is separate; historical JSONB behavior is unchanged. Required additions always need a declared strategy, including on empty tables. If both values are configured, historical rows receive the fill and future omitted inserts receive the default. Fill-only required fields must be supplied by future creates.

Fill intent is draft metadata in nullable `schema_fields.backfill_intent`, stored through platform migration `0010_safe_schema_evolution.sql`. Existing rows start without intent. Intent is validated, survives reload, is bound into the immutable plan, and is consumed atomically on successful publication or POST reconciliation without increasing the draft revision. Failure retains it. Fill intent never enters the applied field definition, runtime, Docs, OpenAPI, SDK or public contract hash.

**Fill/default values are plaintext platform metadata, consistent with existing defaults. They are not encrypted.** Do not store secrets there. Executor errors and structured v4 previews omit values and SQL. No customer-data COUNT is performed for confirmation.

Field bundles use plan v4 and deliberate catalog v4 transitions. Historical v1/v2/v3 hashes, statement generation, receipts and catalogs are frozen; reconciliation explicitly dispatches to the historical planner. Only deliberately evolved default fields adopt structured constant descriptors; other historical default representations remain unchanged. The bounded verifier decodes allowlisted constant/cast shapes without executing expressions and rejects functions, SQL expressions and unsupported shapes as drift. Bigint/decimal normalization retains exact strings. Text/varchar literals also undergo a parameterized trusted-type round trip before effects, rejecting truncation or incompatible encoding instead of silently changing the value.

Apply uses existing platform/project serialization, schema admission, advisory locks and sorted ACCESS EXCLUSIVE table/dependency locks. Inside one customer transaction it verifies exact PRE, adds a new column temporarily nullable without a future default when required, installs any new FK, fills using a parameterized UPDATE ONLY … WHERE … IS NULL, checks for remaining NULL, installs/removes the future default, sets NOT NULL, verifies POST, writes an authenticated receipt and commits. Nullable additions can use ADD COLUMN DEFAULT directly. Correctness does not depend on PostgreSQL fast defaults. Uniqueness, FKs and external restrictions remain enforced; failures roll back the transaction. Tables with external row triggers are rejected for fills, and unexpected trigger changes fail POST verification.

These operations can block reads/writes and interrupt application traffic. They are not online or zero-downtime migrations. Statement, lock and absolute deadline limits apply. Large tables may time out and roll back; no chunking, jobs, queue or partial-fill resume exists. Fills require the customer role's update capability in addition to schema capabilities. Management errors are sanitized, including uniqueness, relationship, permission and timeout errors.

Customer commit precedes platform publication. An unknown outcome blocks retry. Reconciliation accepts POST only with the operation-bound authenticated receipt, exact catalog and dependency state; it publishes metadata without replaying fills. Exact PRE becomes a failed/not-applied outcome requiring reviewed retry. Other states, including committed intermediate-looking structures, are DIVERGED. A later non-NULL customer edit is preserved during POST reconciliation.

Field additions, requiredness and every default change advance both logical and physical revisions. Dependent workflows become stale after publication; unrelated workflows remain valid. Normal non-unique indexes remain physical-only. Drafts and failed Apply do not publish a new contract. OpenAPI/create validation uses applied nullable/default semantics. SDK literal default values remain excluded from the public contract hash: a value-only default change may retain that hash while table-revision provenance/source changes. Historical fill values are never generated into clients.

Deferred: standalone/data-only backfills, nullable-to-nullable fills, WHERE clauses, non-NULL overwrite, arbitrary SQL/code, JSONB evolution, type changes, renames, drops, transformations and online migration machinery.

## Managed indexes

The Schema Builder supports explicit normal/unique B-tree indexes on one to four
ordered fields, at most eight user indexes per table. Eligible types are UUID,
integer, bigint, boolean, decimal and timestamp. These have bounded representations
under the existing field model. Text, varchar, JSONB and date indexing are deferred;
No index method, SQL name, expression,
predicate, collation, operator class or custom ordering is accepted from clients.

Save fields before selecting them for an index. Initial table creation can include
multiple indexes. For an applied table, add one index or make one existing nullable
field required per Apply. Existing nullable column/reference additions remain
supported. Do not mix these with a new index or requiredness change. Existing
initial-create defaults and unique-field constraints are unchanged; post-Apply
default/fill capabilities are described under [schema evolution](#schema-evolution).

Index IDs are server-generated UUIDs. Ordered field IDs and uniqueness are saved
as versioned draft specifications in `schema_indexes`; applied specifications are
captured in the versioned applied definition. Physical names are deterministic
`ix_usr_<UUID hex>` identifiers, never editable configuration. Draft-only indexes
can be changed/removed. Applied indexes cannot be changed, reordered or removed.
Mandatory FK indexes remain separate, automatic, read-only infrastructure. Duplicate
single-column FK indexes and unique indexes involving references are rejected.

### Revisions and compatibility

`draftRevision` is the optimistic draft token. `appliedRevision` remains the logical
API contract revision. `appliedPhysicalRevision` records the draft token whose
physical state was applied. Existing tables initialize physical revision to logical
revision without customer DDL. Initial create initializes both. Normal index Apply
advances only physical revision; unique indexes, requiredness and nullable field/
reference additions advance both. Failed Apply advances neither. Platform constraints require logical/physical nullability to agree and logical ≤ physical ≤ draft revision.

Published workflows retain logical dependencies: normal indexes do not stale them;
unique/requiredness/field changes retain conservative contract-change staleness.
No workflow version is rewritten or automatically republished. Runtime expansion
metadata fencing includes physical revision and complete applied catalog state.
Normal indexes do not change response bodies, OpenAPI, authorization, pagination,
filter/sort syntax or bounded include query counts.

### Data validation, locks and availability

Apply uses the existing advisory lock and deterministically ordered exclusive table
locks. After verifying PRE state, it checks duplicate keys or SQL NULL existence
before index/NOT NULL DDL in the same transaction. Concurrent writes cannot race
those prechecks. Index Apply and no-fill requiredness do not update, merge, remove or backfill rows. Explicit field-fill operations are separate supported plans. Duplicate/NULL
failure returns sanitized `SCHEMA_DATA_INVALID`; database details/values are not
exposed. Runtime unique violations retain `409 VALUE_CONFLICT`.

Unique indexes use PostgreSQL default NULLS DISTINCT semantics. Multiple NULLs are
allowed, and composite keys containing any NULL are excluded from duplicate checks.
Uniqueness is table-wide unless the developer explicitly includes ownership in the
key. Ownership predicates and independent target GET authorization are unchanged.

Requiredness has no draft effect. After Apply, POST requires the field unless an
existing legitimate default/server behavior supplies it. PATCH may omit it but may
not set SQL NULL. Docs update only after successful Apply. Failed Apply retains the
previous runtime contract and workflow validity.

Reads and writes may be temporarily unavailable while Apply runs. Index Apply
uses transactional CREATE INDEX, never CONCURRENTLY. Existing lock, statement,
operation and quota bounds remain. Large operations may time out and roll back.

### Catalogs, recovery and upgrade

Legacy canonicalization, unversioned/v2 planner behavior, FK names/canonicalization,
and legacy catalog readers remain frozen. Index/no-fill requiredness evolution uses plan/catalog version
3; newer field bundles use v4. The new hash binds both prior revisions, exact prior applied definition/catalog,
ordered index specifications, typed actions, connection identity and relationship
dependencies. It excludes credentials. Legacy hashes never gain empty index arrays
or physical-revision fields. Mixed catalog versions are inspected explicitly.
Application-auth internal catalogs/indexes retain their existing representation.

Catalog v3 records ordered index keys, category/name, uniqueness, method, readiness,
validity, liveness, ordering, NULL behavior, operator classes, collations, constraint
association, and absence of predicates/expressions/INCLUDE attributes. Durable
identities do not use OIDs. Unexpected external indexes continue to cause drift.
Index/NOT NULL/FK/trigger drift blocks affected CRUD, workflows and includes.

Receipts remain encrypted and authenticated, bound to project, operation and plan
hash. Exact prior state is PRE_STATE; exact authenticated complete post-state is
POST_STATE; mismatched/partial/unreceipted state is DIVERGED. Reconciliation never
replays DDL. Lost commit acknowledgements or platform finalization failures remain
blocked until operator reconciliation determines the state. No distributed atomicity
between platform and customer databases is claimed.

### Deferred

Applied index deletion/replacement, physical renames, drops, type changes, unique
references, text/varchar/JSONB indexes, other index methods/options, standalone/data-only
backfills, concurrent/background/scheduled migrations, schema rollback,
data transforms, recursive/collection expansion, GraphQL and workflow client generation.

## Table APIs and runtime

Platform endpoint/key metadata is separate from customer rows.

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

Project keys grant shared project-level access. They are not application-user identities and provide no row-level authorization. A key embedded in frontend JavaScript is visible to its users. Use browser read keys only for data acceptable to expose to key holders, and keep private write keys in a trusted backend/BFF. Application sessions and ownership policies are described below; field permissions remain deferred.

### Request and response contract

Bodies use applied schema field names directly. Unknown fields and supplied `id` are rejected. POST requires non-nullable fields without defaults; omitted defaulted columns are left for PostgreSQL, including the generated UUID key. Empty objects are accepted on POST only when all required fields can be omitted. PATCH requires a nonempty object, updates supplied fields only, and never applies creation defaults. Null is permitted only for nullable fields. For JSONB, request null means SQL NULL; a distinct JSON-null sentinel is deferred. Arrays and other JSON values are explicitly serialized as JSONB parameters.

Text/varchar and UUID use strings; integer uses a JSON integer; bigint/decimal use exact decimal strings; boolean uses JSON booleans; date uses real `YYYY-MM-DD` values; timestamp requires timezone-aware ISO input and is returned as a UTC ISO string at JavaScript millisecond precision. JSONB uses JSON values. Varchar, numeric, JSON size/depth, and scalar validation reuse the Schema Builder limits. Runtime bodies retain the 64 KiB HTTP limit. Bigint/decimal/date projections avoid implicit driver number/date conversion.

List accepts `limit`, `offset`, `sort`, `direction`, optional relationship `include`, and the bounded filter grammar documented in [Advanced querying](#advanced-querying). Legacy equality remains supported:

```text
/api/my-shop/products?limit=25&offset=0&sort=price&direction=desc&filter[active]=true
```

Defaults are limit 25, offset 0, and id ascending. Limit is 1–100; offset is 0–10,000. One applied scalar sort field is allowed; JSONB sorting is rejected. Custom sort uses id ascending as a tie-breaker, with nulls last. Numeric fields sort by their PostgreSQL numeric columns, even though responses represent them as strings. Offset pagination can move between requests when rows change.

At most five typed filter clauses combine with AND. Explicit `eq`, `neq`, approved numeric/date/time comparisons, bounded `in` JSON arrays, and nullable-field `is_null` checks are supported according to the applied type matrix. Duplicate query keys/operator pairs, unknown fields/operators, deeper nesting, JSONB filters, and unknown query options are rejected. A text equality value `null` remains literal text; SQL NULL uses `is_null=true|false`. No OR, search, regex, joins, related-field filtering, or JSON paths are supported.

List returns `{ "data": [...], "pagination": { "limit": 25, "offset": 0, "hasMore": false } }`. It fetches one extra row and does not calculate total counts. GET by ID, PATCH, and DELETE validate the UUID and target exactly that key. DELETE uses RETURNING id internally and returns no body. Updates use last-write-wins behavior; bulk operations, upserts, optimistic row versions, and idempotency keys are deferred.

### Runtime safety and lifecycle

Only `appliedDefinition.definition` supplies runtime columns; draft `schema_fields` are never queried for runtime allowlisting. Unapplied edits have no effect. Newly applied nullable fields automatically become readable/writable through already enabled operations. Applying such additions therefore also publishes those fields. Every SELECT/RETURNING explicitly names applied fields plus id, and response serialization applies the same allowlist. No wildcard projections are used. All values are bound parameters; identifiers come from metadata and are quoted separately. Queries use ONLY to avoid including inherited child tables.

Before CRUD, the executor inspects the existing catalog snapshot on the same connection and transaction, holding an ACCESS SHARE table lock. Detected changes to columns, defaults, constraints, indexes, triggers, or recorded table flags return sanitized `503`; no external columns are exposed or imported. This conservative check performs catalog queries per request; caching and automatic reconciliation are deferred. Projects with applying/outcome_unknown migrations are blocked. A race with schema application may conservatively fail a request, which can be retried for reads once application finishes.

Customer execution uses short-lived clients closed in finally, bounded connection/statement/lock timeouts and an absolute operation deadline. Runtime/workflows share at most ten category slots within the shared 16-client admission budget; rate limits are process-local. See [current defaults](../deploy/RECOVERY.md#limits-and-failure-semantics). A lost commit response is uncertain; writes are never automatically retried.

Runtime errors include `{ code, message, requestId }`: `400` invalid input, `401` invalid credentials, `403` insufficient scope, `404` unavailable resource/row, `409` unique conflict, `413` excessive body size, `503` customer/schema/capacity unavailable, `504` timeout, and `500` unexpected internal failure. SQL, SQLSTATE, constraint names, driver errors, connection settings, and credentials are excluded. Runtime responses use Cache-Control: no-store.

### Browser CORS and logs

Set `RUNTIME_ALLOWED_ORIGINS` to comma-separated exact HTTP(S) origins, such as `http://localhost:5173,https://app.example`. The default is empty. Wildcards, URL paths, credentials, and trailing slashes are rejected. CORS is scoped to `/api`; allowed methods are GET, POST, PATCH, DELETE, OPTIONS and request headers include Authorization and Content-Type; diagnostic response headers are exposed for runtime clients. Preflight requires no key; actual requests still authenticate. Cookie credentials and project-managed origin settings are unsupported. CORS does not prevent non-browser clients from using a valid key.

Runtime logs contain request ID, route template, method, status, duration, resolved project/endpoint/key record IDs, operation, row count, and sanitized error category. They exclude authorization headers, secrets, bodies, returned rows, raw URLs/query strings, SQL values, and database errors. Customer data is not persisted in a platform log table. Distributed rate limiting, customer pooling and field permissions remain deferred. Bounded workflows, managed relationships and end-user/owner policies are supported as described below.

## Advanced querying

Generated GET list APIs accept a bounded typed filter language. Capabilities derive
only from applied fields; draft fields, requiredness and indexes have no effect.
Filters are request parameters; they do not require schema Apply or saved query state.

### Public grammar

Decoded examples (encode requests using URLSearchParams):

```text
filter[name]=example
filter[name][eq]=example
filter[name][neq]=example
filter[price][gte]=100
filter[price][lte]=500
filter[category][in]=["pending","processing"]
filter[notes][is_null]=true
```

Legacy equality normalizes to `eq` internally with the same scalar behavior.
Field/operator names are case-sensitive. Only `filter[field]` and
`filter[field][operator]` are accepted; no dotted paths or deeper brackets.
Multiple clauses combine with AND. Different operators on the same field are
allowed; repeated normalized `(field, operator)` pairs, including legacy + explicit
eq, are rejected. Contradictory valid predicates return zero rows.

### Applied operator matrix

| Type | Operators |
| --- | --- |
| Primary key `id` | eq, neq, in |
| UUID and managed reference UUID | eq, neq, in |
| integer, bigint, decimal | eq, neq, gt, gte, lt, lte, in |
| date, timestamp | eq, neq, gt, gte, lt, lte |
| boolean | eq, neq |
| text, varchar | eq, neq, in |
| jsonb | None |

Nullable non-JSONB fields additionally support `is_null`. Required fields and `id`
do not. Owner fields remain filterable and sortable as in previous releases.

### Membership, NULL and scalar values

IN is **one query value containing a JSON array of 1–25 strings**. Each string
uses the field's ordinary scalar validation. Commas inside strings are data.
Numeric JSON primitives, null, objects, nested arrays, malformed JSON and empty
arrays are rejected. Duplicate elements are allowed and count toward 25 before
any deduplication. `[""]` is one valid empty text
value, not an empty list.

```js
const query = new URLSearchParams();
query.set('filter[name][in]', JSON.stringify(['ACME, Inc.', 'A&B', '雪', '']));
query.set('filter[price][gte]', '9007199254740993.00');
const response = await fetch(`${baseUrl}/products?${query}`, {
  headers: { Authorization: 'Bearer <PROJECT_API_KEY>' },
});
```

Encode keys and values once. Literal `+` (including timezone signs) becomes `%2B`;
unescaped `+` decodes as space. Do not manually join unescaped values or split IN
on commas. Docs and Playground share the deterministic query serializer.

`is_null=true` compiles to IS NULL; `false` compiles to IS NOT NULL. Other
comparisons, including neq, exclude NULL through PostgreSQL three-valued logic.
Text `eq=null` is literal text, never SQL NULL. NULL tests on non-nullable fields,
`id`, and JSONB are invalid.

Booleans accept only lowercase `true`/`false`. Integers fit int32. Bigint remains a
string with signed int64 bounds checked using BigInt. Decimal remains a string
validated against applied precision/scale, without Number conversion or rounding.
Date uses real YYYY-MM-DD calendar validation. Timestamp requires the existing
calendar/time syntax with Z or numeric timezone and up to six fractional digits.
Comparison inputs reach PostgreSQL as strings, retaining microseconds; response
serialization remains unchanged. Text/varchar retain existing length/NUL limits.

### Execution, authorization and bounds

- Maximum five user clauses, 25 IN elements per clause, one sort field, two includes.
- Default page 25, maximum 100; offset 0–10000; limit+1 determines hasMore.
- Existing `sort=field&direction=asc|desc`, NULLS LAST, and `id ASC` tie-break remain.
- User predicates AND the independent server owner predicate; they can only narrow
  authorized rows. Explicit existing allowAdmin policy is the only admin bypass.
- Parent filtering precedes sorting and pagination. Only returned parent rows are
  expanded. Target GET authorization remains independent; inaccessible/missing
  targets become null. Raw reference UUIDs and metadata fencing remain unchanged.
- 0/1/2 includes use 1/2/3 application-data queries, regardless of page/filter size;
  auth/catalog/control/platform queries are additional.
- Catalog/relationship/managed-index verification remains mandatory before data
  queries. Damaged expected objects fail closed, even for simple predicates.
- Filters work without an index. No indexes are created automatically and index use
  is never guaranteed. Query cost depends on data, selectivity and the planner.
- Existing admission/rate limits, 10-second customer operation deadline, at most
  2-second statement timeout, 1-second lock timeout, and 1 MiB response cap remain.
- There is no dedicated query-string byte cap; scalar and framework/proxy limits still apply.

Identifiers resolve to applied metadata; enum operators select developer-authored
SQL tokens; every scalar is parameterized. Workflows retain their separate query
semantics, hashes and publication state.

### Errors, Docs and Playground

Explicit operator grammar uses sanitized 400 INVALID_FILTER, INVALID_SORT, QUERY_TOO_COMPLEX.
Legacy-only invalid requests retain INVALID_REQUEST. INVALID_INCLUDE and existing
auth, timeout, capacity, drift, unavailable and response-size errors remain.
Responses retain request IDs and do not disclose SQL, driver errors, field IDs,
physical names or supplied values. Query validation precedes the normal CRUD
executor; application-session authentication may already have used the customer DB.

OpenAPI preserves explicit legacy equality/pagination/sort/include parameters.
Additive `x-runtime-query` version 1 lists public applied capabilities and limits,
not every field/operator parameter. Clients ignoring it still receive valid
OpenAPI 3.1. Docs/examples are synthetic and require no customer-data reads.

Playground offers five bounded field/operator/value rows, an IN add/remove editor,
and an explicit NULL/non-NULL selector. Operator choices use applied capabilities.
Sorting, includes, credentials, request invalidation and explicit Send remain.

### Deferred

No arbitrary OR/nested logic, field comparisons, related-field filtering/sorting,
joins, one-to-many/recursive includes, prefix/contains/LIKE/ILIKE/regex/full-text/
trigram search, JSONB/path querying, cursor pagination, aggregation/count/group-by/
HAVING/DISTINCT, computed fields, GraphQL, saved queries, analytics, multi-sort,
or workflow advanced filters.

## Managed reference fields

References target an already-applied managed table in the same project/connection, store UUIDs and always reference its generated `id`. Apply installs an `ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE` foreign key and deterministic B-tree index atomically. Required references are supported at initial creation; later reference additions must be nullable without defaults or uniqueness. Ordinary UUID ownership fields remain separate and references cannot be owner fields.

Target selection and relationship preview check catalogs read-only. A newer target draft does not change the bound applied schema. A reference proves existence, not authorization/shared ownership. Missing targets and restricted parent deletion return sanitized `409 RELATIONSHIP_CONFLICT`; workflow violations roll back prior writes. Disabled/missing enforcement, unexpected FKs/indexes/triggers and target drift fail closed. An incoming managed reference alone does not change the parent's logical revision or stale its workflows.

Self-reference, cycles, unique/one-to-one references, cascade/set-null, external/auth targets, arbitrary target keys, retargeting/removal and nested writes are unsupported. For expanded reads use the include contract below; for required UUID fills use the schema-evolution rules above.

## Relationship-aware reads

Generated GET and list operations accept one optional `include` parameter, with
one or two distinct applied managed FK field names separated by commas. Example:

```
GET /api/example/orders?limit=25&include=billing_customer_id,shipping_customer_id
```

Names are exact FK field names. Wildcards, whitespace, duplicates, repeated
parameters, arrays, dotted paths and nesting are invalid (`400 INVALID_INCLUDE`).
Writes, workflows and application-auth routes reject include. Without include,
records retain their ordinary projection and have no `_related` property.

Expanded records preserve their raw UUID fields and add exactly the requested
keys under `_related`. Target records use the ordinary generated GET projection
and scalar serialization, without recursive expansion. A null FK, missing target,
or owner-inaccessible target produces null. Null means no related record is
readable for this reference under the request's snapshot and permissions.

### Authorization and consistency

The parent operation and every target GET are authorized independently using the
same runtime principal. A key cannot satisfy an application-user policy, and an
application session cannot satisfy a key-only policy. Read-scope keys suffice for
key-only target GET. Owner predicates are included in target SQL. Administrator
bypass uses each operation's own allowAdmin setting. Disabled/unavailable or
identity-incompatible target GET fails the entire request with
`403 INCLUDE_UNAVAILABLE`, including empty pages and null references.

Applied parent and target metadata, endpoint configurations, connection identity,
blocking state and project suspension are resolved in one platform repeatable-read
snapshot. Draft definitions are excluded. A final fresh snapshot is compared with
a SHA-256 fingerprint before customer commit. Policy, revision, relationship,
connection or suspension changes, or inability to complete the metadata fence,
fail with `503 RUNTIME_METADATA_CHANGED`. The fence conservatively includes the
existing applied managed-table dependency context. This is a freshness check,
not a distributed transaction between platform and customer databases.

Expanded reads use one customer admission and connection, with REPEATABLE READ.
The existing application-session FOR SHARE guard is retained; the transaction is
not declared READ ONLY because that would conflict with required locking. The
expansion path issues no application DML/DDL. Catalog checks include managed FK,
index, enforcement trigger and target dependencies. Drift fails closed with
`503 RUNTIME_UNAVAILABLE`, never null.

### Bounds

Pagination happens before expansion. The limit+1 lookahead row is excluded from
UUID collection. Each include executes one parameterized `ANY(uuid[])` query,
with deduplicated identifiers and a maximum of 100 target rows. Two references to
the same target retain separate namespaces. Application-data query counts are
1/2/3 for zero/one/two includes, independent of page length.

The existing 1 MiB runtime ceiling includes nested copies. Target batches are
size-checked before projection, and nested copies are accounted incrementally
before assembly completes. Oversized results fail with `422 RESPONSE_TOO_LARGE`.
Existing admission, statement, rate and total operation limits remain; expanded
reads also bound waiting for the final metadata fence by the operation deadline.
Read completion failures do not report write uncertainty. Ordinary transactions
and workflow write-uncertainty semantics retain their existing behavior.

### Docs and compatibility

OpenAPI advertises only applied references with enabled GET and compatible
credential modes. Optional `_related` properties describe target base records or
null, without recursive schemas or include-combination enumeration. Ordinary and
expanded examples are synthetic. Docs and Playground provide choice-based include
controls, maximum two; snippets use credential placeholders. Playground does not
send automatically and preserves filters, ordering and pagination.

Includes are read-time options, not persisted endpoint aliases or workflow expansion. They do not alter schema plans or recovery receipts.

### Verification and exclusions

See [testing](testing.md) for real PostgreSQL authorization, consistency, scalar and query-count checks.

Nested/recursive includes, collections, many-to-many, arbitrary joins, related-field filters/sorts, nested writes, row pickers, external/auth/cross-project tables, workflow expansion, GraphQL, graph UI, dynamic policies and column-level authorization remain unsupported.

## Application authentication and ownership

The platform stores `project_auth_configs` and per-operation endpoint policies. Application users, password hashes, roles, and sessions remain in the project's customer PostgreSQL database. Platform users and application users are separate identities.

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

Provisioning spans two databases. A lost customer commit response records `outcome_unknown`; a process crash or failed platform finalization can leave `provisioning`. Both states block configuration changes and reprovisioning. Auth requests require ready status. A trusted operator uses dry-run reconciliation to establish the transaction outcome before explicitly repairing metadata. There is no automatic retry/adoption or public reconciliation endpoint; see [recovery](../deploy/RECOVERY.md#uncertain-setup-reconciliation). Disabling auth does not delete customer users or sessions.

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

For protected routes, send `Authorization: Bearer <us_token>`. Browser SPAs should retain the token in memory; reload requires login again. Native clients should use OS secure storage. Application-session persistence through cookies is not implemented; platform dashboard cookies are a separate identity channel. Use HTTPS outside local development. All auth responses inherit Cache-Control: no-store; passwords, hashes, and tokens are excluded from logs. `/auth/me` intentionally returns the signed-in user's email, while generic auth logs omit email addresses.

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

Signup and login each have independent in-memory one-minute windows: 20 attempts per project/IP and 10 per project/normalized identifier. Limits run before hashing, expire without permanent lockouts, and return `429` with Retry-After. Identifier counters use a process-secret HMAC, not raw email keys. Counter storage is capped at 10,000 entries; capacity fails closed until entries expire. Forwarded IP headers are trusted only from explicitly configured proxy peers. Deployment behind a proxy requires the [documented ingress topology](../deploy/README.md#network-and-proxy-trust) before relying on client IP limits. Multi-instance deployments need shared or edge rate limiting; in-memory counters are process-local and reset on restart.

Auth database work uses short-lived clients with deadlines and a ten-request category cap within the shared 16-client budget. There is no customer runtime pool. Auth tables use catalog snapshots and fixed SQL; unexpected structural changes fail closed. Login failures for wrong password, unknown email, and disabled users share one generic response. Expected failures use sanitized categories, and runtime errors include request IDs. No bodies, passwords, hashes, bearer secrets, raw email addresses, SQL values, or PostgreSQL errors are logged.

JWT, refresh tokens, cookies, OAuth, password reset, email verification, custom user-table mapping, custom roles/policies, PostgreSQL RLS, field permissions, teams, persistent browser sessions, and automatic account recovery are deferred. There is no self-service account recovery or verified-email guarantee in this MVP.

## Transactional workflows

Platform metadata includes `workflow_endpoints` (identity, editable draft, enable state, published-version pointer) and `workflow_versions` (append-only published snapshots and applied-schema dependencies). There are no separate step/connection tables, background workers, customer workflow-history tables, or new dependencies.

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

CRUD and workflows share a customer transaction runner and ten-request category capacity budget within the shared 16-client admission budget. One workflow uses one client and one transaction. It verifies all dependency revisions and customer catalog snapshots before running steps. Success responses are constructed and bounded before COMMIT and sent only after COMMIT succeeds. Business-error Response blocks roll back earlier writes before returning the configured body. SQL failures, missing required rows, bad references/types, or missing responses also roll back. Unique conflicts return sanitized 409; missing/inaccessible rows return 404; invalid input 400; runtime definition/value errors 500; stale dependencies/drift 503; timeouts 504. Runtime errors include request IDs and omit SQL, driver details, credentials, and stack traces. Ambiguous commit returns an uncertain-outcome failure and is never automatically retried.

A safe place-order workflow queries a product with FOR UPDATE, handles a null product with 404, checks integer stock >= quantity, inserts an owner-injected order, performs a guarded decrement, and returns a mapped order with 201. Locking and the guarded SQL update protect competing purchases; a transaction alone would not protect an ordinary read/check/write sequence. Integration tests send two concurrent orders against stock insufficient for both and require one commit, nonnegative stock, and no orphan order.

### Bounds and logging

Limits: 30 total configured steps across branches, 3 condition levels, 10 DB blocks, 5 tables, a 64 KiB definition, 32 KiB individual literals, 256 KiB response, and 512 KiB intermediate context. Body size retains the app's 64 KiB limit. There are no loops, parallel steps, jumps, or general graphs, so execution count is statically bounded.

The runner starts a ten-second deadline after capacity admission, bounds connection establishment to five seconds, uses a one-second lock timeout, and adjusts each statement timeout to min(two seconds, remaining deadline). Expiry closes an active pg client, and statement timeouts terminate database work; this is not a Promise.race that leaves work running. Clients close in finally and capacity is released on every outcome. No customer pool or background execution is added.

Logs contain route/request/principal IDs, safe workflow/version IDs, configured step count, executed DB count, terminal response ID, response status, duration, commit/rollback outcome, and sanitized error categories. They exclude request values, step outputs, response bodies, SQL parameters, tokens, credentials, and PostgreSQL errors. No persistent workflow history is stored.

Set Variable, find_many, additional HTTP methods, route parameters, arbitrary SQL/code, functions, external calls, secrets, loops, parallelism, custom headers, manual transactions, cross-database operations, background jobs, and idempotency keys are deferred.

## Generated TypeScript client

The project Docs page generates one standalone `<project-slug>-client.ts` file.
Generate/Refresh, inspect, copy or download it. Generation is owner authenticated,
on demand, and writes neither platform/customer metadata nor server files.

### Contract and freshness

The generator reuses deployed CRUD/auth OpenAPI builders, applied table metadata
and applied query capabilities. It never reads application rows, credentials or
schema drafts. Unrelated stale workflows do not block generation; inconsistent
CRUD/auth/applied/relationship metadata does. Workflow execution and ordinary
OpenAPI readiness remain unchanged.

`SDK_CONTRACT_HASH` fingerprints the public row/input/method/policy/query/include/
auth contract. `SDK_GENERATOR_VERSION` identifies the renderer contract.
`SDK_TABLE_REVISIONS` contains logical diagnostic provenance, not a freshness
protocol. Endpoint policies/enablement and auth/signup settings can change output
without changing table revisions. Regenerate after those changes or an applied
API contract change. Draft-only edits and normal non-unique index Apply leave
source byte-identical. Physical revisions, index catalogs, origins, default
literal values, timestamps and internal IDs are excluded. No runtime negotiation.

### Types

UUID, text, varchar, bigint, decimal, date and timestamp use `string`; integer uses
`number`; boolean uses `boolean`; JSONB uses recursive `JsonValue`. Bigint and
decimal strings preserve exactness. Timestamp query strings retain timezone and
microseconds; response serialization remains the runtime's existing behavior.

`Row_<table>` includes generated `id` and every applied field. SQL nullable scalar
fields include `null`. JSONB read types allow JSON null even for SQL NOT NULL
columns. JSON null and SQL NULL have the same JavaScript representation; writes
still reject top-level null for nonnullable JSONB, while nested JSON null is valid.
JSON depth/size, finite numbers and scalar validation remain server enforced.

Create inputs come from deployed request schemas: generated IDs/injected owners
are absent; requiredness/default optionality matches the server. Empty create uses
`Record<string, never>`. Updates exclude protected fields and use `AtLeastOne`.
Enabled PATCH with no writable fields is omitted and listed in
`SDK_OMITTED_OPERATIONS`. DELETE resolves `void` for 204. Read/create/update return
rows; list returns `{ data, pagination: { limit, offset, hasMore } }`.

### Usage

```ts
const client = createClient({
  baseUrl: 'https://api.example.test/api/my-project',
  getSessionToken: () => applicationSessionToken,
});
await client.resources['products'].list({
  filter: { price: { gte: '100', lte: '500' }, category: { in: ['A&B', 'ACME, Inc.'] } },
  sort: 'price', direction: 'asc', limit: 25,
});
```

Available resources/methods/fields depend on the deployed project. Only enabled,
usable methods are emitted. SDK equality uses explicit `eq`; HTTP legacy equality
remains unchanged. UUID/id: eq/neq/in. Numeric fields: eq/neq/gt/gte/lt/lte/in.
Date/timestamp: eq/neq/gt/gte/lt/lte. Text/varchar: eq/neq/in. Boolean: eq/neq.
Nullable non-JSONB fields additionally support is_null. JSONB has no filters.

All clauses combine with AND, maximum five. IN is 1–25 values, encoded as one JSON
array of strings through the shared canonical URLSearchParams serializer; integer
IN converts each integer to a string. Bigint/decimal never pass through Number.
NULL checks use booleans. Server validation remains authoritative.

Single sort, limit 1–100 (default 25), offset 0–10000, deterministic ID tie-breaking
and lookahead remain unchanged. Includes permit at most two one-level relationship
field names. Raw UUID FKs remain; `Read_<table>._related` is optional and target
values are plain target rows or null. Parent filtering/pagination precedes expansion;
target authorization remains independent. Ownership is enforced by the server.

### Credentials and transport

`apiKey` and `getSessionToken` are separate channels selected per deployed policy.
Key-only methods require a `pk_` project key; authenticated/owner methods require a
`us_` application session. Neither substitutes for the other. Dashboard sessions
are never used. Public signup/login send neither credential. Auth helpers appear
only for ready enabled auth; signup additionally requires signup enabled. Login
returns `{token, expiresIn, user}` without storing it; logout revokes the supplied
session without changing application storage. No cookies/localStorage/sessionStorage.

Use user sessions for user-specific browser access. Project keys are shared
credentials without per-user ownership. Keep write keys on trusted servers/BFFs;
read-only keys remain shared credentials. Generated source contains no real secrets.

Requires ES2022 and standard web fetch, URL, URLSearchParams and AbortSignal typings
(modern browser/Node/Next.js). `baseUrl` is the runtime project root and preserves
path prefixes; query, fragment and userinfo are rejected. Row IDs are UUID checked
and encoded. Per-request options support only `signal`. Fetch omits cookies and
rejects redirects. No retries or arbitrary header overrides.

`ApiError` carries status/code/safe message/requestId; non-JSON HTTP errors receive
a generic message. `TransportError` means the response could not be confirmed.
`ProtocolError` covers unexpected success status or invalid/empty JSON. 204 is
handled without parsing. A failed or uncertain write does not prove rollback.

### Management and exclusions

`GET /internal/projects/:projectId/sdk/typescript` accepts no query parameters,
requires platform ownership, returns no-store JSON containing filename,
generatorVersion, contractHash, tableRevisions and source. This is a management
route for downloading a runtime client; the generated client has no management API.

The generated client has no persistence, publishing, framework hooks, workflow helpers, recursive/include-dependent types, other languages, realtime, ORM, automatic retry, offline cache, token persistence, schema negotiation, plugins or arbitrary templates.

## Project Docs and OpenAPI

Owners can inspect deployed CRUD, enabled application auth and published enabled workflows, download OpenAPI 3.1 JSON, or select an operation in Playground without sending it. Both packages must use the same public runtime origin. Generation reads metadata, not customer rows or live catalogs; examples are synthetic and exclude stored default/workflow literal values. Drafts are excluded.

Unavailable deployed metadata or stale enabled workflows cause sanitized `503 API_DOCS_UNAVAILABLE`; resolve blockers or republish/disable the stale workflow. Whole-document Docs fail closed. SDK generation separately validates the CRUD/auth portions and can succeed despite an unrelated stale workflow. OpenAPI `info.version` identifies the document contract, not versioned API releases. Dynamic workflow result schemas intentionally allow unconstrained JSON.

## Runtime observability

The owner-only Observability page records best-effort runtime request history. It observes CRUD, application signup/login/me/logout, and published workflows. Management requests and OPTIONS preflights are excluded. Unknown projects produce no events. Known-project invalid credentials, suspension, rate limiting, admission rejection, and handled errors can produce events after trusted project resolution. Requests rejected before project resolution may be absent.

### Recorded metadata

One version-1 event contains a storage UUID, resolved project UUID, existing request ID, completion timestamp, bounded category/operation, resolved resource/workflow name, method, actual HTTP status, public error code, monotonic duration in integer microseconds, optional serialized payload bytes, and principal kind (`project_key`, `app_user`, `anonymous`). There is no general JSON metadata column. Resource names are developer-managed platform metadata. All event metadata is plaintext in the platform database.

Never recorded: credentials, headers, cookies, passwords, email, user/session/key IDs, request or response bodies, customer rows/row IDs, raw URLs/paths/query strings, filters/field names/values, SQL, driver messages, exceptions/stacks, connection information, IP, user agent, origin/referer, or workflow steps/input/output. Existing operational logs remain separate; the telemetry writer does not copy their broader metadata.

### Semantics

`X-Request-Id`, public error `requestId`, and event request ID match. Trusted forwarded request IDs may repeat, so exact owner/project-scoped lookup returns up to 100 matches. Expired requests are invisible everywhere, including lookup. Copy an API response request ID into exact search; no global or free-text search exists.

Counts mean **recorded requests**, not guaranteed traffic, billing, or usage quotas. 2xx, 3xx, 4xx, and 5xx are reported separately. A 4xx can be an expected application/client response. Workflow-defined business error bodies are never inspected for codes; their code can be null.

Latency measures server handling from the runtime hook through response completion using a monotonic clock. p50/p95 display milliseconds. It is not client/network latency or customer-DB timing. Response bytes count already-serialized application payload bytes (zero for HEAD/204/304), not network-wire bytes or proof of delivery. Unsupported payloads have null size. Interrupted requests may have no completion event.

### Best-effort asynchronous persistence

The request completion hook only builds an immutable safe event and enqueues it. It never awaits telemetry PostgreSQL. The writer timer flushes at most 32 events every 100 ms through one active path. Memory holds at most 256 queued events globally and 64 queued events per project, plus one active batch. Incoming events drop under pressure. There is no disk spill, durable queue, replay, or retry of failed/ambiguous batches. Customer operations are never retried because of telemetry. Telemetry failure cannot roll back a customer commit or replace its response.

A dedicated writer/cleanup pool has at most two platform connections: acquisition 100 ms, statement 200 ms, lock 50 ms, query/active-connection deadline 400 ms. Destroying an expired connection cancels outstanding work. Failure/drop counters and rate-limited fixed server log messages are operational diagnostics, not recursively recorded events. Shutdown allows approximately one second to drain queued work before dropping the remainder.

### Retention and query bounds

Retention target is seven days, not a hard event-count or storage quota. All reads enforce retention even while physical deletion lags. A five-minute lifecycle timer deletes at most five batches of 1,000 oldest expired rows per run, with a nonblocking transaction-scoped advisory lock across processes and bounded database execution. Cleanup is independent of traffic; failures are logged safely and tried on a later timer. PostgreSQL vacuum remains necessary, and DELETE does not immediately shrink files.

Windows are `1h`, `24h` (default), and `7d`. Summaries directly aggregate retained events, including top 20 operations and public error codes. No rollups. Recent requests use descending completion-time/UUID keyset pagination, default 25 and maximum 100. Cursor input is strictly validated and bound to the chosen window/filters; route owner/project scope always wins. Retention can remove events during pagination. Requests support operation/resource/status-class/failure filters. Refresh is manual.

### Limits

At five requests/second, one process/project can generate over three million requests/week; rejected traffic can exceed admitted traffic. The queue bounds memory, not disk. Cleanup throughput and available disk must be assessed against measured traffic. Seven-day cleanup may lag after outages or sustained heavy traffic. This private-alpha feature makes no production-capacity or complete-history guarantee. See [testing](testing.md#observability-measurements) for historical local evidence and remaining gates.

Runtime history does not change customer schemas, runtime contracts, workflow dependencies or generated SDKs. Unsupported: tracing/spans, exporters, metrics systems, alerts, charts, live logs, bodies/SQL/identity tracking, billing/quotas, custom retention, exports, DB timings/query counts, and aggregate tables.

### Operational notes

Apply platform migration `0011_runtime_observability.sql` through the normal migration lifecycle before starting code that needs it. The role-provisioning step grants access to the telemetry table. No customer schema Apply is needed.

Signup/login remain anonymous for the request itself. Successful `auth.me` establishes `app_user`; logout remains anonymous when its idempotent revocation does not establish a principal. CRUD/workflows record a principal kind after successful authentication.

Refresh to see newly persisted events. Cursor ordering is stable, but asynchronous arrivals and retention mean paging is not a transactional snapshot. Management reads have a separate bounded budget, described below. Heavy CPU/I/O contention or larger retained datasets can still return a sanitized observability-unavailable response. The [measurement artifact](../OBSERVABILITY_MEASUREMENTS.jsonl) retains earlier failures and final bounded-read measurements; see [testing](testing.md#observability-measurements) for interpretation.

### Management read isolation

Owner observability reads use the existing platform management pool (maximum ten connections), separately from the two-connection telemetry writer/cleanup pool. Each read acquires within 250 ms, runs in a read-only transaction with a 1,000 ms statement timeout and 100 ms lock timeout, and destroys its connection after a 1,250 ms active-operation deadline. Late acquisition is released without running SQL. Transaction-local settings reset before a healthy connection returns to the management pool. Each repository call checks ownership separately before its data query, so the acquisition/active bounds apply to each of those two queries, rather than constituting a single HTTP deadline.

The writer retains its 100 ms acquisition, 200 ms statement, 50 ms lock and 400 ms active-operation limits. Runtime completion still only enqueues local metadata. No request waits for event insertion or cleanup. Dashboard reads can contend with other management work and PostgreSQL CPU/I/O, but do not occupy writer pool connections. Timeouts remain sanitized availability errors; overload does not guarantee dashboard availability.
