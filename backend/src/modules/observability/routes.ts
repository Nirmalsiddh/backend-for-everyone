import type { FastifyInstance } from 'fastify';
import { ProjectError } from '../projects/service.js';
import { operations } from './events.js';
import type { Filters, ObservabilityRepository } from './queries.js';
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' };
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const string = { type: 'string' };
const number = { type: 'number' };
const object = (properties: Record<string, object>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const counts = { recordedRequests: { type: 'integer' }, '2xx': { type: 'integer' }, '3xx': { type: 'integer' }, '4xx': { type: 'integer' }, '5xx': { type: 'integer' } };
const event = object({ id: uuid, requestId: uuid, completedAt: string, eventVersion: { type: 'integer' },
  routeCategory: string, operation: nullable(string), resource: nullable(string), method: string,
  status: { type: 'integer' }, errorCode: nullable(string), durationMs: number,
  responseBytes: nullable(number), principalKind: string });
const array = (items: object) => ({ type: 'array', items, maxItems: 100 });
const queryProperties = { window: { type: 'string', enum: ['1h','24h','7d'] },
  operation: { type: 'string', enum: operations }, resource: { type: 'string', maxLength: 100, pattern: '^[a-z][a-z0-9_/-]*$' },
  statusClass: { type: 'string', enum: ['2','3','4','5'] }, failuresOnly: { type: 'string', enum: ['true','false'] },
  limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }, cursor: { type: 'string', minLength: 1, maxLength: 2048 } };
export async function observabilityRoutes(app: FastifyInstance, options: { repository: ObservabilityRepository }) {
  const base = '/projects/:projectId/observability';
  const params = object({ projectId: uuid });
  // Convert storage failures to a fixed management error, never driver details.
  const safe = async <T>(work: () => Promise<T>) => {
    try { return await work(); }
    catch (error) { if (error instanceof ProjectError) throw error; throw new ProjectError(503,'OBSERVABILITY_UNAVAILABLE','Observability is temporarily unavailable'); }
  };
  app.get<{ Params: { projectId: string }; Querystring: { window?: string } }>(`${base}/summary`, {
    schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { window: queryProperties.window } },
      response: { 200: object({ window: string, asOf: string, ...counts, p50DurationMs: nullable(number), p95DurationMs: nullable(number),
        topOperations: array(object({ resource: nullable(string), operation: nullable(string), ...counts, p95DurationMs: nullable(number) })),
        topErrorCodes: array(object({ errorCode: string, count: { type: 'integer' } })) }) } },
  }, (req) => safe(() => options.repository.summary(req.params.projectId,req.platformPrincipal.userId,req.query.window)));
  app.get<{ Params: { projectId: string }; Querystring: Filters }>(`${base}/requests`, {
    schema: { params, querystring: { type: 'object', additionalProperties: false, properties: queryProperties },
      response: { 200: object({ items: array(event), nextCursor: nullable(string) }) } },
  }, (req) => safe(() => options.repository.requests(req.params.projectId,req.platformPrincipal.userId,req.query)));
  app.get<{ Params: { projectId: string; requestId: string } }>(`${base}/requests/:requestId`, {
    schema: { params: object({ projectId: uuid, requestId: uuid }), querystring: object({}), response: { 200: object({ items: array(event) }) } },
  }, (req) => safe(() => options.repository.lookup(req.params.projectId,req.platformPrincipal.userId,req.params.requestId)));
}
