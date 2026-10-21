# v0.12.0-alpha.1 validation

Baseline verified before edits: clean real `main` checkout at `29276af5a250413700babe67525190ae79749dd2`, identical to peeled `v0.11.0-alpha.1`. No worktree, branch or external deployment was created. Validation used Node 24.21.0 and disposable local PostgreSQL 18.4 databases. No product limits/timeouts were increased.

| Gate | Result |
| --- | --- |
| Backend strict typecheck / production build | Passed |
| Backend unit/HTTP, including historical fixtures | 225 passed |
| Full PostgreSQL integration | 107 passed, 0 failed; 2 optional upgrade cases exercised separately |
| Historical upgrade/recovery run | 13 passed, 0 skipped |
| Capability / exact-delta / encoding fixtures | 2 passed on SQL_ASCII, 2 passed on UTF8 |
| Frontend strict typecheck / production build | Passed |
| Frontend unit tests | 63 passed |
| Full Chromium | 21 passed |
| Backend/frontend local images | Built successfully |
| Compose rendering | Passed; no deployment |
| Secret-pattern scan / whitespace | Passed; final 41-file scan found no secret patterns |

The two optional integration skips were the empty-database v0.6 and legacy platform-auth upgrade cases. Both ran successfully in the separate historical run, together with actual-tag v0.8 relationship/receipt recovery. The full run also exercised actual-tag v0.8 migration recovery. Test totals above are per invocation, not a deduplicated aggregate.

Initial validation failures were corrected rather than accepted: local customer fixtures were configured to require passwords; obsolete nullable-default rejection assertions were updated while frozen legacy rejections remained; test DTOs stopped sending internal index properties; benchmark fixtures cleaned up within the unchanged 20-table quota; a fill-leak assertion was made value-specific instead of accidentally matching `legacy_eq`; and browser locators were corrected to use actual accessible names. A browser run under concurrent heavy gates timed out on an existing mocked Loading page; subsequent worker restarts encountered unchanged authentication limits. The final isolated full Chromium run passed all 21 tests. Focused Chromium acceptance was repeated after final confirmation/catalog changes and after editor refresh handling changed. It also proves external publication clears intent without increasing the draft revision.

## Acceptance evidence

| Report item | Implemented behavior / evidence |
| --- | --- |
| A — transitions | Nullable add + literal default; supported default add/change/remove; requiredness with optional fill; required addition with fill/default/both. No standalone fill. |
| B — defaults | text/varchar/integer/bigint/decimal/boolean; real PostgreSQL constants and exact drift verification. Date/timestamp defaults deferred; UUID/reference/JSONB excluded. |
| C — fills | Same scalar types plus date/timestamp/ordinary UUID/managed references. Requiredness only; SQL NULL only. |
| D — metadata | One additive migration: nullable `schema_fields.backfill_intent`; existing records remain absent. No customer DDL in platform migration. |
| E — v4 design | One immutable field bundle and structured constant descriptors for deliberately transitioned fields; fill excluded from applied definition. |
| F — historical formats | Actual tagged v0.8/v0.9/v0.10/v0.11 plan/hash fixtures; frozen v3 planner selected explicitly during reconciliation. |
| G — execution order | PRE locks/verification → temporary nullable addition if needed → FK → parameterized NULL-only fill → NULL check → future default → NOT NULL → POST → authenticated receipt → COMMIT → publication. |
| H — concurrency | Existing admission, advisory and sorted table locks; real NULL writer waits and fails after enforcement; competing Apply rejected. |
| I — recovery | Authenticated POST publishes metadata without SQL replay; PRE is reviewed retry; intermediate-looking/no-receipt state is DIVERGED. |
| J — revisions | Field/default/requiredness evolution advances logical and physical revisions; normal indexes retain physical-only behavior. |
| K — workflows | Failed fill leaves dependent flow valid; successful evolution blocks dependent flow; unrelated flow remains enabled. |
| L — OpenAPI | Applied required/default optionality verified before/after changes; no historical fill history. Existing advanced-query metadata preserved. |
| M — SDK | Draft/failure source identical; value-only default change retains public hash while revision/source provenance changes; fill omitted. Actual v0.11 restored snapshot retains hash, provenance and byte-identical source. |
| N — UI | Typed fill/default controls, persisted reload, pre-save required-addition validation, structured preview and revision/hash-bound confirmation; no row-count claim. |
| O — normalization | Bounded constant/cast grammar; exact string bigint/decimal; unsupported expression/function shapes rejected. No expression execution. |
| P — precision | int32 bounds, int64 beyond Number.MAX_SAFE_INTEGER, decimal precision/scale, false/0/"0"/empty string, leap date and timezone/microseconds exercised. |
| Q — PostgreSQL | Real defaults/fills, missing default drift, requiredness, uniqueness/FKs and privilege enforcement. |
| R — rollback/recovery | Faults in fill, NULL check, default DDL, NOT NULL, POST verification and receipt; lost COMMIT acknowledgement and platform-finalization failure. A filled value edited afterward remains edited after reconciliation. |
| S — upgrades | Tagged relationship/hash/receipt restore; pending v3 POST recovery followed by v4; restored v0.10 exact query compilation; v0.11 SDK artifacts. |
| T — performance | 40 real service/executor/receipt/publication cases at 0/1k/10k/100k rows, including unique/reference interactions. See CSV. |
| U — regressions | Gate totals above include relationships/includes/indexes/advanced queries/client/workflow coverage. |
| V — data safety | Parameterized fill values; trusted types/quoted identifiers; sanitized errors; values absent from previews/logging/public clients. Values remain plaintext platform metadata, including immutable operation context. Typed text round trips reject truncation/incompatible encoding; UTF8 Unicode and SQL_ASCII rejection fixtures passed. |
| W — deferred | Standalone backfills, non-NULL overwrite, arbitrary predicates/SQL/expressions/code, JSONB evolution, renames/drops/type changes, transformations, queues/chunks/jobs/online migration. |
| X — risks | Blocking locks and unchanged deadlines limit large tables. Single local PostgreSQL version and synthetic workload are not a production capacity guarantee. External row triggers are excluded from fills. |

## Performance

[Raw measurements](SAFE_SCHEMA_EVOLUTION_BENCHMARKS.csv) use actual Apply planning, durable operation, bounded schema executor, receipt and metadata finalization. Instrumentation records lock wait, UPDATE duration (including failed statements), DDL, catalog/control/receipt time, customer transaction and total Apply duration, UPDATE rowCount, rollback and admission cleanup. Nullable ADD DEFAULT has zero UPDATE rowCount; this is not a claim that zero historical rows gain a default.

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

## Reproduction

From `backend/`: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:integration` with explicitly disposable `TEST_DATABASE_URL` and `TEST_CUSTOMER_DATABASE_URL`. Optional historical checks require their documented empty disposable upgrade URLs and an actual v0.8 tagged archive in `V08_SOURCE_DIR`.

Pinned artifacts live in `backend/tests/fixtures/schema-history/`. Their generator requires `V12_HISTORY_DIR` containing git archives of the four actual tags, with backend dependencies resolvable. It uses tagged planners/query/compiler/SDK sources, not the current v4 generator.

From `frontend/`: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` with the explicitly disposable local `dashboard_e2e_*_test` database URLs required by Playwright. Build local images using the repository Dockerfiles; render `deploy/compose.yaml` with the example environment for configuration validation only.
