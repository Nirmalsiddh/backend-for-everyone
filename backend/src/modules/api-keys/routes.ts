import type { FastifyInstance } from 'fastify';
import { uuidPattern } from '../../config/env.js';
import type { ApiKeyService } from './service.js';
import type { KeyScope } from './types.js';
export async function apiKeyRoutes(app: FastifyInstance, options: { service: ApiKeyService }) {
  const path = '/projects/:projectId/api-keys';
  const project = { type: 'string', pattern: uuidPattern };
  const params = { type: 'object', additionalProperties: false, required: ['projectId'], properties: { projectId: project } };
  type Params = { projectId: string; keyId: string };
  app.post<{ Params: Params; Body: { name: string; scope: KeyScope } }>(path, { schema: { params, body: { type: 'object', additionalProperties: false,
    required: ['name', 'scope'], properties: { name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }, scope: { type: 'string', enum: ['read', 'read_write'] } } } } }, async (req, reply) => {
    const key = await options.service.create(req.params.projectId, req.platformPrincipal.userId, req.body.name, req.body.scope);
    return reply.code(201).header('cache-control', 'no-store').send(key);
  });
  app.get<{ Params: Params }>(path, { schema: { params } }, (req) => options.service.list(req.params.projectId, req.platformPrincipal.userId));
  app.delete<{ Params: Params }>(`${path}/:keyId`, { schema: { params: { type: 'object', additionalProperties: false, required: ['projectId', 'keyId'], properties: { projectId: project, keyId: project } } } }, async (req, reply) => {
    await options.service.revoke(req.params.projectId, req.platformPrincipal.userId, req.params.keyId);
    return reply.code(204).send();
  });
}
