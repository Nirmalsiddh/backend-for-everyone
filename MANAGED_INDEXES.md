# v0.9.0-alpha.1 — Managed Indexes & Safer Schema Evolution

The Schema Builder supports explicit normal/unique B-tree indexes on one to four
ordered fields, at most eight user indexes per table. Eligible types are UUID,
integer, bigint, boolean, decimal and timestamp. These have bounded representations
under the existing field model. Text, varchar, JSONB and date indexing are deferred;
ordinary field validation has not changed. No index method, SQL name, expression,
predicate, collation, operator class or custom ordering is accepted from clients.

Save fields before selecting them for an index. Initial table creation can include
multiple indexes. For an applied table, add one index or make one existing nullable
field required per Apply. Existing nullable column/reference additions remain
supported. Do not mix these with a new index or requiredness change. Existing
initial-create defaults and unique-field constraints are unchanged; post-Apply
default capabilities remain unchanged.

Index IDs are server-generated UUIDs. Ordered field IDs and uniqueness are saved
as versioned draft specifications in `schema_indexes`; applied specifications are
captured in the versioned applied definition. Physical names are deterministic
`ix_usr_<UUID hex>` identifiers, never editable configuration. Draft-only indexes
can be changed/removed. Applied indexes cannot be changed, reordered or removed.
Mandatory FK indexes remain separate, automatic, read-only infrastructure. Duplicate
single-column FK indexes and unique indexes involving references are rejected.

## Revisions and compatibility

`draftRevision` is the optimistic draft token. `appliedRevision` remains the logical
API contract revision. New `appliedPhysicalRevision` records the draft token whose
physical state was applied. Existing tables initialize physical revision to logical
revision without customer DDL. Initial create initializes both. Normal index Apply
advances only physical revision; unique indexes, requiredness and nullable field/
reference additions advance both. Failed Apply advances neither.

Published workflows retain logical dependencies: normal indexes do not stale them;
unique/requiredness/field changes retain conservative contract-change staleness.
No workflow version is rewritten or automatically republished. Runtime expansion
metadata fencing includes physical revision and complete applied catalog state.
Normal indexes do not change response bodies, OpenAPI, authorization, pagination,
filter/sort syntax or bounded include query counts.

## Data validation, locks and availability

Apply uses the existing advisory lock and deterministically ordered exclusive table
locks. After verifying PRE state, it checks duplicate keys or SQL NULL existence
before index/NOT NULL DDL in the same transaction. Concurrent writes cannot race
those prechecks. No rows are updated, merged, removed or backfilled. Duplicate/NULL
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

Reads and writes may be temporarily unavailable while Apply runs. This milestone
uses transactional CREATE INDEX, never CONCURRENTLY. Existing lock, statement,
operation and quota bounds remain. Large operations may time out and roll back.

## Catalogs, recovery and upgrade

Legacy canonicalization, unversioned/v2 planner behavior, FK names/canonicalization,
and legacy catalog readers remain frozen. New evolution uses plan/catalog version
3. The new hash binds both prior revisions, exact prior applied definition/catalog,
ordered index specifications, typed actions, connection identity and relationship
dependencies. It excludes credentials. Legacy hashes never gain empty index arrays
or physical-revision fields. Mixed catalog versions are inspected explicitly.
Application-auth internal catalogs/indexes retain their existing representation.

Catalog v3 records ordered index keys, category/name, uniqueness, method, readiness,
validity, liveness, ordering, NULL behavior, operator classes, collations, constraint
association, and absence of predicates/expressions/INCLUDE attributes. New durable
identities do not use OIDs. Unexpected external indexes continue to cause drift.
Index/NOT NULL/FK/trigger drift blocks affected CRUD, workflows and includes.

Receipts remain encrypted and authenticated, bound to project, operation and plan
hash. Exact prior state is PRE_STATE; exact authenticated complete post-state is
POST_STATE; mismatched/partial/unreceipted state is DIVERGED. Reconciliation never
replays DDL. Lost commit acknowledgements or platform finalization failures remain
blocked until operator reconciliation determines the state. No distributed atomicity
between platform and customer databases is claimed.

## Deferred

Applied index deletion/replacement, physical renames, drops, type changes, unique
references, text/varchar/JSONB indexes, other index methods/options, post-Apply
defaults, backfills, concurrent/background/scheduled migrations, schema rollback,
data transforms, recursive/collection expansion, GraphQL and SDK generation.
