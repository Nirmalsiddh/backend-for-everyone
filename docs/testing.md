# Testing and evidence

Run commands from the repository root unless a section says otherwise. Use Node.js 24 LTS. Install both packages with `npm ci --prefix backend` and `npm ci --prefix frontend`. Historical results below describe earlier checks; they are not a claim that this checkout has just passed every gate.

## Routine checks

```sh
npm run typecheck --prefix backend
npm test --prefix backend
npm run build --prefix backend
npm run typecheck --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
git diff --check
```

Unit/HTTP tests use Node's test runner, Fastify injection and focused component rendering. They do not require live PostgreSQL. Builds compile production code; they do not prove runtime persistence or hosted acceptance. Migration changes use `npm run db:generate --prefix backend`; review generated SQL/journal before applying with `npm run db:migrate --prefix backend`. Startup never substitutes for an explicit migration step.

## PostgreSQL integration

Privately configure `TEST_DATABASE_URL` and `TEST_CUSTOMER_DATABASE_URL` for two distinct disposable databases, separate from `PLATFORM_DATABASE_URL` and every saved product connection. Then run:

```sh
npm run test:integration --prefix backend
```

The platform role must apply migrations. The customer database needs an existing `public` schema and permissions for fixture DDL/CRUD. Local fixtures use non-TLS connections and must enforce password authentication, preferably SCRAM: trust authentication cannot prove rejection of incorrect passwords. Tests apply migrations and create/delete records and schemas. Never use development application data, production databases or real customer targets. Integration files run sequentially to avoid competing setup.

Optional historical tests require additional inputs:

| Input | Requirement |
| --- | --- |
| `TEST_LEGACY_DATABASE_URL` | Separate empty database for legacy platform-auth upgrade |
| `TEST_UPGRADE_DATABASE_URL` | Separate empty database for pre-hardening upgrade/recovery |
| `TEST_V08_DATABASE_URL` + `V08_SOURCE_DIR` | Separate fresh database and exact archived v0.8.0-alpha.1 source (`b6d1426`), including backend/shared with dependencies resolvable |
| `TEST_OBSERVABILITY_UPGRADE_DATABASE_URL` | Separate empty database for the v0.12-to-observability upgrade |

Some cases skip without their explicit inputs; inspect the test summary rather than describing a partial run as complete historical coverage. Start each upgrade fixture with its required empty database.

Pinned history artifacts live in [schema-history fixtures](../backend/tests/fixtures/schema-history/). The [generator](../backend/tests/fixtures/prepare-schema-history.ts) requires `V12_HISTORY_DIR` containing actual tagged archives in `v08`, `v09`, `v10`, `v11`, with backend dependencies resolvable. It executes tagged planners/query/compiler/client sources; never regenerate old expected hashes through the current planner. Run from `backend/` with `node --import tsx tests/fixtures/prepare-schema-history.ts` only when deliberately regenerating/reviewing fixture changes. The v0.12 fixture also pins field-evolution and SDK compatibility.

## Browser acceptance

Install Playwright's declared browser from the frontend package:

```sh
cd frontend
npx playwright install chromium
cd ..
```

Set `E2E_PLATFORM_DATABASE_URL` and `E2E_CUSTOMER_DATABASE_URL` privately for two distinct **local disposable** databases. The harness accepts only `127.0.0.1`/`localhost` and database names matching `dashboard_e2e_[a-z_]+_test`. The role must migrate platform metadata and create customer schemas. Do not substitute application database URLs or saved product connections.

```sh
npm run test:e2e --prefix frontend
```

For the Guided Builder acceptance test:

```sh
npm run test:e2e --prefix frontend -- tests/e2e/taskforge.spec.ts --reporter=line
```

The [configuration](../frontend/playwright.config.ts) starts backend/dashboard servers on 3010/3011, applies platform migrations and uses a random customer schema and test encryption key. It does not edit backend `.env`. Test data remains in the supplied databases; remove the dedicated databases after inspection. Default runs use one worker and zero retries. Fixture accounts/projects must respect unchanged signup/project limits; concurrent runs can interfere with those limits.

The Guided Builder acceptance test disables screenshots, video and traces to avoid recording the key. Other failure screenshots may contain disposable test data; traces are disabled. Keep test artifacts private and avoid recording credentials or one-time key dialogs. Distinguish synthetic-response UI checks from real API acceptance. Check actual widths 1280, 960, 768 and 375, keyboard progression/focus, dialogs and overflow when presentation changes. Focused checks do not establish formal WCAG or browser-zoom certification. Desktop Chromium is the declared alpha authoring browser; Firefox smoke is limited coverage.

## Coverage worth preserving

- Platform signup/login/logout, owner-scoped projects, expiry/revocation, generic credential failures and separation of all three credential channels.
- Connection encryption, rejected passwords, same-target rotation, hosted destination/DNS/TLS policy, quotas, admission cleanup and absolute cancellation.
- Schema constraints, stale revision/hash rejection, exact catalog drift, transactional rollback, historical plans/receipts and PRE/POST/DIVERGED recovery.
- Schema evolution precision, false/zero/empty-string values, NULL-only fills, default/fill separation, FK/unique/permission enforcement, rollback at each execution stage, and preservation of later customer edits during reconciliation.
- Managed index logical/physical revisions, deterministic concurrent-writer barriers and lock timeout behavior without raising product deadlines.
- CRUD scalar validation, SQL parameterization, owner/admin policy matrices, revoked/wrong-project keys, required/default semantics and bounded response sizes.
- Query operator/type matrices, malformed/duplicate filters, JSON-array IN boundaries, timezone/microsecond precision, exact bigint/decimal strings and owner-narrowing predicates.
- Relationship target authorization, hidden/null targets, pagination before expansion, metadata-fence changes, drift, complete response limits and fixed 1/2/3 data queries for 0/1/2 includes.
- Generated client positive/negative strict compilation, real compiled HTTP calls, credential separation, exact contract freshness, JSON-null behavior, disabled/unusable methods and safe transport/protocol errors.
- Workflow branch scoping, guarded concurrent stock decrements, atomic error-response rollback, stale publication and suspension.
- Runtime history privacy, owner-scoped reads, exact percentiles/status groups, retention/cursors, queue bounds, failed/ambiguous telemetry without customer replay, and read/writer deadline isolation.
- UI dirty/pending navigation, late responses, DTO redaction, one-time secrets, persistence after restart and matching Ready recognition after reload.

## Manual product and deployment checks

Start with the [Guided Builder usage flow](../README.md#try-the-guided-flow), then exercise broader product behavior:

1. Verify unauthenticated `/projects` redirects to login. Sign up without automatic login, sign in, create a project, and reload. A second account must neither list nor open the first account's project.
2. Check HttpOnly/SameSite/Path/lifetime and, over HTTPS, Secure/`__Host-` cookies. No platform token should appear in readable cookies, browser storage or login JSON. Logout must revoke the previous session.
3. With disposable customer data, create `products` with required `title` and optional ordinary UUID `owner_id`; preview/apply, enable CRUD, issue a read/write key and exercise POST/list/get/PATCH/delete.
4. Enable/provision application auth, sign up two users and configure owner policies. Alice's row must be hidden from Bob's reads/mutations; ownership is injected and cannot be transferred through PATCH. Test admin bypass only when explicitly configured.
5. Create a key-only POST workflow that inserts a product then branches on a boolean input to response 201 or 422. Save, preview, publish and enable. The 201 path must commit; 422 must roll back the earlier insert. Separately exercise guarded stock-decrement concurrency.
6. Revoke the key, disable a workflow and confirm unauthorized/unavailable behavior. Reload metadata; secrets must not reappear.
7. Exercise Reference selection, actual FK Apply, valid/nonexistent references and restricted parent deletion. Restart backend/frontend and verify the original session/key, exact scalar rows, reference metadata and constraints still work.
8. Open Docs, download OpenAPI and select an operation in Playground without auto-sending. Use `cd backend` then `npm exec -- validate-api /path/to/project-openapi.json` to validate an exported document with the existing dependency.

For hosted checks, use the protected configuration and commands in [deployment](../deploy/README.md) and [recovery](../deploy/RECOVERY.md). Build production images from the root with the existing Dockerfiles; validate Compose using `./deploy/compose.sh config --quiet` with synthetic or protected configuration. Rendering config is not deployment acceptance. Never print rendered secret values or enable verbose credential-bearing HTTP traces.

Before external testers, exercise verified HTTPS, narrow ingress/probe CIDRs, public `/internal`/health rejection, forged forwarded headers, hostile Origin, CORS, verified remote TLS/destinations, readiness during platform outage, and original credentials/resources after application restart. Use three disposable personas: key-only backend, application-auth/ownership and workflow-heavy app.

Failure drills include real backend interruption during Apply/provision, customer process loss during a write, dry-run PRE/POST/DIVERGED reconciliation, project suspension, user disable/revocation, backup restore containment, old/new-key preflight and atomic offline encryption rotation. A failing migration/readiness/decryption/smoke gate must leave ingress closed. Scan actual service logs against synthetic fixture secrets without printing them; a bounded pattern scan alone is not exhaustive secret detection.

Restore in an isolated network with no customer access. Verify checksum/matching migrations/key, suspended projects, revoked restored keys/platform sessions and no resurrection of a key revoked after backup. Wrong-key failure must retain containment. Platform backups are not synchronized customer backups. External DNS/ACME, provider/IPv6 firewall, off-server encrypted upload, real remote DB access, DNS/certificate changes and host power loss around COMMIT require environment-specific staging checks; local fixtures do not prove them.

## Recorded evidence

The following is a condensed historical record from the former validation reports, not new execution. Their full reports remain in Git history before this consolidation.

- **Guided Builder acceptance:** isolated local PostgreSQL 18 confirmed Tasks Apply, all five runtime operations, explicit key creation, POST 201 and GET/list of the same task ID/values. Reload reached Ready with zero configuration writes. Readable cookies/localStorage/sessionStorage did not contain the plaintext key. Later presentation checks used synthetic responses and did not rerun that database flow.
- **Schema/index/query/client checks:** prior full PostgreSQL runs covered upgrade/recovery, exact tagged legacy formats, real compiled clients, scalar precision, owner isolation and independent include authorization. Historical frontend/backend/browser totals varied by release and should not be treated as current counts.
- **Deployment validation (2026-10-18) and recovery drills (2026-10-20):** disposable Docker/HTTPS environments verified non-root images, private networking, separate bootstrap/migrator/app roles, application-role DDL denial, migration gates, original-session persistence, backup/isolated restore, process interruption, offline rotation, log-secret absence and failure containment. Local CA and synthetic isolated TLS fixtures did not validate public ACME or an external VPS. GitHub-hosted CI/registry publication was not established by those local checks.
- **Relationship persistence:** disposable compiled containers retained session/key use, reference metadata, exact rows and restricted deletion after restart. This was loopback HTTP acceptance, not hosted TLS evidence.
- **Observability final historical regression:** 238 backend unit/HTTP, 125 PostgreSQL, 64 frontend and 23 Chromium tests passed in the recorded observability run, alongside typechecks/builds/local images/Compose. These are historical counts, not this checkout's current gate results.

### Benchmarks and interpretation

The tables below retain useful local observations from the retired reports. Samples used disposable PostgreSQL 18 and shared local hardware; concurrent load, planner statistics, garbage collection and fixture shape affect results. They are not SLAs, cold-cache capacity tests or promises of index use. Product timeouts were not enlarged to make schema/query measurements pass. No pooling/caching optimization should be justified from these single samples alone.
### Managed index Apply

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

### Query counts and advanced-query samples

Real managed relationships and actual related rows, with an advanced range plus
UUID membership predicate. The lookahead row is not expanded. These are data
queries only; session/catalog/transaction/platform work is additional.

| Page size | No includes | One include | Two includes | Admission after |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 2 | 3 | 0 |
| 25 | 1 | 2 | 3 | 0 |
| 100 | 1 | 2 | 3 | 0 |

#### Advanced-query observations

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

### Client generation

Single local samples below include real owner-scoped platform PostgreSQL snapshot
retrieval. Synthetic applied metadata contains no customer data. Measurements are
validation observations under concurrent local testing, not latency guarantees.

| Schema | Snapshot ms | Contract ms | Render ms | Total ms | Source bytes | JSON bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 table × 10 fields | 103.4 | 42.5 | 1.7 | 147.6 | 10,526 | 11,043 |
| 20 × 20 | 130.8 | 316.0 | 18.1 | 464.9 | 108,033 | 115,521 |
| 20 × 100 | 142.9 | 752.6 | 52.3 | 947.9 | 400,833 | 430,721 |
| 20 × 100, relationship-heavy acyclic schema | 102.2 | 618.6 | 58.4 | 779.3 | 518,955 | 560,281 |

A separate legal 20×100 acyclic relationship fixture with all table/field names
63 characters produced approximately 1.51 MB source / 1.55 MB JSON and compiled
strictly. In-memory contract/render generation measured 1,280.3 ms; this sample
excludes database retrieval. Normal project quotas are 20 tables/100 fields per
table. Restored projects exceeding current quotas may produce larger downloads.
No new small output limit or caching/persistence was added.

The original expanded OpenAPI construction reached roughly 25 seconds for the
heavy fixture under load. SDK now uses compact mode in the same CRUD builder,
omitting unused inline include response schemas and documentation examples.
Per-generation metadata signature reuse avoids repeatedly validating the same
related target projection. Both are ephemeral computation only. Ordinary OpenAPI
output retains its existing full response documentation.

### Field evolution

[Raw measurements](../SAFE_SCHEMA_EVOLUTION_BENCHMARKS.csv) use actual Apply planning, durable operation, bounded schema executor, receipt and metadata finalization. Instrumentation records lock wait, UPDATE duration (including failed statements), DDL, catalog/control/receipt time, customer transaction and total Apply duration, UPDATE rowCount, rollback and admission cleanup. Nullable ADD DEFAULT has zero UPDATE rowCount; this is not a claim that zero historical rows gain a default.

At 100k rows, total Apply / customer transaction milliseconds:

| Case | Total | Customer transaction | Outcome |
| --- | ---: | ---: | --- |
| Future default only | 688 | 111 | Applied |
| Nullable add + default | 284 | 38 | Applied |
| Requiredness, no NULL | 342 | 80 | Applied |
| Partial NULL + fill | 1,121 | 809 | Applied |
| All NULL + fill | 2,344 | 1,891 | Applied |
| Required add + default | 1,649 | 1,397 | Applied |
| Required add + fill | 2,000 | 1,610 | Applied |
| Required add + different fill/default | 2,215 | 1,923 | Applied |
| Unique conflict | 409 | 32 | SCHEMA_DATA_INVALID; rolled back |
| Reference fill | 5,018 | 4,625 | Applied |

All recorded cases released admission. Constant-default additions at every size preserved relfilenode and reported `atthasmissing=true` on this server. Correctness relies on the transaction/catalog/receipt, not storage optimization. No benchmark increased timeouts; 100k happened to fit existing limits in this local run.

### Relationship reads

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

### Observability measurements

[Raw retained measurements](../OBSERVABILITY_MEASUREMENTS.jsonl) include original failures, overloaded runs, EXPLAIN plans and final isolated samples. [Writer/read/storage harness](../backend/tests/observability-performance.ts) and [summary harness](../backend/tests/observability-summary-performance.ts) require an explicitly disposable `TEST_DATABASE_URL` and migrated platform schema. They truncate synthetic telemetry fixtures and are unsuitable for a shared database even though they check for existing events.

With the dedicated database privately configured, run from `backend/`:

```sh
node --import tsx tests/observability-performance.ts
node --import tsx tests/observability-summary-performance.ts
```

The summary harness appends to the tracked measurement artifact; review new evidence separately from historical results. `SUMMARY_SIZES` selects fixture sizes (default 10k, 100k, 250k). These benchmarks are explicit tools, not part of the normal test glob.

The original shared writer/read configuration timed out for all five 100k 7d summaries; original analyzed 24h had one timeout. Owner reads now have a bounded management-pool adapter; writer/cleanup budgets and indexes remain unchanged. Final historical isolated 100k samples succeeded 5/5 for each window: p50/p95 13.99/20.48 ms (1h), 245.05/344.92 ms (24h), 377.65/468.43 ms (7d). Five concurrent summary/cleanup/insert sets passed at 100k. p95 here is the maximum of only five samples.

The informational 250k 7d case succeeded 4/5 and hit the 1,000 ms statement limit once. Heavy concurrent builds also caused timeouts at 100k. These are demonstrated availability limits, not discarded samples. Final short writer checks at 10/50/100 events per second wrote 20/100/200 events over two seconds with no drops/failures; they do not establish sustained throughput.

Different synthetic fixtures used roughly 343–404 bytes/event before WAL/bloat. At five events/second, the earlier estimate is roughly one GB/week/project before WAL/bloat. The five-batch/five-minute expiry budget averages at most about 16.7 expired events/second per process; retention is a read policy and cleanup target, not a disk cap. PostgreSQL vacuum and storage/cleanup monitoring remain necessary. WAL attribution and cold-cache capacity were not measured.

Historical schema/client benchmark artifacts remain linked above. [Field-evolution CSV](../SAFE_SCHEMA_EVOLUTION_BENCHMARKS.csv) includes 40 service/executor/receipt/publication cases at 0/1k/10k/100k rows. The 100k cases fit that local run's bounds; correctness depends on transactions/catalogs/receipts, not PostgreSQL fast-default storage optimization.

For baseline platform profiling, inspect schema-list fanout (1 project + 1 table list + 3 reads/table), repeated workflow readiness reads and fresh customer connections/catalog checks. Earlier small-load observations and controls are described in the [recovery runbook](../deploy/RECOVERY.md#release-gate-and-manual-drills). Measure representative latency, query counts, rejected admission, connection pressure and process memory before changing architecture.
