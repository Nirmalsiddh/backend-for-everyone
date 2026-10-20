# Private Alpha Reliability & Recovery validation

Validated on 2026-10-20 with Node 24, PostgreSQL 18, production frontend builds and disposable customer/platform databases. No external production environment was changed. No optional config export, import, request-log UI or unrelated product feature was added.

## Implementation record

| Area                | Result                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential rotation | Owner-only same-target credentials route; immutable host/port/database/schema, candidate destination/TLS/capability/catalog inspection, optimistic revision check and shared setup lease. Failed validation retains old ciphertext. Database UI never displays the saved password.                                                                                                                      |
| Reconciliation      | Operator-only schema/auth PRE_STATE, POST_STATE and DIVERGED inspection. Dry-run default; explicit apply changes only platform metadata. Operation-bound encrypted catalog receipts prove post-state for new setup operations. Shared customer transaction locks prevent reconciliation from observing a false pre-state if the platform lease connection is lost. No DDL replay or arbitrary adoption. |
| Suspension          | Operator suspend/resume blocks new CRUD, workflows and all application-auth requests; owner dashboard remains available. Admitted transactions may finish.                                                                                                                                                                                                                                              |
| Restore             | Isolated verification suspends every project, revokes restored keys and platform sessions, and never contacts customer DBs. Explicit review/resume and new keys are required.                                                                                                                                                                                                                           |
| Key maintenance     | Offline old-key-to-new-key transactional credential re-encryption, decrypt preflight, persisted verification and fail-closed rollback. Historical backup keys must be retained separately.                                                                                                                                                                                                              |
| Recovery UX         | Code-aware uncertain-write guidance, no automatic mutation replay, operation-specific recovery, Retry-After guidance and allowlisted support details.                                                                                                                                                                                                                                                   |
| Request tracing     | UUID request IDs correlate Next adapter, Fastify, response/error and safe logs. Public proxy removes supplied IDs. Strict UUID propagation is limited to trusted peers. Runtime CORS exposes diagnostic headers.                                                                                                                                                                                        |
| Limits              | Shared customer admission/deadlines, small diagnostic/DDL category budgets, transactional quotas, process-local project rate limit, bounded request buffering and complete-response byte ceilings.                                                                                                                                                                                                      |
| Pending editors     | Submitted forms freeze; departed action callbacks are suppressed. Pending navigation warns, especially for one-time keys. Key metadata refreshes on return and explains revoke/recreate recovery.                                                                                                                                                                                                       |
| Readiness           | Current schema/auth/key/workflow blockers outrank historical success. Empty-writable PATCH has a warning and no misleading snippet. Individual healthy operations retain their own readiness. Docs deliberately fail closed for unavailable deployed contracts.                                                                                                                                         |
| Deployment          | Closed ingress before drain/backup/migration, exact migration compatibility, readiness and decrypt preflight, authenticated HTTPS smoke before reopening. Failure keeps maintenance and closes ingress; no automatic old-code fallback.                                                                                                                                                                 |
| Operator controls   | User disable/enable/session revocation, project suspension, reconciliation and encryption maintenance use safe CLI events without payloads or secrets.                                                                                                                                                                                                                                                  |

## Automated gates

- Clean backend/frontend installs completed.
- Backend typecheck, **72 unit/HTTP tests**, **57 PostgreSQL integration tests**, and build passed.
- Frontend typecheck, **44 focused tests**, production build, and **16 Chromium Playwright tests** passed. Final readiness and uncertain-error guidance changes also passed focused regressions and the production image build.
- Backend/frontend images, Compose publication/network/role validation, rendered disposable Compose config, Caddy configuration validation and shell syntax checks passed.
- Production dependency audits reported zero vulnerabilities. Existing development-only advisories remain outside the runtime images.
- The upgrade fixture creates pre-hardening migrations 0000–0006 and existing accounts/sessions/project/encrypted connection/applied table/policies/key/application auth/user/session/published workflow before applying migration 0007. Existing resources are exercised without recreation.
- Existing ownership, session revocation, workflow atomicity/concurrency, catalog drift, SQL safety, TLS/destination/DNS revalidation, OpenAPI and onboarding tests remain green.

## Disposable deployment and failure drills

- Real HTTPS signup/login → project → verified hosted PostgreSQL → table apply → key → CRUD → published workflow passed.
- Real pg_dump/pg_restore: a key revoked after the backup remained unusable after older-backup restore containment; restored sessions were revoked and projects stayed suspended. Restore validation had no customer network access. Containment commits before credential verification so even a missing/invalid encryption key leaves projects suspended and keys/sessions revoked; a subprocess integration regression covers this failure path.
- Offline encryption rotation passed; old-key preflight failed afterward, new-key preflight passed. A second corrupt-context record caused the whole rotation to fail with the earlier ciphertext unchanged.
- Real backend SIGKILL during schema Apply and auth provisioning left durable in-progress metadata. The CLI proved PRE_STATE and deliberately failed metadata without replaying DDL. POST_STATE and DIVERGED are covered against real catalogs and operation receipts in integration tests. The drill caught and fixed a persistence-field/plan-hash mismatch before release.
- A deliberately failing migration retained maintenance with ingress closed. A deliberately failing authenticated smoke gate did the same. Deliberate compatible deployments passed backup/migration/readiness/preflight/smoke before reopening.
- Customer DB unavailability produced a sanitized failure and recovered. Actual customer process loss during an admitted, lock-waiting INSERT rolled back; recovery confirmed no inserted/duplicate fixture row.
- Operator disable/enable/session revocation invalidated the existing dashboard session without resurrecting it on enable. Operator project suspension/resume blocked and restored runtime without deleting data.
- Platform DB outage kept liveness 200 while readiness became 503; recovery restored readiness 200.
- Actual invalid certificate trust was rejected with a sanitized TLS category. Destination DNS-answer changes and address-family failures are covered by deterministic policy tests; replacing hosted DNS infrastructure itself remains an operator drill.
- A live uncommitted DDL transaction held the customer setup lock; reconciliation waited and then classified POST_STATE after commit, independently of the platform lease.
- Real 16-client mixed-category socket test observed exactly 16 admitted customer sockets, rejected excess admission and verified release after an absolute deadline.
- Oversized runtime JSON failed before a partial response; HTTP project rate limiting returned 429 and Retry-After. Lost COMMIT responses, uncertain writes, expired/revoked credentials, stale workflows and delayed frontend responses are covered by focused tests.
- HTTPS request IDs matched response headers, error envelopes and backend logs; attacker-supplied IDs were replaced. Diagnostic runtime CORS exposure passed.
- A malformed management-URL fixture verified that invalid identifiers, request payloads and credentials never enter management events; event identifiers are UUID-allowlisted before logging.
- Service log scanning found no generated fixture password, DB credential, encryption key, runtime API key or platform cookie value.
- Firefox smoke passed platform login, authenticated Overview, accessible copy label, keyboard focus and 375px layout. Desktop Chromium remains the declared alpha authoring browser.

## Small-load measurements

These local HTTPS/container measurements are a baseline, not an SLA:

| Measurement             | Observed                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Overview                | Seven parallel metadata requests, 436 ms wall time; auth 404 was the expected unconfigured state.  |
| Schema list             | 17 queries for five tables, 583 ms; formula 2 + 3 × table count.                                   |
| Workflow list/readiness | Six queries for one workflow, 29 ms; formula 2 + 4 × workflow count.                               |
| OpenAPI snapshot        | Eight statements including transaction boundaries, 39 ms; no customer connection.                  |
| OpenAPI over HTTPS      | Five samples: 59, 159, 95, 112, 111 ms.                                                            |
| Customer sockets        | Shared ceiling of 16 observed; runtime/auth each ≤10 and diagnostic/schema/reconciliation each ≤2. |

The metadata list fanout is bounded by the alpha quotas. No caching or pool redesign was added. Observe latency, rejected admission, PostgreSQL connection pressure and process memory before tuning.

## Remaining risks and intentional limits

No known unresolved release-blocking P1 was identified by this validation. P2 limitations: single-instance process-local controls reset at restart; externally inserted huge values can consume memory before response-size rejection; baseline operations without authenticated recovery receipts may remain DIVERGED and require investigation; whole-document Docs availability intentionally fails closed. No generalized write idempotency exists: use unique business identifiers and inspect state before repeating uncertain writes. Offline key rotation requires the old key and retained historical backup keys.

Host power loss at the COMMIT boundary, real hosted DNS-provider changes, host firewall changes and provider certificate expiry should also be exercised in an operator-owned staging drill. Tests simulate lost COMMIT responses; killing a real process proved the pre-state recovery path, not every possible power-loss boundary.

## Exact private-alpha release checklist

- [ ] Select immutable backend/frontend image references and their matching migration set; rerun CI on the release commit.
- [ ] Restrict tester and smoke-operator source CIDRs, public runtime origins, approved remote PostgreSQL destinations and verified TLS. Confirm `/internal` is not public.
- [ ] Protect env/smoke/key files outside Git, verify backup encryption-key custody, take and validate a fresh platform backup, and retain old backup keys separately.
- [ ] Run decrypt preflight. Investigate failed record IDs and every applying/outcome_unknown schema/auth operation using dry-run reconciliation; never guess or replay DDL.
- [ ] Use the documented maintenance deploy. Require exact migration compatibility, backend/frontend readiness, preflight and authenticated smoke before reopening. On any failure remain closed.
- [ ] Repeat disposable restore containment and confirm old keys/sessions cannot authenticate, every project is suspended, and project review/resume/new-key issuance is deliberate.
- [ ] Exercise three disposable personas: API-key backend; browser auth plus owner isolation; multi-action workflow. Include revocation, stale dependencies, unavailable DB, uncertain writes and safe recovery.
- [ ] Check hosted PostgreSQL connection headroom for at most 16 admitted customer operations per backend process, plus database/operator connections. Alert before exhausting provider limits; do not add replicas without redesigning local limits.
- [ ] Review safe logs/request IDs, capacity/rate-limit behavior, backup schedule/retention and operator suspension access. Never request secrets or customer payloads for support.
- [ ] Confirm desktop Chromium authoring and 375px core access, then show the private-alpha notice and invite only noncritical/test-data use with customer-owned PostgreSQL backups.

See [RECOVERY.md](RECOVERY.md) for exact operator commands and deployment/rollback consequences. External invitation and environment-specific operator checks remain deliberate release actions.
