import { operations } from './events.js';
import { ProjectError } from '../projects/service.js';
export const windows = { '1h': 3600000, '24h': 86400000, '7d': 604800000 } as const;
export interface Filters { window?: string; operation?: string; resource?: string; statusClass?: string; failuresOnly?: string; limit?: string; cursor?: string }
const invalid = () => new ProjectError(400, 'INVALID_REQUEST', 'Invalid observability query');
export function parseFilters(input: Filters, now = Date.now()) {
  const window = input.window ?? '24h';
  if (!Object.hasOwn(windows,window) || (input.operation && !operations.includes(input.operation as typeof operations[number])) ||
    (input.resource !== undefined && !/^[a-z][a-z0-9_\/-]{0,99}$/.test(input.resource)) ||
    (input.statusClass && !['2','3','4','5'].includes(input.statusClass)) ||
    (input.failuresOnly !== undefined && !['true','false'].includes(input.failuresOnly)) ||
    (input.limit !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(input.limit))) throw invalid();
  const filter = { window, operation: input.operation ?? null, resource: input.resource ?? null,
    statusClass: input.statusClass ?? null, failuresOnly: input.failuresOnly === 'true' };
  let anchor = new Date(now).toISOString();
  let last: { at: string; id: string } | null = null;
  if (input.cursor !== undefined) {
    try {
      if (input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw invalid();
      const c = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      if (Object.keys(c).sort().join(',') !== 'anchor,filter,id,last,version' || c.version !== 1 ||
        JSON.stringify(c.filter) !== JSON.stringify(filter) || typeof c.anchor !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.anchor) ||
        !Number.isFinite(Date.parse(c.anchor)) || new Date(c.anchor).toISOString() !== c.anchor || Date.parse(c.anchor) > now || Date.parse(c.anchor) < now - windows['7d'] ||
        typeof c.last !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.last) ||
        !Number.isFinite(Date.parse(c.last)) || new Date(c.last).toISOString() !== c.last || Date.parse(c.last) > Date.parse(c.anchor) ||
        Date.parse(c.last) < Date.parse(c.anchor) - windows[window as keyof typeof windows] ||
        typeof c.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(c.id)) throw invalid();
      anchor = c.anchor; last = { at: c.last, id: c.id };
    } catch { throw invalid(); }
  }
  return { filter, anchor, last, limit: Number(input.limit ?? 25), since: new Date(Math.max(now - windows['7d'], Date.parse(anchor) - windows[window as keyof typeof windows])).toISOString() };
}
export function nextCursor(parsed: ReturnType<typeof parseFilters>, at: string, id: string) {
  return Buffer.from(JSON.stringify({ version: 1, anchor: parsed.anchor, filter: parsed.filter, last: at, id })).toString('base64url');
}
export const eventProjection = `id, request_id AS "requestId", completed_at AS "completedAt", event_version AS "eventVersion",
  route_category AS "routeCategory", operation, resource, method, status, error_code AS "errorCode",
  duration_us::float8 / 1000 AS "durationMs", response_bytes::float8 AS "responseBytes", principal_kind AS "principalKind"`;
export interface QueryStore { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }> }
export class ObservabilityRepository {
  constructor(private readonly store: QueryStore) {}
  private async owner(projectId: string, ownerId: string) {
    const result = await this.store.query('SELECT id FROM projects WHERE id=$1 AND owner_id=$2', [projectId, ownerId]);
    if (!result.rows.length) throw new ProjectError(404, 'PROJECT_NOT_FOUND', 'Project not found');
  }
  async requests(projectId: string, ownerId: string, input: Filters) {
    await this.owner(projectId, ownerId);
    const p = parseFilters(input);
    const rows = (await this.store.query(`SELECT ${eventProjection} FROM runtime_request_events
      WHERE project_id=$1 AND completed_at >= $2 AND completed_at <= $3
      AND ($4::text IS NULL OR operation=$4) AND ($5::text IS NULL OR resource=$5)
      AND ($6::integer IS NULL OR status / 100=$6) AND (NOT $7::boolean OR status>=400)
      AND ($8::timestamptz IS NULL OR (completed_at,id)<($8::timestamptz,$9::uuid))
      ORDER BY completed_at DESC,id DESC LIMIT $10`, [projectId,p.since,p.anchor,p.filter.operation,p.filter.resource,p.filter.statusClass,p.filter.failuresOnly,p.last?.at ?? null,p.last?.id ?? null,p.limit+1])).rows;
    const items = rows.slice(0,p.limit); const end = items.at(-1);
    return { items, nextCursor: rows.length > p.limit && end ? nextCursor(p, new Date(end.completedAt).toISOString(), end.id) : null };
  }
  async lookup(projectId: string, ownerId: string, requestId: string) {
    await this.owner(projectId, ownerId);
    const rows = (await this.store.query(`SELECT ${eventProjection} FROM runtime_request_events
      WHERE project_id=$1 AND request_id=$2 AND completed_at >= now()-interval '7 days' AND completed_at <= now()
      ORDER BY completed_at DESC,id DESC LIMIT 100`,[projectId,requestId])).rows;
    if (!rows.length) throw new ProjectError(404,'NOT_FOUND','Request event not found');
    return { items: rows };
  }
  async summary(projectId: string, ownerId: string, window?: string) {
    await this.owner(projectId,ownerId);
    const p = parseFilters(window === undefined ? {} : { window });
    const counts = `count(*)::integer AS "recordedRequests", count(*) FILTER(WHERE status BETWEEN 200 AND 299)::integer AS "2xx",
      count(*) FILTER(WHERE status BETWEEN 300 AND 399)::integer AS "3xx", count(*) FILTER(WHERE status BETWEEN 400 AND 499)::integer AS "4xx",
      count(*) FILTER(WHERE status BETWEEN 500 AND 599)::integer AS "5xx"`;
    // Grouping sets share one input pass for global and per-operation statistics.
    const result = await this.store.query(`WITH retained AS NOT MATERIALIZED (SELECT resource,operation,status,error_code,duration_us FROM runtime_request_events WHERE project_id=$1 AND completed_at >= $2 AND completed_at <= $3),
      aggregates AS MATERIALIZED (SELECT resource,operation,grouping(resource,operation) AS level, ${counts},
        percentile_cont(ARRAY[0.5,0.95]) WITHIN GROUP(ORDER BY duration_us) AS latency
        FROM retained GROUP BY GROUPING SETS ((resource,operation),())),
      totals AS (SELECT "recordedRequests","2xx","3xx","4xx","5xx",latency[1]/1000 AS "p50DurationMs",latency[2]/1000 AS "p95DurationMs" FROM aggregates WHERE level=3),
      ops AS (SELECT resource,operation,"recordedRequests","2xx","3xx","4xx","5xx",latency[2]/1000 AS "p95DurationMs" FROM aggregates WHERE level=0 ORDER BY "recordedRequests" DESC,resource,operation LIMIT 20),
      errors AS (SELECT error_code AS "errorCode",count(*)::integer AS count FROM retained WHERE error_code IS NOT NULL GROUP BY error_code ORDER BY count(*) DESC,error_code LIMIT 20)
      SELECT row_to_json(totals) AS totals, (SELECT coalesce(json_agg(ops),'[]') FROM ops) AS operations,
      (SELECT coalesce(json_agg(errors),'[]') FROM errors) AS errors FROM totals`,[projectId,p.since,p.anchor]);
    const row = result.rows[0]!;
    return { window: p.filter.window, asOf: p.anchor, ...row.totals, topOperations: row.operations, topErrorCodes: row.errors };
  }
}
