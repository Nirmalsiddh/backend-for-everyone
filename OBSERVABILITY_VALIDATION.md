# Observability validation

Implementation is uncommitted on main. The final summary hardening passes the requested private-alpha 100k release gate and all regressions. Original failures, saturated runs and the informational 250k limit are preserved below; this is not production-capacity approval.

Baseline was clean main at `7dcf6fd8116b1fd605aa530dfb40309572278dd7`, matching `v0.12.0-alpha.1`. No branch/worktree, commit, Git tag, or external deployment was created. Validation used Node 24 and disposable local PostgreSQL 18 databases.

## Regression gates

| Gate | Result |
| --- | --- |
| Backend typecheck | Passed |
| Backend unit/HTTP | 238 passed, zero failures/skips |
| Full PostgreSQL integration | 125 passed, zero failures/skips |
| Frontend typecheck | Passed |
| Frontend unit tests | 64 passed, zero failures/skips |
| Full Chromium Playwright | 23 passed |
| Backend/frontend production builds | Passed |
| Backend/frontend Docker images | Built locally |
| Compose validation | Passed with synthetic configuration; no deployment |
| Focused writer/runtime/history checks | 15 passed |
| PostgreSQL observability hardening | Four passed in full suite: failure isolation, writer cancellation/outage, management deadlines, exact summary correctness |
| Secret-pattern/environment-file scan | No findings; no environment files changed |
| `git diff --check` | Passed |

Full suites cover authentication, CRUD, rate limits, reliability, relationships/includes, managed indexes, advanced querying, TypeScript client generation/compilation, safe schema evolution, recovery, workflows, and Docs/Playground. Focused checks were repeated after input-validation and writer hardening.

The initial PostgreSQL run used trust authentication and therefore could not reject deliberately wrong credentials in an existing recovery test. The disposable server was changed to password authentication and the complete integration suite then passed. Early browser fixtures exceeded the existing project quota and assumed immediate successful telemetry reads. The final tests reuse owned projects and exercise manual refresh through bounded polling. No product quota or timeout was relaxed during that initial functional validation. The later management-read budget correction is documented below.

## Release-critical evidence

- A real customer INSERT commits exactly once while telemetry SQL fails. The successful response remains intact. A unique-conflict response remains 409 with its original public error code and request ID.
- An actually committed telemetry insert followed by simulated lost acknowledgement is not replayed. The event remains present exactly once.
- Queue bounds are 256 globally and 64 queued events per project, with one active batch of at most 32. Enqueue does no PostgreSQL work. Failed batches drop, including synchronous failures. A stuck writer drains only until the shutdown deadline.
- Success, 204, handled errors, unexpected errors, invalid credentials, suspension, rate/admission failures, timeouts, response-size rejection, and workflow failures produce at most one event. Unknown projects, management traffic, and OPTIONS produce none.
- JSON/Unicode/error/workflow/HEAD/204 response sizes match the produced payload. Arbitrary workflow business responses never supply telemetry error codes or payload data.
- Synthetic credentials, email/password, JSON values, filter values, cookies, user agent/origin, row identifiers, and workflow inputs/outputs are absent from event rows and observability output. Browser tests verify safe detail rendering and escaped text.
- Owner/project scoping applies to summary, pagination, and lookup. Runtime keys and app sessions cannot read management observability. Repeated request IDs return bounded matches. Cursor tampering, invalid fields, timestamps, UUIDs, versions, and filters fail safely. Tied timestamps paginate without duplicates.
- Expired events are invisible in every read, including exact lookup. Cleanup deletes at most 1,000 rows per transaction; an independently held advisory lock causes cleanup to skip. Server scheduling caps a run at five batches.
- SDK source/hash, runtime OpenAPI, table/physical/draft revisions, endpoint configuration, auth configuration, and published workflow metadata remain unchanged by observability. The actual SDK/OpenAPI comparison includes a 100k-event dataset.

## Migration and historical compatibility

Exactly one additive SQL migration, `0011_runtime_observability.sql`, creates the event table, checks, cascading project foreign key, and three secondary indexes. It contains no customer DDL. A real v0.12 platform upgrade preserves existing project/field metadata, creates an empty telemetry table, and verifies cascade deletion where other project restrictions do not apply.

Earlier v0.8-v0.11 fixture contents and migration SQL are unchanged. The new v0.12 fixture was generated through an archive of the actual v0.12.0-alpha.1 tag. It pins v4 default/fill/required-add plans and SDK hash/source. Historical hashes, receipts, pending-v3 recovery followed by v4 evolution, and v0.12 PostgreSQL evolution/recovery tests pass. Planner/catalog/default/fill/reconciliation source files were not changed.

## Performance and storage — original shared-pool configuration

Raw synthetic measurements are in [OBSERVABILITY_MEASUREMENTS.jsonl](OBSERVABILITY_MEASUREMENTS.jsonl). The explicit harness is `backend/tests/observability-performance.ts`; it requires a dedicated disposable `TEST_DATABASE_URL`. It truncates only the synthetic event fixture after checking for other projects' events. In the original runs, fixture setup used the ordinary platform pool and measured reads/writes used the shared telemetry budgets. The harness now uses the separated management read adapter for reads; earlier records remain unchanged. Fresh bulk and analyzed-statistics results are both retained. PostgreSQL planner statistics matter during ingestion.

Events are spaced one second apart for read measurements: a 100k-row table contains approximately 3,600 events in 1h and 86,400 in 24h. These are five-sample local observations, not capacity claims or load guarantees.

| Analyzed dataset | 1h summary p50/p95 | 24h summary p50/p95 | 7d summary p50/p95 |
| --- | --- | --- | --- |
| 1k / 10k | See raw successful samples | See raw successful samples | See raw successful samples |
| 100k | 9.3 / 21.2 ms | 193.5 / 202.4 ms among four successes; one timeout | Five timeouts; no successful sample |

At 100k, analyzed recent requests measured 8.7/60.4 ms and request-ID lookup 12.5/21.1 ms (p50/p95). Fresh bulk statistics also produced two failed samples each for recent requests and lookup. The management API returns a sanitized 503 when its budget is exceeded. Larger retained windows are therefore a known limitation; use narrower windows/manual refresh. No rollups, extra indexes, or increased product timeouts were introduced to hide the limit.

| Writer production rate | Events written | Peak queue | Enqueue p50/p95 | Average batch time |
| --- | --- | --- | --- | --- |
| 10/s | 20 | 1 | 5.3 / 77.3 microseconds | 2.7 ms |
| 50/s | 100 | 5 | 10.6 / 26.4 microseconds | 4.0 ms |
| 100/s | 200 | 10 | 9.8 / 21.1 microseconds | 4.1 ms |

These controlled two-second runs had zero drops/write failures and used one telemetry connection. The maximum observed batch was 10; the configured maximum of 32 and overload drops are separately tested.

Thirty interleaved real CRUD requests per mode, following three warmups, measured disabled p50/p95 93.3/146.4 ms and enabled 87.6/121.0 ms. Paired p95 difference was +59.7 ms, illustrating local timing variability. This does not establish a speedup or a production overhead bound. The disabled mode omits the sink; benchmark admission bypasses the rate limiter equally in both modes. Customer repository/executor/transaction work remains real. Request completion never awaits telemetry persistence.

| Synthetic events | Heap bytes | Index bytes | Total bytes |
| --- | --- | --- | --- |
| 1,000 | See raw samples | See raw samples | Approximately 434k |
| 10,000 | 1,638,400 | 1,843,200 | 3,481,600 |
| 100,000 | 16,089,088 | 18,235,392 | 34,324,480 |

The 100k sample is approximately 343 bytes/event, excluding WAL and subsequent dead-tuple/index growth. Metadata lengths affect size. WAL was not attributed because the local PostgreSQL cluster also hosted other test databases.

Cleanup of 1,000 expired rows measured 16.3/44.6 ms p50/p95. Concurrent cleanup, retained-event reading, and event insertion measured 48.1/59.6 ms, with five successful samples each. Customer traffic is never awaited by cleanup.

## Capacity limits

Seven-day retention is a visibility policy and cleanup target, not a hard disk ceiling. At the measured row size, five events/second extrapolates to roughly one GB/week per project before WAL/bloat. Rate-limit/auth failures can generate more telemetry than admitted requests. A single process's five-batch/five-minute cleanup budget averages at most about 16.7 expired events/second; sustained higher expiry rates can build a backlog. Multiple processes coordinate but do not establish a storage guarantee.

Before sustained higher-volume use, storage capacity and cleanup throughput need an explicit review. A future guard should drop telemetry independently of customer requests and use a reviewed disk/ingestion budget. No quota, sampling rule, external worker, or timeout increase was silently added. Large-window query timeouts and cleanup lag remain documented risks for this private alpha.

## v0.13 summary release-hardening progression

The original failures above remain release-blocking evidence for the original configuration. Investigation confirmed that owner reads, inserts and cleanup all shared the same two-connection telemetry pool and its 200 ms statement / 400 ms active deadline. This mistakenly applied a best-effort write budget to interactive owner reads.

The explicit `backend/tests/observability-summary-performance.ts` harness records full PostgreSQL `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans in `OBSERVABILITY_MEASUREMENTS.jsonl`, alongside the earlier measurements. Fixtures use synthetic structural metadata, twenty resources, five CRUD operations, all four status classes, exact integer durations, and one event per second. New runs include three error codes. The first diagnostic run used a single error-code bucket; its evidence is retained. Fixture generation is chunked; an initial 100k single-statement setup exceeded its diagnostic 5-second budget and was replaced with 1,000-row chunks. This did not change product limits.

At 100k, the original 7d plan scanned 100,000 retained events for grouping sets and scanned again for error codes. It used sequential scans for broad windows, a resource/operation external merge sort (604 temporary blocks), sorted/group aggregation, and a small final top-N/group sort. The 1h window used bitmap index/heap scans. No JIT was reported. Representative original 7d component execution times were: status-only 57 ms; exact array p50/p95 102 ms; per-operation p95/counts 214 ms; error codes 44 ms; combined summary 368 ms. The 24h combined plan was 266 ms (522 temporary blocks). The global percentile array already computes both percentiles together. Separate component queries would repeat scans without demonstrated total latency improvement. Full plan nodes include planning time, actual rows/loops, buffer hits/reads and temporary reads/writes.

The exact grouping-sets query and all indexes remain unchanged. A new bounded read adapter uses the existing management pool, without adding another pool. Its 1,000 ms statement budget provides headroom over the diagnostic 100k 24h p95 410 ms and 7d p95 342 ms. Acquisition is bounded at 250 ms; active work at 1,250 ms; lock wait at 100 ms. The adapter uses a read-only transaction and SET LOCAL, rolls back failures, sanitizes errors, and destroys overdue connections. Writer and cleanup budgets are unchanged. No index/storage write amplification was introduced.

A first final-profile run overlapped full backend checks, frontend tests and production compilation. At 100k, 24h had two timeouts and 7d three; 250k 7d had five timeouts. Those records are deliberately retained, rather than removed or represented as successful acceptance samples. Final isolated samples and cleanup contention are reported below when available. This bounded dashboard remains susceptible to CPU/I/O saturation; no claim of production capacity is made.

### Final summary acceptance (build/test jobs finished)

All timings below include the real repository ownership check and management read adapter, using the production management pool configuration. No statement budget is raised for these measurements. Five samples per window; p95 is the observed maximum for these small five-sample sets.

| Events | Window | Successes | p50 ms | p95 ms |
| --- | --- | --- | --- | --- |
| 10,000 | 1h | 5/5 | 27.45 | 63.15 |
| 10,000 | 24h | 5/5 | 48.51 | 71.40 |
| 10,000 | 7d | 5/5 | 45.40 | 56.50 |
| 100,000 | 1h | 5/5 | 13.99 | 20.48 |
| 100,000 | 24h | 5/5 | 245.05 | 344.92 |
| 100,000 | 7d | 5/5 | 377.65 | 468.43 |
| 250,000 | 1h | 5/5 | 13.18 | 17.16 |
| 250,000 | 24h | 5/5 | 354.08 | 462.33 |

The informational 250k 7d case succeeded 4/5. Its successful-sample upper median was 930.96 ms, maximum 979.46 ms; one query reached the unchanged final 1,000 ms management statement limit. It is not a 250k capacity approval. The 100k release gate passes all windows; heavy concurrent build load remains a demonstrated saturation case, retained above.

At 100k, five concurrent sets of 7d summary + bounded 1,000-row expiry cleanup + event INSERT all succeeded. Combined p50/p95 was 300.42/319.37 ms. Cleanup and insertion retained the original writer pool/budgets; reads used management connections. No large cleanup transaction or additional pool was introduced.

| Representative fixture | Table bytes | Index bytes | Total bytes |
| --- | --- | --- | --- |
| 10,000 | 1,662,976 | 2,400,256 | 4,063,232 |
| 100,000 | 16,408,576 | 24,027,136 | 40,435,712 |
| 250,000 | 40,992,768 | 59,539,456 | 100,532,224 |

The first 100k diagnostic fixture was 40,460,288 bytes; the final one was 40,435,712 (24,576 bytes smaller due to randomized index layout, not an index change). All four existing indexes remain unchanged. These distinct-request-ID/multiple-resource fixtures are about 404 bytes/event; the earlier repeated-request-ID/single-resource fixture was about 343 bytes/event. Different UUID entropy affects B-tree deduplication and metadata length affects row size. Neither difference represents hardening write amplification. The original repeated-ID fixture was also rerun: table 16,089,088 bytes, indexes 18,374,656, total 34,463,744 versus original 34,324,480 (139,264 bytes / 0.41% more, with the same indexes and ordinary randomized layout variation). WAL and cold-cache capacity were not measured.

The full regression rerun passed 450 tests: 238 backend unit/HTTP, 125 real PostgreSQL, 64 frontend and 23 Chromium. Both typechecks, both production builds, both local images and Compose validation passed. PostgreSQL checks include exact p50/p95, all status classes, operation/error grouping, retention, owner isolation, cursor/lookup/privacy, successful customer commit plus failed telemetry, original runtime error plus failed telemetry, and read cancellation/settings restoration. Unit tests cover late-acquisition release and destroying a stalled checked-out connection. Existing v0.8–v0.12 compatibility, pending-v3/v4 recovery, SDK/OpenAPI/revision invariance, auth, workflows, CRUD and schema evolution all passed again.

### Writer and cleanup regression after summary acceptance

| Rate | Written | Peak queued | Enqueue p50/p95 µs | Mean batch ms | Drops/failures |
| --- | --- | --- | --- | --- | --- |
| 10/s | 20 | 1 | 7.71 / 79.77 | 4.93 | 0 / 0 |
| 50/s | 100 | 5 | 9.28 / 24.60 | 3.43 | 0 / 0 |
| 100/s | 200 | 10 | 8.91 / 21.32 | 3.88 | 0 / 0 |

All controlled writer runs used one connection and at most ten events per batch. Queue configuration remains 256 global / 64 per project / 32 active batch / 100 ms flush. Cleanup alone passed 5/5 (10.43/17.47 ms); cleanup + recent read + insert passed 5/5 (33.12/125.25 ms). Writer failure, ambiguity, queue-full and runtime success/error isolation remain covered by the full suites. These short local runs are regression evidence, not production throughput guarantees.

### Release decision

**RELEASE-READY for the requested private-alpha 100k acceptance gate.** The 100k 24h and 7d summaries pass 5/5 under the final bounded management read budget, concurrent cleanup/insert passes, and all regression/build/image/Compose gates pass. The original failures and overloaded runs remain in the evidence. Informational 250k 7d timeouts and saturation under build load remain explicit limitations. No quota, aggregate table, cache, extra index, retention change, runtime deadline change, customer schema change, commit, tag or external deployment was introduced by this hardening.
