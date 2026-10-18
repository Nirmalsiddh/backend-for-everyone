import type { FastifyInstance } from 'fastify';
import { uuidPattern } from '../../config/env.js';
import type { ProjectService } from './service.js';
import type { CreateProjectInput } from './types.js';

const projectResponse = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'ownerId', 'name', 'slug', 'createdAt'],
  properties: {
    id: { type: 'string' },
    ownerId: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;

export async function projectRoutes(
  app: FastifyInstance,
  options: {
    service: ProjectService;
    ownerId: string;
  },
) {
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/projects',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
            offset: { type: 'string', pattern: '^(?:0|[1-9][0-9]{0,5})$' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'nextOffset'],
            properties: {
              items: { type: 'array', items: projectResponse },
              nextOffset: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            },
          },
        },
      },
    },
    (request) =>
      options.service.list(
        options.ownerId,
        Number(request.query.limit ?? 20),
        Number(request.query.offset ?? 0),
      ),
  );

  app.post<{ Body: CreateProjectInput }>(
    '/projects',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'slug'],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              pattern: '^.*\\S.*$',
            },
            slug: {
              type: 'string',
              minLength: 3,
              maxLength: 63,
              pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
            },
          },
        },
        response: { 201: projectResponse },
      },
    },
    async (request, reply) => {
      const project = await options.service.create(
        options.ownerId,
        request.body,
      );
      return reply
        .code(201)
        .header('location', `/internal/projects/${project.id}`)
        .send(project);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/projects/:id',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: uuidPattern } },
        },
        response: { 200: projectResponse },
      },
    },
    (request) => options.service.getById(options.ownerId, request.params.id),
  );
}
