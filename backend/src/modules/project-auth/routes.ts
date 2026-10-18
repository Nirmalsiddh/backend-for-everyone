import type { FastifyInstance } from 'fastify';
import { uuidPattern } from '../../config/env.js';
import type { AuthInput, Role } from './types.js';
import type { AuthService } from './service.js';
export async function projectAuthRoutes(app: FastifyInstance, options: { service: AuthService }) {
  const path = '/projects/:projectId/auth';
  const uuid = { type: 'string', pattern: uuidPattern };
  const params = { type: 'object', additionalProperties: false, required: ['projectId'], properties: { projectId: uuid } };
  const revision = { type: 'integer', minimum: 0, maximum: 2147483645 };
  type Params = { projectId: string; userId: string };
  app.get<{ Params: Params }>(path, { schema: { params } }, (req) => options.service.get(req.params.projectId, req.platformPrincipal.userId));
  app.put<{ Params: Params; Body: AuthInput }>(path, { schema: { params, body: { type: 'object', additionalProperties: false,
    required: ['enabled', 'signupEnabled', 'expectedRevision'], properties: { enabled: { type: 'boolean' }, signupEnabled: { type: 'boolean' },
      sessionLifetimeSeconds: { type: 'integer', minimum: 300, maximum: 604800 }, expectedRevision: revision } } } },
    (req) => options.service.configure(req.params.projectId, req.platformPrincipal.userId, { ...req.body, sessionLifetimeSeconds: req.body.sessionLifetimeSeconds ?? 86400 }));
  app.post<{ Params: Params; Body: { expectedRevision: number } }>(`${path}/provision`, { schema: { params, body: { type: 'object', additionalProperties: false,
    required: ['expectedRevision'], properties: { expectedRevision: revision } } } }, (req) => options.service.provision(req.params.projectId, req.platformPrincipal.userId, req.body.expectedRevision));
  app.patch<{ Params: Params; Body: { role: Role } }>(`${path}/users/:userId/role`, { schema: {
    params: { type: 'object', additionalProperties: false, required: ['projectId', 'userId'], properties: { projectId: uuid, userId: uuid } },
    body: { type: 'object', additionalProperties: false, required: ['role'], properties: { role: { type: 'string', enum: ['user', 'admin'] } } },
  } }, (req) => options.service.setRole(req.params.projectId, req.platformPrincipal.userId, req.params.userId, req.body.role));
}
