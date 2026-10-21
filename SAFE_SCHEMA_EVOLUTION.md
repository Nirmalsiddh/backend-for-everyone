# Safer schema evolution — v0.12.0-alpha.1

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

Date/timestamp defaults are deliberately deferred: this release does not claim a proven environment-independent default canonicalization for them. Legacy defaults, including structured current-timestamp and JSONB defaults, retain their historical verification. A legacy default may remain unchanged. Removing a legacy date/timestamp default is safe because the new managed state is absence; UUID/reference/JSONB default evolution remains excluded. New default expressions/functions, generated UUID defaults and explicit SQL DEFAULT NULL are unsupported. Absence of a default means no managed default.

A future default applies when an INSERT omits the field. Changing it never replaces existing non-NULL values. A one-time fill replaces SQL NULL only and is allowed only with final requiredness. JSON null is separate; historical JSONB behavior is unchanged. Required additions always need a declared strategy, including on empty tables. If both values are configured, historical rows receive the fill and future omitted inserts receive the default. Fill-only required fields must be supplied by future creates.

Fill intent is draft metadata in nullable `schema_fields.backfill_intent`, introduced by the single additive migration `0010_safe_schema_evolution.sql`. Existing rows start without intent. Intent is validated, survives reload, is bound into the immutable plan, and is consumed atomically on successful publication or POST reconciliation without increasing the draft revision. Failure retains it. Fill intent never enters the applied field definition, runtime, Docs, OpenAPI, SDK or public contract hash.

**Fill/default values are plaintext platform metadata, consistent with existing defaults. They are not encrypted.** Do not store secrets there. Executor errors and structured v4 previews omit values and SQL. No customer-data COUNT is performed for confirmation.

New bundles use plan v4 and deliberate catalog v4 transitions. Historical v1/v2/v3 hashes, statement generation, receipts and catalogs are frozen; reconciliation explicitly dispatches to the historical planner. Only deliberately evolved default fields adopt structured constant descriptors; other historical default representations remain unchanged. The bounded verifier decodes allowlisted constant/cast shapes without executing expressions and rejects functions, SQL expressions and unsupported shapes as drift. Bigint/decimal normalization retains exact strings. Text/varchar literals also undergo a parameterized trusted-type round trip before effects, rejecting truncation or incompatible encoding instead of silently changing the value.

Apply uses existing platform/project serialization, schema admission, advisory locks and sorted ACCESS EXCLUSIVE table/dependency locks. Inside one customer transaction it verifies exact PRE, adds a new column temporarily nullable without a future default when required, installs any new FK, fills using a parameterized UPDATE ONLY … WHERE … IS NULL, checks for remaining NULL, installs/removes the future default, sets NOT NULL, verifies POST, writes an authenticated receipt and commits. Nullable additions can use ADD COLUMN DEFAULT directly. Correctness does not depend on PostgreSQL fast defaults. Uniqueness, FKs and external restrictions remain enforced; failures roll back the transaction. Tables with external row triggers are rejected for fills, and unexpected trigger changes fail POST verification.

These operations can block reads/writes and interrupt application traffic. They are not online or zero-downtime migrations. Existing statement, lock and absolute deadline limits remain unchanged. Large tables may time out and roll back; no chunking, jobs, queue or partial-fill resume exists. Fills require the customer role's update capability in addition to schema capabilities. Management errors are sanitized, including uniqueness, relationship, permission and timeout errors.

Customer commit precedes platform publication. An unknown outcome blocks retry. Reconciliation accepts POST only with the operation-bound authenticated receipt, exact catalog and dependency state; it publishes metadata without replaying fills. Exact PRE becomes a failed/not-applied outcome requiring reviewed retry. Other states, including committed intermediate-looking structures, are DIVERGED. A later non-NULL customer edit is preserved during POST reconciliation.

Field additions, requiredness and every default change advance both logical and physical revisions. Dependent workflows become stale after publication; unrelated workflows remain valid. Normal non-unique indexes remain physical-only. Drafts and failed Apply do not publish a new contract. OpenAPI/create validation uses applied nullable/default semantics. SDK literal default values remain excluded from the public contract hash: a value-only default change may retain that hash while table-revision provenance/source changes. Historical fill values are never generated into clients.

Deferred: standalone/data-only backfills, nullable-to-nullable fills, WHERE clauses, non-NULL overwrite, arbitrary SQL/code, JSONB evolution, type changes, renames, drops, transformations and online migration machinery. This milestone does not implement another release.
