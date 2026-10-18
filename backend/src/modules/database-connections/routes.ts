import type { FastifyInstance } from 'fastify';
import { ConnectionError } from './errors.js';
import { uuidPattern } from '../../config/env.js';
import type { ConnectionService } from './service.js';
import type { ConnectionInput } from './types.js';

const params = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId'],
  properties: { projectId: { type: 'string', pattern: uuidPattern } },
} as const;
const text = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\u0000]+$',
} as const;
const body = {
  type: 'object',
  additionalProperties: false,
  required: [
    'label',
    'host',
    'port',
    'database',
    'username',
    'password',
    'schema',
    'ssl',
  ],
  properties: {
    label: { ...text, maxLength: 100, pattern: '\\S' },
    host: { ...text, maxLength: 253, pattern: '^[a-zA-Z0-9:][a-zA-Z0-9.:-]*$' },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    database: { ...text, maxLength: 63 },
    username: { ...text, maxLength: 63 },
    password: { ...text, maxLength: 1024 },
    schema: { ...text, maxLength: 63 },
    ssl: { type: 'boolean' },
  },
} as const;
const metadata = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'projectId',
    'label',
    'lastTestStatus',
    'lastTestedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    identity: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string' },
        port: { type: 'integer' },
        database: { type: 'string' },
        username: { type: 'string' },
        schema: { type: 'string' },
        ssl: { type: 'boolean' },
      },
    },
    replacement: {
      type: 'object',
      additionalProperties: false,
      properties: {
        eligible: { type: 'boolean' },
        blockers: { type: 'array', items: { type: 'string' } },
      },
    },
    id: { type: 'string' },
    projectId: { type: 'string' },
    label: { type: 'string' },
    lastTestStatus: { type: 'string', enum: ['success', 'failed'] },
    lastTestedAt: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

export async function connectionRoutes(
  app: FastifyInstance,
  options: { service: ConnectionService },
) {
  const path = '/projects/:projectId/database-connection';
  type Request = { Params: { projectId: string }; Body: ConnectionInput };
  app.post<Request>(
    path,
    { schema: { params, body, response: { 201: metadata } } },
    async (request, reply) => {
      const record = await options.service.save(
        request.params.projectId,
        request.platformPrincipal.userId,
        request.body,
        false,
      );
      return reply
        .code(201)
        .header(
          'location',
          `/internal/projects/${record.projectId}/database-connection`,
        )
        .send(record);
    },
  );
  app.put<Request>(
    path,
    { schema: { params, body, response: { 200: metadata } } },
    (request) =>
      options.service.save(
        request.params.projectId,
        request.platformPrincipal.userId,
        request.body,
        true,
      ),
  );
  app.get<Request>(
    path,
    { schema: { params, response: { 200: metadata } } },
    (request) => options.service.get(request.params.projectId, request.platformPrincipal.userId),
  );
  app.post<Request>(
    `${path}/test`,
    {
      schema: { params, response: { 200: metadata } },
      preValidation: async (request) => {
        if (request.body !== undefined)
          throw new ConnectionError(
            400,
            'INVALID_REQUEST',
            'This operation does not accept a body',
          );
      },
    },
    (request) =>
      options.service.test(request.params.projectId, request.platformPrincipal.userId),
  );
  app.delete<Request>(path, { schema: { params } }, async (request, reply) => {
    await options.service.delete(request.params.projectId, request.platformPrincipal.userId);
    return reply.code(204).send();
  });
}
