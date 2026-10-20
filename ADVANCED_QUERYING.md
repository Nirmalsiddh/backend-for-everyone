# v0.10.0-alpha.1 — Advanced Querying MVP

Generated GET list APIs accept a bounded typed filter language. Capabilities derive
only from applied fields; draft fields, requiredness and indexes have no effect.
No platform/customer migration, republication, or saved query state is needed.

## Public grammar

Decoded examples (encode requests using URLSearchParams):

```text
filter[name]=example
filter[name][eq]=example
filter[name][neq]=example
filter[price][gte]=100
filter[price][lte]=500
filter[category][in]=["pending","processing"]
filter[notes][is_null]=true
```

Legacy equality normalizes to `eq` internally with the same scalar behavior.
Field/operator names are case-sensitive. Only `filter[field]` and
`filter[field][operator]` are accepted; no dotted paths or deeper brackets.
Multiple clauses combine with AND. Different operators on the same field are
allowed; repeated normalized `(field, operator)` pairs, including legacy + explicit
eq, are rejected. Contradictory valid predicates return zero rows.

## Applied operator matrix

| Type | Operators |
| --- | --- |
| Primary key `id` | eq, neq, in |
| UUID and managed reference UUID | eq, neq, in |
| integer, bigint, decimal | eq, neq, gt, gte, lt, lte, in |
| date, timestamp | eq, neq, gt, gte, lt, lte |
| boolean | eq, neq |
| text, varchar | eq, neq, in |
| jsonb | None |

Nullable non-JSONB fields additionally support `is_null`. Required fields and `id`
do not. Owner fields remain filterable and sortable as in previous releases.

## Membership, NULL and scalar values

IN is **one query value containing a JSON array of 1–25 strings**. Each string
uses the field's ordinary scalar validation. Commas inside strings are data.
Numeric JSON primitives, null, objects, nested arrays, malformed JSON and empty
arrays are rejected. Duplicate elements are allowed and count toward 25 before
any deduplication. `[""]` is one valid empty text
value, not an empty list.

```js
const query = new URLSearchParams();
query.set('filter[name][in]', JSON.stringify(['ACME, Inc.', 'A&B', '雪', '']));
query.set('filter[price][gte]', '9007199254740993.00');
const response = await fetch(`${baseUrl}/products?${query}`, {
  headers: { Authorization: 'Bearer <PROJECT_API_KEY>' },
});
```

Encode keys and values once. Literal `+` (including timezone signs) becomes `%2B`;
unescaped `+` decodes as space. Do not manually join unescaped values or split IN
on commas. Docs and Playground share the deterministic query serializer.

`is_null=true` compiles to IS NULL; `false` compiles to IS NOT NULL. Other
comparisons, including neq, exclude NULL through PostgreSQL three-valued logic.
Text `eq=null` is literal text, never SQL NULL. NULL tests on non-nullable fields,
`id`, and JSONB are invalid.

Booleans accept only lowercase `true`/`false`. Integers fit int32. Bigint remains a
string with signed int64 bounds checked using BigInt. Decimal remains a string
validated against applied precision/scale, without Number conversion or rounding.
Date uses real YYYY-MM-DD calendar validation. Timestamp requires the existing
calendar/time syntax with Z or numeric timezone and up to six fractional digits.
Comparison inputs reach PostgreSQL as strings, retaining microseconds; response
serialization remains unchanged. Text/varchar retain existing length/NUL limits.

## Execution, authorization and bounds

- Maximum five user clauses, 25 IN elements per clause, one sort field, two includes.
- Default page 25, maximum 100; offset 0–10000; limit+1 determines hasMore.
- Existing `sort=field&direction=asc|desc`, NULLS LAST, and `id ASC` tie-break remain.
- User predicates AND the independent server owner predicate; they can only narrow
  authorized rows. Explicit existing allowAdmin policy is the only admin bypass.
- Parent filtering precedes sorting and pagination. Only returned parent rows are
  expanded. Target GET authorization remains independent; inaccessible/missing
  targets become null. Raw reference UUIDs and metadata fencing remain unchanged.
- 0/1/2 includes use 1/2/3 application-data queries, regardless of page/filter size;
  auth/catalog/control/platform queries are additional.
- Catalog/relationship/managed-index verification remains mandatory before data
  queries. Damaged expected objects fail closed, even for simple predicates.
- Filters work without an index. No indexes are created automatically and index use
  is never guaranteed. Query cost depends on data, selectivity and the planner.
- Existing admission/rate limits, 10-second customer operation deadline, at most
  2-second statement timeout, 1-second lock timeout, and 1 MiB response cap remain.
- No new query-string byte cap; existing scalar and framework/proxy limits remain.

Identifiers resolve to applied metadata; enum operators select developer-authored
SQL tokens; every scalar is parameterized. Workflows retain their separate query
semantics, hashes and publication state.

## Errors, Docs and Playground

New grammar uses sanitized 400 INVALID_FILTER, INVALID_SORT, QUERY_TOO_COMPLEX.
Legacy-only invalid requests retain INVALID_REQUEST. INVALID_INCLUDE and existing
auth, timeout, capacity, drift, unavailable and response-size errors remain.
Responses retain request IDs and do not disclose SQL, driver errors, field IDs,
physical names or supplied values. Query validation precedes the normal CRUD
executor; application-session authentication may already have used the customer DB.

OpenAPI preserves explicit legacy equality/pagination/sort/include parameters.
Additive `x-runtime-query` version 1 lists public applied capabilities and limits,
not every field/operator parameter. Clients ignoring it still receive valid
OpenAPI 3.1. Docs/examples are synthetic and require no customer-data reads.

Playground offers five bounded field/operator/value rows, an IN add/remove editor,
and an explicit NULL/non-NULL selector. Operator choices use applied capabilities.
Sorting, includes, credentials, request invalidation and explicit Send remain.

## Deferred

No arbitrary OR/nested logic, field comparisons, related-field filtering/sorting,
joins, one-to-many/recursive includes, prefix/contains/LIKE/ILIKE/regex/full-text/
trigram search, JSONB/path querying, cursor pagination, aggregation/count/group-by/
HAVING/DISTINCT, computed fields, GraphQL, SDKs, saved queries, analytics, multi-sort,
or workflow advanced filters.
