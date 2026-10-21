# Runtime observability (v0.13 alpha)

The owner-only Observability page records best-effort runtime request history. It observes CRUD, application signup/login/me/logout, and published workflows. Management requests and OPTIONS preflights are excluded. Unknown projects produce no events. Known-project invalid credentials, suspension, rate limiting, admission rejection, and handled errors can produce events after trusted project resolution. Requests rejected before project resolution may be absent.

## Recorded metadata

One version-1 event contains a storage UUID, resolved project UUID, existing request ID, completion timestamp, bounded category/operation, resolved resource/workflow name, method, actual HTTP status, public error code, monotonic duration in integer microseconds, optional serialized payload bytes, and principal kind (`project_key`, `app_user`, `anonymous`). There is no general JSON metadata column. Resource names are developer-managed platform metadata. All event metadata is plaintext in the platform database.

Never recorded: credentials, headers, cookies, passwords, email, user/session/key IDs, request or response bodies, customer rows/row IDs, raw URLs/paths/query strings, filters/field names/values, SQL, driver messages, exceptions/stacks, connection information, IP, user agent, origin/referer, or workflow steps/input/output. Existing operational logs remain separate; the telemetry writer does not copy their broader metadata.

## Semantics

`X-Request-Id`, public error `requestId`, and event request ID match. Trusted forwarded request IDs may repeat, so exact owner/project-scoped lookup returns up to 100 matches. Expired requests are invisible everywhere, including lookup. Copy an API response request ID into exact search; no global or free-text search exists.

Counts mean **recorded requests**, not guaranteed traffic, billing, or usage quotas. 2xx, 3xx, 4xx, and 5xx are reported separately. A 4xx can be an expected application/client response. Workflow-defined business error bodies are never inspected for codes; their code can be null.

Latency measures server handling from the runtime hook through response completion using a monotonic clock. p50/p95 display milliseconds. It is not client/network latency or customer-DB timing. Response bytes count already-serialized application payload bytes (zero for HEAD/204/304), not network-wire bytes or proof of delivery. Unsupported payloads have null size. Interrupted requests may have no completion event.

## Best-effort asynchronous persistence

The request completion hook only builds an immutable safe event and enqueues it. It never awaits telemetry PostgreSQL. The writer timer flushes at most 32 events every 100 ms through one active path. Memory holds at most 256 queued events globally and 64 queued events per project, plus one active batch. Incoming events drop under pressure. There is no disk spill, durable queue, replay, or retry of failed/ambiguous batches. Customer operations are never retried because of telemetry. Telemetry failure cannot roll back a customer commit or replace its response.

A dedicated writer/cleanup pool has at most two platform connections: acquisition 100 ms, statement 200 ms, lock 50 ms, query/active-connection deadline 400 ms. Destroying an expired connection cancels outstanding work. Failure/drop counters and rate-limited fixed server log messages are operational diagnostics, not recursively recorded events. Shutdown allows approximately one second to drain queued work before dropping the remainder.

## Retention and query bounds

Retention target is seven days, not a hard event-count or storage quota. All reads enforce retention even while physical deletion lags. A five-minute lifecycle timer deletes at most five batches of 1,000 oldest expired rows per run, with a nonblocking transaction-scoped advisory lock across processes and bounded database execution. Cleanup is independent of traffic; failures are logged safely and tried on a later timer. PostgreSQL vacuum remains necessary, and DELETE does not immediately shrink files.

Windows are `1h`, `24h` (default), and `7d`. Summaries directly aggregate retained events, including top 20 operations and public error codes. No rollups. Recent requests use descending completion-time/UUID keyset pagination, default 25 and maximum 100. Cursor input is strictly validated and bound to the chosen window/filters; route owner/project scope always wins. Retention can remove events during pagination. Requests support operation/resource/status-class/failure filters. Refresh is manual.

## Limits

At five requests/second, one process/project can generate over three million requests/week; rejected traffic can exceed admitted traffic. The queue bounds memory, not disk. Cleanup throughput and available disk must be assessed against measured traffic. Seven-day cleanup may lag after outages or sustained heavy traffic. This private-alpha feature makes no production-capacity or complete-history guarantee. See OBSERVABILITY_VALIDATION.md for local evidence and remaining gates.

No customer migration, schema Apply/catalog/receipt changes, contract changes, workflow staleness, SDK management methods, or schema revisions are introduced. Deferred: tracing/spans, exporters, metrics systems, alerts, charts, live logs, bodies/SQL/identity tracking, billing/quotas, custom retention, exports, DB timings/query counts, and aggregate tables.

## Operational notes

Apply the platform migration through the existing migration lifecycle before starting the new backend. Its existing role-provisioning step grants access to the new platform table. No customer schema Apply is needed.

Signup/login remain anonymous for the request itself. Successful `auth.me` establishes `app_user`; logout remains anonymous when its idempotent revocation does not establish a principal. CRUD/workflows record a principal kind after successful authentication.

Refresh to see newly persisted events. Cursor ordering is stable, but asynchronous arrivals and retention mean paging is not a transactional snapshot. Management reads have a separate bounded budget, described below. Heavy CPU/I/O contention or larger retained datasets can still return a sanitized observability-unavailable response. The validation report preserves both the original failures and release-hardening evidence.

## Management read isolation

Owner observability reads use the existing platform management pool (maximum ten connections), separately from the two-connection telemetry writer/cleanup pool. Each read acquires within 250 ms, runs in a read-only transaction with a 1,000 ms statement timeout and 100 ms lock timeout, and destroys its connection after a 1,250 ms active-operation deadline. Late acquisition is released without running SQL. Transaction-local settings reset before a healthy connection returns to the management pool. Each repository call checks ownership separately before its data query, so the acquisition/active bounds apply to each of those two queries, rather than constituting a single HTTP deadline.

The writer retains its 100 ms acquisition, 200 ms statement, 50 ms lock and 400 ms active-operation limits. Runtime completion still only enqueues local metadata. No request waits for event insertion or cleanup. Dashboard reads can contend with other management work and PostgreSQL CPU/I/O, but do not occupy writer pool connections. Timeouts remain sanitized availability errors; overload does not guarantee dashboard availability.
