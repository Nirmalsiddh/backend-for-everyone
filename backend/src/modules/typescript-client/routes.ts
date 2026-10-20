import type { FastifyInstance } from 'fastify';
import { uuidPattern } from '../../config/env.js';
import type { TypeScriptClientService } from './service.js';
export async function typeScriptClientRoutes(
  app: FastifyInstance,
  options: { service: TypeScriptClientService },
) {
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/sdk/typescript',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['projectId'],
          properties: { projectId: { type: 'string', pattern: uuidPattern } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
    },
    async (request, reply) => {
      const document = await options.service.get(
        request.params.projectId,
        request.platformPrincipal.userId,
      );
      return reply
        .header('Cache-Control', 'no-store')
        .type('application/json')
        .send(document);
    },
  );
}
