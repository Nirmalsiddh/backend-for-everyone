import type { FastifyInstance } from 'fastify';
import { uuidPattern } from '../../config/env.js';
import type { DocsService } from './service.js';
export async function docsRoutes(
  app: FastifyInstance,
  options: { service: DocsService },
) {
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/openapi',
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
