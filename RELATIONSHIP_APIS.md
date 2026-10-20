# Relationship-Aware APIs — v0.8.0-alpha.1

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

## Authorization and consistency

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

## Bounds

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

## Docs and compatibility

OpenAPI advertises only applied references with enabled GET and compatible
credential modes. Optional `_related` properties describe target base records or
null, without recursive schemas or include-combination enumeration. Ordinary and
expanded examples are synthetic. Docs and Playground provide choice-based include
controls, maximum two; snippets use credential placeholders. Playground does not
send automatically and preserves filters, ordering and pagination.

No platform/customer migration, alias, endpoint persistence change, schema-plan
hash change or recovery-receipt format change is introduced. Workflow outputs and
publication contracts are unchanged.

## Verification

Focused coverage lives in backend/tests/includes.test.ts,
backend/tests/integration/{relationships,auth,include-scalars}.test.ts,
backend/tests/api-docs.test.ts, frontend/tests/includes.test.ts and
frontend/tests/e2e/relationships.spec.ts. Integration tests require separate
explicit disposable TEST_DATABASE_URL and TEST_CUSTOMER_DATABASE_URL. Legacy
upgrade checks additionally require empty TEST_UPGRADE_DATABASE_URL and
TEST_LEGACY_DATABASE_URL. Browser tests require separate local
`dashboard_e2e_*_test` databases.

The relationship integration test prints local measurements for GET and list
sizes 1/25/100, each with 0/1/2 includes: application-data queries, customer control
queries, latency, response bytes and heap delta. Values depend on local load and
are not production benchmarks; heap deltas include garbage collection.

Nested/recursive includes, collections, many-to-many, arbitrary joins,
related-field filters/sorts, nested writes, row pickers, external/auth/cross-project
tables, workflow expansion, GraphQL, SDK generation, graph UI, dynamic policies
and column-level authorization remain deferred.
