# v0.9 validation evidence

Baseline: `b6d142685bb697dbc8c177909422d6d9dfb5bc66` (v0.8.0-alpha.1).
Validation uses Node.js 24.21.0 and disposable local PostgreSQL 18. No external deployment.

## Revision-use audit

All preexisting backend `appliedRevision` uses were reviewed, rather than globally
replaced. Logical dependencies remain logical; physical readers additionally bind
physical revision and/or the exact applied catalog.

| Usage | Classification and treatment |
| --- | --- |
| Workflow types, publication validation, service and engine dependency checks | API contract; retain logical revision. Runtime catalog verification still checks physical applied state. |
| Endpoint configuration optimistic revision | API contract; retain logical revision. |
| API Docs applied availability and workflow staleness | API contract; retain logical revision. Ordinary indexes produce identical OpenAPI. |
| Legacy planner hash and relationship dependency canonicalization | Historical contract; unchanged. Exact applied definition/catalog already binds physical state for new legacy operations. |
| New evolution planner/dependencies | Both; explicitly bind logical and physical revisions plus exact prior snapshots. |
| Schema repository finalization and reconciliation | Both; physical always advances, logical advances only for contract changes. Legacy reconciliation uses the legacy generator explicitly. |
| Runtime parent/target metadata and managed dependency snapshot | Both; physical revision added to expanded-read fingerprint; logical availability preserved. |
| Connection credential validation snapshot/fence | Physical; add physical revision alongside existing catalog/definition and logical checks. |
| Schema DTO/editor | Display both distinct revisions. |
| Platform integrity constraints | Both; physical/logical nullability agrees, logical <= physical <= draft. |

## Regression gates

| Gate | Result |
| --- | --- |
| Backend typecheck / production build | Passed |
| Backend unit / HTTP | 100 passed; zero failures/skips |
| Full PostgreSQL integration, all disposable DB variables supplied | 93 passed; zero failures/skips |
| Frontend typecheck / production build | Passed |
| Frontend focused tests | 51 passed; zero failures/skips |
| Chromium acceptance | 18 passed; final help-text build recheck: 1 passed |
| Backend / frontend production images | Both built locally |
| Compose configuration validation | Passed; no deployment |
| Changed/new-file secret-pattern scan | Seven credential/private-key pattern families; zero findings |
| `git diff --check` | Passed |

The full PostgreSQL suite includes
legacy upgrade, recovery, restore containment, credential rotation, schema/FK checks,
application auth, ownership, keys, workflows, include authorization and limits.

Additional tests exercise deterministic writer barriers after unique/NULL prechecks,
transaction rollback, lost COMMIT acknowledgements, initial-create and post-Apply
PRE/POST/DIVERGED, exact old plan hashes and authenticated receipts, and a cold Node
process reading persisted metadata and executing runtime CRUD.

The upgrade fixture executes the exact archived baseline source, migrates platform
metadata, and compares old hashes, customer object OIDs and authenticated comments.
It includes an interrupted legacy relationship operation; no customer DDL is run by
the upgrade migration itself.

## Reproduction notes

Use explicit disposable `TEST_DATABASE_URL`, `TEST_CUSTOMER_DATABASE_URL`,
`TEST_UPGRADE_DATABASE_URL`, `TEST_LEGACY_DATABASE_URL` and `TEST_V08_DATABASE_URL`.
Upgrade databases must be fresh. Export `V08_SOURCE_DIR` pointing to an archive of
`b6d1426` containing `backend` and `shared`; make backend dependencies available to
that archive without modifying its source. Then run `npm run test:integration` in
`backend`. The exact-baseline test skips unless its two explicit inputs are supplied;
they were supplied in the reported zero-skip run.

Run each package's `typecheck`, `test` and `build` scripts. Chromium uses explicit
disposable `E2E_PLATFORM_DATABASE_URL` and `E2E_CUSTOMER_DATABASE_URL` and the existing
Playwright backend setup. This run used an external temporary config to reuse the
already built production frontend, with the same test directory, single worker,
timeouts and no retries. No product limits or authentication throttles were relaxed.

Build images from the repository root using `backend/Dockerfile` and
`frontend/Dockerfile`. Validate `deploy/compose.yaml` with required environment values
and `docker compose ... config --quiet`; no services were externally deployed.
The secret check scanned changed and untracked files for private keys and common
AWS/GitHub/Stripe/Slack/OpenAI token patterns, without printing matches. It is a
bounded pattern scan, not a claim of exhaustive credential detection.

## Local Apply measurements

One sample per case from the full integration run, with ordinary local concurrent
build/test activity. Milliseconds include client round trips. These are observations,
not a production capacity promise. Existing deadlines were unchanged.

| Rows | Operation | Validation ms | DDL ms | Table lock ms | Total Apply ms | Index bytes |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | normal | 0.00 | 4.07 | 3.63 | 481.63 | 8192 |
| 0 | unique | 5.21 | 8.08 | 3.19 | 1410.05 | 8192 |
| 0 | required | 5.97 | 3.13 | 7.15 | 913.80 | — |
| 1,000 | normal | 0.00 | 9.03 | 2.04 | 1175.97 | 40960 |
| 1,000 | unique | 18.76 | 8.15 | 6.75 | 1368.46 | 40960 |
| 1,000 | required | 11.81 | 9.67 | 1.29 | 1253.48 | — |
| 10,000 | normal | 0.00 | 46.37 | 1.01 | 1098.21 | 245760 |
| 10,000 | unique | 9.64 | 8.90 | 2.20 | 1237.19 | 245760 |
| 10,000 | required | 2.86 | 9.12 | 1.27 | 1132.99 | — |
| 100,000 | normal | 0.00 | 268.98 | 7.31 | 2332.88 | 2260992 |
| 100,000 | unique | 464.86 | 254.63 | 34.78 | 2933.53 | 2260992 |
| 100,000 | required | 46.29 | 25.49 | 20.72 | 872.27 | — |

All measured operations left customer admission usage at zero and preserved row
counts. Normal indexes need no duplicate-data validation scan. The lock timing
measures lock acquisition round trips; these samples had no deliberately competing
writer. Separate deterministic contention tests hit the unchanged 2-second lock
bound, return sanitized timeout, roll back and release admission. Injected failure
after DDL verifies transactional rollback without advancing applied metadata.

v0.8 query-count measurements retain 1/2/3 application-data queries for 0/1/2 includes
at page sizes 1, 25 and 100. For the measured fixture, catalog/auth/control queries
were 43/60/77 respectively, independent of page length; admission returned to zero.
No query-planner index-choice assertion or production-scale claim is made.

## Limitations

Transactional exclusive locks temporarily block reads and writes. Large index builds
can time out and roll back under existing bounds. Table-wide uniqueness can reveal
only the existing generic conflict outcome; no values, row identities or physical
index names are returned. The application performs no backfill or deduplication.
Historical formats remain frozen; catalog v3 has explicit dispatch and no durable
OID identity. The upgrade fixture covers the exact v0.8 baseline plus existing
legacy migration/recovery tests, rather than fabricating every historical release.
