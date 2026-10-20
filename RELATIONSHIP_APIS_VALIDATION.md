# Local validation — v0.8.0-alpha.1

Node.js 24.21.0; disposable PostgreSQL 18; Chromium. No external deployment.

## Performance

One local sample per case, under shared test/build load. Customer control counts include transaction setup, catalog verification, locks and statement-timeout control queries; platform metadata queries are separate. Heap deltas include garbage collection. These are observations, not a production latency promise.

| Read | Rows | Includes | Data queries | Customer control queries | Latency ms | Response bytes | Heap delta bytes | Admission slots after |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| get | 1 | 0 | 1 | 39 | 161.94 | 139 | 1268192 | 0 |
| get | 1 | 1 | 2 | 56 | 276.08 | 229 | 2265920 | 0 |
| get | 1 | 2 | 3 | 73 | 406.58 | 254 | 2531216 | 0 |
| list | 1 | 0 | 1 | 39 | 248.69 | 200 | 1256304 | 0 |
| list | 1 | 1 | 2 | 56 | 294.44 | 290 | 2305152 | 0 |
| list | 1 | 2 | 3 | 73 | 390.6 | 315 | 3545808 | 0 |
| list | 25 | 0 | 1 | 39 | 226.16 | 3538 | 1324704 | 0 |
| list | 25 | 1 | 2 | 56 | 258.29 | 5788 | 2341488 | 0 |
| list | 25 | 2 | 3 | 73 | 285.65 | 6413 | 2645216 | 0 |
| list | 100 | 0 | 1 | 39 | 152.69 | 13964 | 1451696 | 0 |
| list | 100 | 1 | 2 | 56 | 247.4 | 22964 | 2538472 | 0 |
| list | 100 | 2 | 3 | 73 | 327.88 | 25464 | 2859208 | 0 |

The list lookahead row is excluded from batching. Repeated references are deduplicated per include. All measured requests returned successfully with 1/2/3 data queries and zero admission slots afterward.

## Checks

- Backend unit/HTTP: 94 passed in the full run. Final focused runtime HTTP/include/OpenAPI checks: 34 passed (overlapping coverage).
- Frontend focused: 48 passed.
- Chromium Playwright: 17 passed, including ordinary versus expanded relationship responses and existing navigation/pending-request protections.
- Backend and frontend typechecks passed. Backend build and frontend production build passed. Both final Docker images built. Compose configuration validation passed.
- Final full PostgreSQL run, with all disposable upgrade/legacy fixtures: 76 passed, zero failures, zero skips. An earlier concurrent build/test run missed an expected 429 in a rate-limit burst; that unchanged test passed both its isolated rerun (10 upgrade/recovery tests) and the final complete suite. Response-size enforcement passed throughout.
- Final credential/auth rerun: 13 passed, including revoked read-key and dashboard credential rejection on expansion.
- Final relationship/auth/scalar rerun: 31 passed, including target owner/admin matrix, expanded session revocation/role guards, FK-change/target-delete snapshot consistency, six metadata fence changes, drift, scalar serialization and complete byte limits.

## Scope and limits

No migration files or schema/recovery formats changed. Existing workflow outputs/publication remain unchanged. The metadata fence is a bounded freshness check, not distributed atomicity. The browser relationship test covers the ordinary/expanded selector flow; the deeper target policy/admin/hidden-row matrix is exercised in backend PostgreSQL tests.

Git status/diff could not run because this checkout’s `.git` points to an absent worktree location. No commit or deployment was performed.

The disposable PostgreSQL container and its anonymous data volume were removed after verification. Local backend/frontend review images remain.
