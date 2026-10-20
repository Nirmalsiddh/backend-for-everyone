# TypeScript Client MVP validation — v0.11.0-alpha.1

Validated locally on Node.js 24 and disposable PostgreSQL 18. Implementation used
clean real `main` baseline `750a6b9843085631da0082ac26d525f352a86182`.
No branch/worktree, migration, dependency, SDK persistence, external deployment,
image publication or customer production database was introduced.

## Regression gates

| Gate | Result |
| --- | --- |
| Backend strict typecheck and production build | Pass |
| Backend unit/HTTP | 213 passed, zero failures/skips |
| Full PostgreSQL integration | 102 passed, zero failures/skips |
| New PostgreSQL generation benchmark | 1 passed; 103 distinct integration tests across the full run and this added gate |
| Final focused PostgreSQL SDK/state/auth/runtime/performance | 28 passed; overlaps the integration totals above |
| Additional final compiled SDK/JSONB PostgreSQL runtime check | 12 passed; overlaps the integration totals above |
| Frontend strict typecheck and production build | Pass |
| Frontend unit tests | 59 passed, zero failures/skips |
| Full Chromium Playwright | 20 passed |
| Final focused Chromium SDK acceptance | 1 passed; overlaps the full browser total |
| Backend and frontend production images | Built locally, not published/deployed |
| Compose configuration | Pass with synthetic local values |
| Secret-pattern scan and git diff --check | Pass |

The full PostgreSQL suite includes upgrade/recovery, exact v0.8 upgrade, platform
and application auth, workflows, relationships, includes, managed indexes,
requiredness and advanced-query correctness/performance. Existing data-query counts
remain 1/2/3 for zero/one/two includes at page sizes 1/25/100, with admission cleanup.

Local evidence is in `/tmp/v11-*` logs (temporary validation evidence, not required
product state). Main gate logs: `v11-backend-milestone-tests.log`,
`v11-full-postgres.log`, `v11-sdk-postgres-final.log`,
`v11-frontend-unit-final.log`, `v11-full-chromium.log`,
`v11-sdk-browser-final.log`, `v11-performance-release.log`, and production build/image logs.

## Release-critical evidence

- Generated source compiles strict TypeScript without platform imports, including
  all scalars, application auth, one-level relationships, empty creates, unusable
  PATCH, awkward valid names and a relationship-heavy 20×100 fixture.
- Negative compile fixtures reject bigint/decimal number representations through
  scalar string mappings, bigint number filters, JSONB filtering, boolean IN,
  unknown sort/include, owner mutation, empty/undefined PATCH, recursive include
  and disabled/unusable methods.
- Real compiled SDK calls perform CRUD, equality/inequality, exact-number ranges,
  JSON-array IN, NULL checks, sort, pagination and relationship expansion over real
  runtime HTTP and PostgreSQL. Signup/login/me/logout and owner-narrowing work
  through the application-session channel. Key/session substitution is rejected.
- Real PostgreSQL also returns JSON null from a SQL NOT NULL JSONB column with
  a JSON-null default through the compiled SDK; an explicit top-level null write
  receives a sanitized 400.
- Applied snapshots remain byte-identical after draft edits. Browser acceptance
  performs an actual normal non-unique index Apply and asserts identical source.
  Applied field changes, endpoint toggles and auth/signup settings change output.
- A real stale workflow blocks ordinary Docs while healthy CRUD/auth SDK generation
  succeeds. Generated portions still reject incompatible auth/applied/relationship
  metadata. OpenAPI compact-projection parity is tested; default Docs behavior is
  preserved.
- Owner route tests cover missing auth, foreign/unknown project, query rejection
  and no-store. Metadata includes no internal IDs, physical revisions, default
  literal values, credentials, auth tables or workflow internals.
- Generated client errors cover HTTP 400/401/403/404/409/429/503/504, request-ID
  precedence/fallback, HTML/non-JSON errors, empty JSON success, network failure,
  204 and no retries. Credentials are omitted from cookies, redirects are rejected,
  path IDs are checked/encoded and invalid base URL userinfo is rejected.
- Chromium verifies preview as text, copy, safe filename/download, generation
  refresh, draft isolation, index invariance, endpoint/auth changes, a held request
  during project navigation, pending controls and stale-source removal on failure.
- Secret checks compare actual test keys/session/password/configuration/data values
  against generated source. Eight credential-pattern families are scanned in
  changed/untracked product files; no matches. No values are printed by the scan.

## Generation performance and output size

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

## Limits and remaining considerations

The SDK is static: regenerate after deployed public-contract changes. TypeScript
cannot prove credential scope, authorization, calendar validity or all scalar/
complexity bounds; runtime validation remains authoritative. JSON null and SQL NULL
share JavaScript null, while nonnullable JSONB writes still reject top-level null.
Fetch-compatible web typings are required. No hidden retries or rollback claims.
Workflow helpers, publishing, framework hooks, other languages, persistence and
runtime negotiation remain deferred. No unimplemented runtime capability is added.
