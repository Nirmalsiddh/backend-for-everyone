# Private Alpha Reliability & Recovery

Use compiled operator commands from the matching backend image. Operator database access is privileged; no operator endpoint is exposed through the dashboard. Protect all env/key/config files outside Git. Never pass secret values in argv. Commands default to dry-run; `--apply` changes metadata. Output is restricted to identifiers, classifications, counts, timestamps and safe outcomes.

## Same-target credentials

Database → Update database credentials preserves host, port, database and PostgreSQL schema exactly. Only username/password and verified-TLS selection are accepted. Hosted destination policy still applies. The candidate must pass read-only capability/catalog inspection before the encrypted credential is replaced. No DDL or customer data is changed. Failed candidates leave the previous credential intact. Active or uncertain setup blocks rotation; refresh after a concurrent-change error. Credentials need schema USAGE/CREATE, managed-table ownership and the required read/write privileges. A read-only database is reported separately. Arbitrary target moves remain unsupported.

## Suspend/resume and user controls

Examples below use `docker compose` through the protected deployment wrapper:

```
./deploy/compose.sh exec -T backend node dist/operations/operator.js project suspend --project UUID
./deploy/compose.sh exec -T backend node dist/operations/operator.js project suspend --project UUID --apply
./deploy/compose.sh exec -T backend node dist/operations/operator.js project resume --project UUID --apply
./deploy/compose.sh exec -T backend node dist/operations/operator.js user disable --user UUID --apply
./deploy/compose.sh exec -T backend node dist/operations/operator.js user enable --user UUID --apply
./deploy/compose.sh exec -T backend node dist/operations/operator.js user revoke-sessions --user UUID --apply
```

Suspension rejects NEW CRUD, workflow and application-auth requests with PROJECT_SUSPENDED. Owner management remains available. Already admitted work may finish. Disabling a platform user revokes their platform sessions; it does not implicitly suspend their projects. Suspend those projects separately for containment. Resuming after disaster recovery requires explicit project review and new API keys.

## Uncertain setup reconciliation

1. Capture project ID, migration ID (Schema Advanced details), or auth configuration ID (operator metadata). To identify uncertain auth operations without secrets, run the following read-only query in the platform database: `SELECT project_id, id, provisioning_status FROM project_auth_configs WHERE provisioning_status IN ('provisioning', 'outcome_unknown');`. Stop repeating the failed setup request.
2. Run dry-run inspection with the configured original encryption key:

```
./deploy/compose.sh exec -T backend node dist/operations/operator.js reconcile schema --project UUID --operation MIGRATION_UUID
./deploy/compose.sh exec -T backend node dist/operations/operator.js reconcile auth --project UUID --operation AUTH_CONFIG_UUID
```

3. Review PRE_STATE, POST_STATE or DIVERGED and the recommended action. Repeat the exact command with `--apply` only after review.

A project advisory lease serializes the entire Apply/provision/credential-update/reconciliation interval across processes. A shared customer transaction lock additionally prevents inspection of an uncommitted false pre-state if the platform lease connection is lost. If SETUP_BUSY occurs, wait for the admitted operation to finish or stop the crashed backend before investigation. The command reads actual catalogs within a read-only transaction. PRE_STATE permits a deliberate retry by marking setup failed; POST_STATE finalizes the recorded revision/catalog. DIVERGED remains blocked. No DDL is replayed, no object is deleted, and no arbitrary table is adopted.

New DDL transactions write encrypted, authenticated operation-bound receipts in table comments before committing. POST_STATE requires the receipt AND actual catalog to agree. A legacy uncertain operation without a valid receipt can be proven PRE_STATE or remain DIVERGED; do not force-adopt a lookalike table. Modifying/removing a receipt prevents automated POST_STATE reconciliation. Receipts are not runtime readiness checks. Resolve all uncertain setup before encryption-key maintenance.

## Restore containment

Keep ingress closed. Restore only into an isolated database/network using matching images, roles, migration history, checksum and the original encryption key. Run:

```
CONFIRM_ISOLATED_RESTORE=yes node dist/database/platform-db/verify-restore.js
```

This command never connects to customer databases. It verifies platform readiness, commits containment by suspending EVERY restored project, revoking EVERY restored project API key and invalidating EVERY restored platform session, then checks credential decryptability in memory. A later key/decryption failure leaves containment in place. A key revoked after the backup cannot regain access after this procedure. Reopening ingress does not resume projects. Developers must sign in again and issue replacement API keys. Review restored account-disabled state, auth settings, workflow publication and customer schema alignment before deliberately resuming each project. Customer application sessions live in customer DBs; invalidate them there when incident scope requires it.

A platform backup is not a synchronized customer-data backup. Restoring older metadata can leave customer catalogs newer. Never automatically reverse customer DDL or republish an old workflow. Customer data backups remain the developer's responsibility.

## Encryption preflight and maintenance-window rotation

```
./deploy/compose.sh exec -T backend node dist/operations/operator.js preflight
```

Preflight does not contact customer databases. It reports total checked, decryptable count and failed record IDs only. Global platform readiness remains independent of customer credential decryptability; deployment preflight deliberately gates reopening on a clean result.

For rotation:

1. Close ingress, stop backend/frontend and confirm no setup operation remains uncertain.
2. Take a platform backup, validate it, and retain its original key independently.
3. Supply the OLD key through the operator container env. Mount a mode-0600 file containing the NEW 64-hex-character key; set NEW_CONNECTION_ENCRYPTION_KEY_FILE to its container path.
4. Run `node dist/operations/operator.js encryption rotate --maintenance-confirmed --backup-confirmed` for dry-run, then add `--apply`.
   For example, with the old key still in the protected deployment env and a new-key file readable only by the backend container UID:

   ```
   ./deploy/compose.sh run --rm --no-deps \
     -e NEW_CONNECTION_ENCRYPTION_KEY_FILE=/run/new-connection-key \
     -v /protected/new-connection-key:/run/new-connection-key:ro \
     backend node dist/operations/operator.js encryption rotate \
     --maintenance-confirmed --backup-confirmed --apply
   ```

5. The command refuses live application DB connections and unresolved setup. It locks all credential rows, decrypts every record before committing, re-encrypts under the new key, increments revisions, and verifies persisted ciphertext inside the same transaction. Any failure rolls everything back.
6. Update the backend's protected CONNECTION_ENCRYPTION_KEY environment to the NEW key. Run preflight with it, start matching services, pass the smoke gate, then reopen ingress.

Never rotate automatically at startup or merely replace the env value. Keep historical keys for retained backups. If verification fails, remain in maintenance and investigate; do not start the backend with a guessed key.

## Limits and failure semantics

One backend process only. Defaults: 3 projects/account; 20 tables/project; 100 custom fields/table; 10 active keys/project; 10 workflows/project. Workflow limits remain 30 steps, 10 DB steps, 5 tables and condition depth 3. Quota checks serialize concurrent creations. Runtime rate: 5 requests/second/project with burst 20 and Retry-After: 1. Auth limits remain separate. Health traffic is excluded.

All fresh customer clients share 16 slots. Runtime and application auth each allow at most 10; schema, diagnostics and reconciliation each at most 2, subject to the shared total. Admission waits at most 250 ms. Customer connection/query deadlines are absolute: runtime/auth/schema/reconciliation 10 seconds, connection diagnostics 8 seconds; hosted DNS is separately bounded by 3 seconds. Slots release in finally. No Redis, pools or background jobs are added.

Ingress bodies are at most 64 KiB, with platform credential requests capped at 4 KiB. Next reads bounded chunks before buffering further. CRUD responses are capped below 1 MiB inside the transaction, with a 1 MiB serialization ceiling. Workflow response/context bounds remain 256/512 KiB. Oversized results fail; JSON is never silently truncated. Prefer smaller list pages. Fresh-client row materialization can still create memory pressure from externally inserted huge values; use noncritical bounded test data and restricted roles during alpha.

WRITE_OUTCOME_UNKNOWN and lost HTTP responses are NEVER automatically replayed. Inspect application state/business IDs before repeating POST/PATCH/workflows. For duplicate-sensitive integrations, use an explicitly unique business/request field and transactional workflow guards. No generalized idempotency service is provided.

Docs remain fail-closed as a whole when deployed metadata, enabled auth or an enabled workflow is unavailable. The UI links to concrete recovery pages; it does not silently omit unhealthy operations. No-writable-field PATCH has no generated usable example and is not marked ready.

## Deployment maintenance and smoke gate

Set MAINTENANCE_DIR to the same absolute protected directory in shell and DEPLOY_ENV. Configure SMOKE_OPERATOR_CIDRS as exact, narrowly scoped probe source IPs, also approved by TESTER_CIDRS. Never use all tester networks or a public-all CIDR. The marker directory is mounted read-only into Caddy. Its `enabled` file survives restarts and returns maintenance 503 to everyone except the explicit smoke operator.

SMOKE_CONFIG is a mode-0600 JSON outside Git containing appOrigin, apiOrigin and an existing operator platform email/password. The gate logs in, makes an authenticated management read, checks private routing isolation and frontend readiness, and logs out. It creates no project or customer data. Bootstrap the first platform account from the approved operator source while maintenance remains active, then rerun deployment.

Deploy stops Caddy first, sets the marker, drains/stops applications with a bounded grace period, backs up, migrates, starts matching services, checks readiness and decryption preflight, starts Caddy in maintenance, runs authenticated smoke, and only then removes the marker. A failed migration/readiness/preflight/smoke leaves ingress closed and the marker present. Do not automatically restart old images against changed metadata. Roll forward or restore deliberately. Customer DDL is not rolled back by image rollback.

## Release gate and manual drills

Before external testers: all backend/frontend/integration/Playwright/build/image/Compose checks must pass. Exercise credential failure/success, setup PRE/POST/DIVERGED, suspension/resume, old-key restore containment, offline key rotation, connection saturation, response limits, delayed edits/navigation, platform outage and migration mismatch. The upgrade fixture builds pre-hardening migration 0000–0006 metadata and verifies it after current migration without recreating resources; it represents the v0.5-era product surface, not an invented release tag.

Use three disposable customer DBs for key-only backend, browser auth/ownership and workflow-heavy personas. Test invalid TLS and DNS changes under hosted policy, real process interruption around COMMIT, HTTPS maintenance/probe allowlists, backup restore and customer privilege changes. Tests simulate lost commit/deadlines; historical backend and customer DB interruption drills are summarized in [testing](../docs/testing.md#recorded-evidence). Host power-loss boundaries remain a manual staging drill.

Desktop Chromium is the declared alpha authoring browser. Check keyboard focus, dialogs, status/copy announcements, and 375px core forms. Firefox smoke is best-effort, not advertised full support. Ask support for project ID, request ID, timestamp, operation and error code only. Never request credentials, DB URLs, request bodies, returned customer data or SQL.

Observe request counts/latency, safe capacity categories and process memory before tuning. Schema list is 1 project + 1 table-list + 3 reads/table; workflow list currently repeats owned/workflow/table readiness reads. Overview uses seven metadata queries. OpenAPI is an owned repeatable-read metadata snapshot with no customer DB connection. Do not add caches or pooling without measurements.

## Relationship Apply recovery

Relationship plans use version 2 context in `schema_migrations.plan_context`: bound target applied revisions, identities and catalogs. Relationship child catalogs carry version 2 structured FK state. The recovery encryption envelope remains version 1; its authenticated content includes that versioned catalog. Historical relationship-free plans, catalogs and receipts retain their original hash/comparison rules; NULL relationship metadata is omitted when reconstructing old fields.

Use the existing dry-run `reconcile schema --project ... --operation ...` command. POST_STATE requires the authenticated receipt, exact field/FK/index/enforcement state, and unchanged valid target dependencies. Missing/disabled enforcement, a UUID column without its constraint/index, wrong targets, or an absent receipt cannot finalize success. PRE_STATE requires exact pre-state. DIVERGED remains blocked: investigate; never replay DDL or rebaseline/adopt objects. Adding a managed incoming FK does not rewrite the parent's definition/catalog receipt: only structurally verified managed enforcement triggers are excluded from its local comparison. Unexpected relationships/triggers remain drift.

Keep the existing migration maintenance gate, backup/key custody, restore containment, suspension, credential preflight and operator reconciliation procedures. For the supported relationship/expansion contract see the [platform reference](../docs/platform-reference.md#managed-reference-fields).
