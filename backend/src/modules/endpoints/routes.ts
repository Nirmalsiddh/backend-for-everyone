import type { FastifyInstance } from 'fastify';
import { uuidPattern } from '../../config/env.js';
import { operations, type EndpointInput } from './types.js';
import type { EndpointService } from './service.js';
export async function endpointRoutes(app: FastifyInstance, options: { service: EndpointService; ownerId: string }) {
  const params = { type: 'object', required: ['projectId', 'tableId'], additionalProperties: false,
    properties: { projectId: { type: 'string', pattern: uuidPattern }, tableId: { type: 'string', pattern: uuidPattern } } };
  const policy = { oneOf: [
    { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { type: 'string', enum: ['key_only', 'authenticated'] } } },
    { type: 'object', additionalProperties: false, required: ['mode', 'ownerFieldId', 'allowAdmin'], properties: { mode: { const: 'owner' }, ownerFieldId: { type: 'string', pattern: uuidPattern }, allowAdmin: { type: 'boolean' } } },
  ] };
  const path = '/projects/:projectId/schema/tables/:tableId/api';
  type Params = { projectId: string; tableId: string };
  app.get<{ Params: Params }>('/projects/:projectId/endpoints', { schema: { params: { type: 'object', required: ['projectId'], additionalProperties: false, properties: { projectId: params.properties.projectId } } } },
    (req) => options.service.list(req.params.projectId, options.ownerId));
  app.get<{ Params: Params }>(path, { schema: { params } }, (req) => options.service.get(req.params.projectId, options.ownerId, req.params.tableId));
  app.put<{ Params: Params; Body: EndpointInput }>(path, { schema: { params, body: { type: 'object', additionalProperties: false,
    required: ['enabledOperations', 'expectedAppliedRevision', 'expectedConfigRevision'], properties: {
      policies: { type: 'object', additionalProperties: false, properties: Object.fromEntries(operations.map((op) => [op, policy])) },
      enabledOperations: { type: 'array', uniqueItems: true, maxItems: 5, items: { type: 'string', enum: operations } },
      expectedAppliedRevision: { type: 'integer', minimum: 1, maximum: 2147483646 },
      expectedConfigRevision: { type: 'integer', minimum: 0, maximum: 2147483646 },
    } } } }, (req) => options.service.save(req.params.projectId, options.ownerId, req.params.tableId, req.body));
}
