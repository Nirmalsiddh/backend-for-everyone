# Schema Relationships & Foreign Keys MVP validation

Validated locally on Node 24 and disposable PostgreSQL 18. No external VPS or real customer database was used. No production secrets or new dependencies were introduced.

## Results

| Check | Result |
| --- | --- |
| Backend clean install, strict typecheck, production build | Passed |
| Backend unit/HTTP | 76 passed |
| PostgreSQL integration, including baseline upgrade/recovery | 69 passed; no skips |
| Frontend clean install, typecheck, production build | Passed |
| Frontend focused tests | 47 passed |
| Complete Chromium Playwright suite | 17 passed; no retries |
| Backend and frontend Docker images | Built successfully |
| Compose network/port/role configuration check | Passed |
| Local image migration and service restart acceptance | Passed |
| Application container fixture-secret scan | Passed |

The browser suite exercised Reference selection, applied target selection, required initial references, locked applied settings, friendly preview, actual Apply, CRUD configuration, key creation, valid and nonexistent references, restricted deletion, UUID filtering, visible Docs guidance and raw UUID Playground input. Existing onboarding, ownership/auth, pending mutation/navigation, one-time secret and 375px/keyboard tests remained green. The final browser rerun reused the already-built production Next.js artifact; its temporary config changed only the web-server startup command to skip a redundant rebuild.

An initial combined run correctly hit the existing platform signup limit after the extra relationship test created a sixth account from the same IP. The relationship test now reuses a normally authenticated fixture account through ordinary UI login when available; product limits remain unchanged. An initial heavily parallel build/test run also exhausted a test's explicit 250 ms deadline during connection establishment. That test now permits 1 second including connection establishment, still proving cancellation of a 2-second operation. The product's admission/deadline settings were not relaxed. The final backend suite passed serially.

## Safety coverage

- UUID-only, same-project/connection applied targets; no self-reference, cycles, uniqueness, defaults or owner-field references. An unapplied target draft does not alter the bound applied revision.
- Transactional RESTRICT / NO ACTION / NOT DEFERRABLE foreign keys and deterministic managed B-tree indexes. Required initial fields and nullable additions preserve existing data rules.
- Missing/retargeted/unvalidated/extra FKs, wrong delete action, changed deferrability, missing/disabled enforcement triggers, missing/changed indexes and target catalog drift fail closed.
- Verified managed incoming enforcement triggers do not rewrite or falsely drift the parent snapshot. A parent workflow published before its child remains usable; directly changed child revisions require republish.
- Both PostgreSQL 23503 and the tested RESTRICT path's 23001 become the same sanitized 409 RELATIONSHIP_CONFLICT. Workflow violations roll back earlier writes.
- PRE/POST/DIVERGED reconciliation includes authenticated receipts, exact FK/index/enforcement state and bound target catalogs. Missing columns/constraints/indexes, disabled triggers or absent receipts cannot finalize POST_STATE. Reconciliation never replays DDL.
- The baseline fixture now starts with migrations through 0007 (v0.6), populates existing resources, then applies current migrations without recreating those resources. Login, ownership, CRUD, keys, application authentication, workflows, Docs, credential recovery, suspension and restore containment pass. Existing field relationship values remain NULL.

## Container persistence acceptance

Built `private-alpha-backend:relationships-mvp` and `private-alpha-frontend:relationships-mvp`. Migrated an empty disposable platform database with the compiled image command. Through normal authenticated HTTP APIs, created an account/project, customer connection, customers and orders tables, applied the FK/index, configured CRUD, issued a key and inserted related rows. Verified before and after restarting both application containers:

- Backend readiness and persisted exact decimal/UUID rows.
- Parent deletion returns 409 RELATIONSHIP_CONFLICT.
- The existing project key and platform session still work.
- Applied OpenAPI describes the reference.
- Frontend login and the management adapter retain relationship metadata.

This used loopback HTTP and separate disposable platform/customer databases. It is not a hosted TLS/deployment acceptance claim. Docker application logs were scanned in memory against the generated fixture key/session/encryption key and synthetic passwords/DB URL without printing their values. Disposable containers, databases and temporary credential files were removed afterward; built images were retained locally.

## Intentional boundary

No self-reference, cycles, unique/one-to-one references, cascade/set-null, external/auth-table targets, arbitrary unique keys, backfills, destructive FK changes, joins/expansion, nested writes, customer-row pickers, graph or GraphQL. References enforce existence, not shared ownership or access to related records. Existing whole-document Docs fail-closed behavior for stale workflows is retained.
