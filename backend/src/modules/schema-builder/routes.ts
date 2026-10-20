import type { FastifyInstance } from 'fastify';
import { uuidPattern } from '../../config/env.js';
import { SchemaError } from './errors.js';
import type { SchemaService } from './service.js';
import type { DraftInput } from './types.js';

const field = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type'],
  properties: {
    id: { type: 'string', pattern: uuidPattern },
    name: { type: 'string', maxLength: 63 },
    type: {
      type: 'string',
      enum: [
        'text',
        'varchar',
        'integer',
        'bigint',
        'decimal',
        'boolean',
        'uuid',
        'date',
        'timestamp',
        'jsonb',
      ],
    },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: {
        length: { type: 'integer' },
        precision: { type: 'integer' },
        scale: { type: 'integer' },
      },
    },
    relationship: {
      type: 'object',
      additionalProperties: false,
      required: ['tableId', 'onDelete'],
      properties: {
        tableId: { type: 'string', pattern: uuidPattern },
        onDelete: { const: 'restrict' },
      },
    },
    nullable: { type: 'boolean' },
    unique: { type: 'boolean' },
    default: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'value'],
          properties: { kind: { const: 'literal' }, value: {} },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { const: 'current_timestamp' } },
        },
      ],
    },
  },
} as const;
const draftProperties = {
  name: { type: 'string', maxLength: 63 },
  fields: { type: 'array', maxItems: 100, items: field },
} as const;
const revision = { type: 'integer', minimum: 1, maximum: 2147483646 } as const;
export async function schemaRoutes(
  app: FastifyInstance,
  options: { service: SchemaService },
) {
  const base = '/projects/:projectId/schema';
  const tablePath = `${base}/tables/:tableId`;
  const params = (table: boolean) => ({
    type: 'object',
    additionalProperties: false,
    required: table ? ['projectId', 'tableId'] : ['projectId'],
    properties: {
      projectId: { type: 'string', pattern: uuidPattern },
      ...(table ? { tableId: { type: 'string', pattern: uuidPattern } } : {}),
    },
  });
  const noBody = async (request: { body?: unknown }) => {
    if (request.body !== undefined)
      throw new SchemaError(
        400,
        'INVALID_REQUEST',
        'This operation does not accept a body',
      );
  };
  type Params = { projectId: string; tableId: string };
  app.get<{ Params: Params }>(
    base,
    { schema: { params: params(false) } },
    (req) =>
      options.service.list(req.params.projectId, req.platformPrincipal.userId),
  );
  app.get<{ Params: Params }>(
    `${base}/reference-targets`,
    { schema: { params: params(false) } },
    (req) =>
      options.service.targets(
        req.params.projectId,
        req.platformPrincipal.userId,
      ),
  );
  app.post<{ Params: Params; Body: DraftInput }>(
    `${base}/tables`,
    {
      schema: {
        params: params(false),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'fields'],
          properties: draftProperties,
        },
      },
    },
    async (req, reply) => {
      const table = await options.service.create(
        req.params.projectId,
        req.platformPrincipal.userId,
        req.body,
      );
      return reply
        .code(201)
        .header(
          'location',
          `/internal/projects/${table.projectId}/schema/tables/${table.id}`,
        )
        .send(table);
    },
  );
  app.get<{ Params: Params }>(
    tablePath,
    { schema: { params: params(true) } },
    (req) =>
      options.service.get(
        req.params.projectId,
        req.platformPrincipal.userId,
        req.params.tableId,
      ),
  );
  app.put<{
    Params: Params;
    Body: DraftInput & { expectedDraftRevision: number };
  }>(
    `${tablePath}/draft`,
    {
      schema: {
        params: params(true),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'fields', 'expectedDraftRevision'],
          properties: { ...draftProperties, expectedDraftRevision: revision },
        },
      },
    },
    (req) => {
      const { expectedDraftRevision, ...draft } = req.body;
      return options.service.update(
        req.params.projectId,
        req.platformPrincipal.userId,
        req.params.tableId,
        expectedDraftRevision,
        draft,
      );
    },
  );
  app.delete<{ Params: Params }>(
    tablePath,
    { schema: { params: params(true) }, preValidation: noBody },
    async (req, reply) => {
      await options.service.delete(
        req.params.projectId,
        req.platformPrincipal.userId,
        req.params.tableId,
      );
      return reply.code(204).send();
    },
  );
  app.post<{ Params: Params }>(
    `${tablePath}/preview`,
    { schema: { params: params(true) }, preValidation: noBody },
    (req) =>
      options.service.preview(
        req.params.projectId,
        req.platformPrincipal.userId,
        req.params.tableId,
      ),
  );
  app.post<{
    Params: Params;
    Body: { expectedDraftRevision: number; planHash: string };
  }>(
    `${tablePath}/apply`,
    {
      schema: {
        params: params(true),
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedDraftRevision', 'planHash'],
          properties: {
            expectedDraftRevision: revision,
            planHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          },
        },
      },
    },
    (req) =>
      options.service.apply(
        req.params.projectId,
        req.platformPrincipal.userId,
        req.params.tableId,
        req.body.expectedDraftRevision,
        req.body.planHash,
      ),
  );
}
