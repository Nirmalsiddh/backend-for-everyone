# v0.10.0-alpha.1 — Validation evidence

Baseline: clean `main` at `81fee3846eaf6c39f83efb3469890c54b519e671`, real
`/home/nirmal/Downloads/project_idea` checkout. No branch or worktree created.
Validation uses Node.js 24.21.0 and an isolated local PostgreSQL 18 cluster with
SCRAM password verification and separate explicitly named disposable databases.
No external deployment, customer migration, or platform migration was introduced.
Existing migrations were used only to prepare disposable regression fixtures.

## Regression gates

| Gate | Result |
| --- | --- |
| Backend strict typecheck | Passed |
| Backend unit / HTTP | 204 passed; zero failures/skips |
| Full PostgreSQL integration | 100 passed; zero failures/skips |
| Frontend strict typecheck | Passed; final build also checks types |
| Frontend focused / component tests | 57 passed; zero failures/skips |
| Full Chromium acceptance | 19 passed; zero failures/skips; final focused recheck also passed |
| Backend / frontend production builds | Passed |
| Backend / frontend production images | Both built locally from final source |
| Compose configuration | Passed with synthetic values; no services deployed |
| Changed/new-file secret-pattern scan | 30 files, eight families; zero findings |
| git diff --check | Passed |

## Correctness and security

The operator/type matrix is table-driven, including malformed scalars for every
supported operator, primary-key/required-field NULL restrictions, aliases,
duplicates, unknown/draft fields, malformed brackets, strict scalar parsing,
IN JSON structure and 1/25/26 bounds, literal text null, and hostile values.
HTTP assertions show malformed advanced requests never reach the CRUD executor.

Real PostgreSQL tests cover integer comparisons/membership; bigint values above
Number.MAX_SAFE_INTEGER; exact decimals; leap dates; timezone offsets and adjacent
microseconds; booleans; text/varchar punctuation, Unicode, quotes, empty strings
and literal null; SQL NULL behavior; UUID relationships; contradictory ranges;
filter/sort/offset/lookahead behavior; owner predicates; managed-index drift; and
admission cleanup. Draft filters fail before Apply and become available after it.

The existing auth integration matrix now also uses advanced list filters plus
include/sort/pagination under key_only/authenticated/owner policies. Read/read_write
keys, ordinary/admin users, incompatible target GET policies, hidden related rows,
explicit admin bypass, wrong-project/revoked keys, expired/revoked sessions and
disabled users are exercised. Owner neq/self and IN/other cannot broaden access.

The full suite includes exact archived b6d1426 v0.8 upgrade, older alpha/platform
auth upgrades, restore containment, recovery receipts, FK/index drift, schema
constraints, sessions, workflow atomicity/publication and managed index evolution.
The archive is ordinary source under /tmp, not a checkout/worktree or branch.

An existing onboarding navigation selector is scoped to the sidebar to avoid
matching the same link in multiple overview sections; navigation itself is unchanged.

Browser acceptance covers legacy and explicit equality, inequality, ranges,
booleans, JSON IN, NULL, sorting/pagination, managed indexes, relationships,
parent/include behavior, owner isolation, sanitized errors, Docs, encoded URLs,
IN/clause limits, row removal, pending/dirty protections, endpoint switching and
no auto-run. Existing dashboard/workflow, relationship and index flows remain in
the full Chromium gate. Fixtures reuse a normally authenticated account to remain
within unchanged signup limits; no rate/admission/time limits were relaxed.

## Application-data query counts

Real managed relationships and actual related rows, with an advanced range plus
UUID membership predicate. The lookahead row is not expanded. These are data
queries only; session/catalog/transaction/platform work is additional.

| Page size | No includes | One include | Two includes | Admission after |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 2 | 3 | 0 |
| 25 | 1 | 2 | 3 | 0 |
| 100 | 1 | 2 | 3 | 0 |

## Local performance observations

One end-to-end sample per case/size from the final integration run. Milliseconds
include a new customer connection, catalog verification and transaction overhead.
Other local builds/tests ran concurrently. There is no cold/warm stratification,
percentile claim, production SLA, or index-choice assertion. Fixtures use real
managed indexes and related rows; ANALYZE runs after loading each size. Existing
product deadlines and limits are unchanged. All samples released admission to zero.

| Query | 1,000 rows ms | 10,000 rows ms | 100,000 rows ms | Returned | Data queries | Response bytes range |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy-equality | 109.29 | 407.83 | 351.33 | 1 | 1 | 433–433 |
| unindexed-equality | 266.67 | 212.27 | 192.16 | 1 | 1 | 433–433 |
| managed-index-equality | 316.84 | 271.51 | 98.96 | 1 | 1 | 433–433 |
| range | 244.24 | 251.50 | 237.15 | 25 | 1 | 9312–9312 |
| in | 242.88 | 276.07 | 154.64 | 3 | 1 | 1167–1167 |
| filter-sort | 324.20 | 363.73 | 368.19 | 25 | 1 | 9315–9465 |
| filter-include | 212.52 | 460.92 | 309.94 | 25 | 2 | 11837–11981 |

## Local image artifacts

- advanced-query-backend:v0.10.0-alpha.1 — sha256:9acb86b407a3f94548a1a2bf9e716ecdfe5292a8ce30d3bd25397534d7719cde
- advanced-query-frontend:v0.10.0-alpha.1 — sha256:454efd8bb15fdd66bf49f318ff173af96d90ce07778654e97ad77450ed79a6ec

Both use the existing production Dockerfiles and locked npm ci installations.
No images were pushed or externally deployed.

## Reproduction and limits

Set TEST_DATABASE_URL, TEST_CUSTOMER_DATABASE_URL, TEST_UPGRADE_DATABASE_URL,
TEST_LEGACY_DATABASE_URL and TEST_V08_DATABASE_URL to separate disposable databases;
the upgrade databases must be fresh. Set V08_SOURCE_DIR to an archive of b6d1426
containing backend/shared, with backend dependencies available. Run backend
`typecheck`, `test`, `test:integration`, `build`; frontend `typecheck`, `test`, `build`.

Chromium uses E2E_PLATFORM_DATABASE_URL and E2E_CUSTOMER_DATABASE_URL with the
existing dedicated local dashboard_e2e_*_test naming constraints. The validation
configuration lives outside the checkout and retains the repository's single
worker, timeouts and zero retries, using the already built production frontend.
Build images from the root with the existing Dockerfiles. Validate Compose using
config --quiet and synthetic configuration; do not deploy.

Final raw local evidence: /tmp/v10-backend-unit.log,
/tmp/v10-release-integration.log, /tmp/v10-frontend-tests.log,
/tmp/v10-final-chromium.log, /tmp/v10-e2e-final-query.log,
/tmp/v10-backend-build.log, /tmp/v10-frontend-build.log,
/tmp/v10-backend-image.log, /tmp/v10-frontend-image-final.log,
/tmp/v10-compose.log and /tmp/v10-secret-scan.json. Earlier exploratory logs
are not the release gate results. The disposable PostgreSQL cluster was stopped
after validation. The bounded pattern scan checks changed
and untracked source/docs for eight credential/private-key families without
printing matches; it is not exhaustive secret detection.

No package/lockfile, migration, workflow source, applied hash/catalog/receipt
format, executor, service, ownership or metadata repository changed. Offset pages
can move across requests during concurrent writes. Unindexed queries may time out;
indexes are optional and planner use is not guaranteed. Existing transport limits
remain; no new URL byte cap is claimed. Timestamp filter inputs preserve
microseconds while existing response serialization retains its prior precision.
