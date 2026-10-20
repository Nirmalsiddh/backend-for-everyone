# TypeScript Client & Types Generation MVP — v0.11.0-alpha.1

The project Docs page generates one standalone `<project-slug>-client.ts` file.
Generate/Refresh, inspect, copy or download it. Generation is owner authenticated,
on demand, and writes neither platform/customer metadata nor server files.

## Contract and freshness

The generator reuses deployed CRUD/auth OpenAPI builders, applied table metadata
and v0.10 query capabilities. It never reads application rows, credentials or
schema drafts. Unrelated stale workflows do not block generation; inconsistent
CRUD/auth/applied/relationship metadata does. Workflow execution and ordinary
OpenAPI readiness remain unchanged.

`SDK_CONTRACT_HASH` fingerprints the public row/input/method/policy/query/include/
auth contract. `SDK_GENERATOR_VERSION` identifies the renderer contract.
`SDK_TABLE_REVISIONS` contains logical diagnostic provenance, not a freshness
protocol. Endpoint policies/enablement and auth/signup settings can change output
without changing table revisions. Regenerate after those changes or an applied
API contract change. Draft-only edits and normal non-unique index Apply leave
source byte-identical. Physical revisions, index catalogs, origins, default
literal values, timestamps and internal IDs are excluded. No runtime negotiation.

## Types

UUID, text, varchar, bigint, decimal, date and timestamp use `string`; integer uses
`number`; boolean uses `boolean`; JSONB uses recursive `JsonValue`. Bigint and
decimal strings preserve exactness. Timestamp query strings retain timezone and
microseconds; response serialization remains the runtime's existing behavior.

`Row_<table>` includes generated `id` and every applied field. SQL nullable scalar
fields include `null`. JSONB read types allow JSON null even for SQL NOT NULL
columns. JSON null and SQL NULL have the same JavaScript representation; writes
still reject top-level null for nonnullable JSONB, while nested JSON null is valid.
JSON depth/size, finite numbers and scalar validation remain server enforced.

Create inputs come from deployed request schemas: generated IDs/injected owners
are absent; requiredness/default optionality matches the server. Empty create uses
`Record<string, never>`. Updates exclude protected fields and use `AtLeastOne`.
Enabled PATCH with no writable fields is omitted and listed in
`SDK_OMITTED_OPERATIONS`. DELETE resolves `void` for 204. Read/create/update return
rows; list returns `{ data, pagination: { limit, offset, hasMore } }`.

## Usage

```ts
const client = createClient({
  baseUrl: 'https://api.example.test/api/my-project',
  getSessionToken: () => applicationSessionToken,
});
await client.resources['products'].list({
  filter: { price: { gte: '100', lte: '500' }, category: { in: ['A&B', 'ACME, Inc.'] } },
  sort: 'price', direction: 'asc', limit: 25,
});
```

Available resources/methods/fields depend on the deployed project. Only enabled,
usable methods are emitted. SDK equality uses explicit `eq`; HTTP legacy equality
remains unchanged. UUID/id: eq/neq/in. Numeric fields: eq/neq/gt/gte/lt/lte/in.
Date/timestamp: eq/neq/gt/gte/lt/lte. Text/varchar: eq/neq/in. Boolean: eq/neq.
Nullable non-JSONB fields additionally support is_null. JSONB has no filters.

All clauses combine with AND, maximum five. IN is 1–25 values, encoded as one JSON
array of strings through the shared canonical URLSearchParams serializer; integer
IN converts each integer to a string. Bigint/decimal never pass through Number.
NULL checks use booleans. Server validation remains authoritative.

Single sort, limit 1–100 (default 25), offset 0–10000, deterministic ID tie-breaking
and lookahead remain unchanged. Includes permit at most two one-level relationship
field names. Raw UUID FKs remain; `Read_<table>._related` is optional and target
values are plain target rows or null. Parent filtering/pagination precedes expansion;
target authorization remains independent. Ownership is enforced by the server.

## Credentials and transport

`apiKey` and `getSessionToken` are separate channels selected per deployed policy.
Key-only methods require a `pk_` project key; authenticated/owner methods require a
`us_` application session. Neither substitutes for the other. Dashboard sessions
are never used. Public signup/login send neither credential. Auth helpers appear
only for ready enabled auth; signup additionally requires signup enabled. Login
returns `{token, expiresIn, user}` without storing it; logout revokes the supplied
session without changing application storage. No cookies/localStorage/sessionStorage.

Use user sessions for user-specific browser access. Project keys are shared
credentials without per-user ownership. Keep write keys on trusted servers/BFFs;
read-only keys remain shared credentials. Generated source contains no real secrets.

Requires ES2022 and standard web fetch, URL, URLSearchParams and AbortSignal typings
(modern browser/Node/Next.js). `baseUrl` is the runtime project root and preserves
path prefixes; query, fragment and userinfo are rejected. Row IDs are UUID checked
and encoded. Per-request options support only `signal`. Fetch omits cookies and
rejects redirects. No retries or arbitrary header overrides.

`ApiError` carries status/code/safe message/requestId; non-JSON HTTP errors receive
a generic message. `TransportError` means the response could not be confirmed.
`ProtocolError` covers unexpected success status or invalid/empty JSON. 204 is
handled without parsing. A failed or uncertain write does not prove rollback.

## Management and exclusions

`GET /internal/projects/:projectId/sdk/typescript` accepts no query parameters,
requires platform ownership, returns no-store JSON containing filename,
generatorVersion, contractHash, tableRevisions and source. This is a management
route for downloading a runtime client; the generated client has no management API.

No migrations, persistence, publishing, packages, framework hooks, workflow helpers,
recursive/include-dependent types, other languages, realtime, ORM, automatic retry,
offline cache, token persistence, schema negotiation, plugins or arbitrary templates.
