import type { FastifyInstance } from 'fastify';
import { uuidPattern } from '../../config/env.js';
import { invalid } from '../schema-builder/errors.js';
import type { WorkflowDefinition } from './types.js';
import type { WorkflowService } from './service.js';
export async function workflowRoutes(
  app: FastifyInstance,
  options: { service: WorkflowService; ownerId: string },
) {
  const path = '/projects/:projectId/workflows';
  const item = `${path}/:workflowId`;
  const uuid = { type: 'string', pattern: uuidPattern };
  const revision = { type: 'integer', minimum: 1, maximum: 2147483645 };
  const params = (single: boolean) => ({
    type: 'object',
    additionalProperties: false,
    required: single ? ['projectId', 'workflowId'] : ['projectId'],
    properties: single
      ? { projectId: uuid, workflowId: uuid }
      : { projectId: uuid },
  });
  const body = (required: string[], properties: object) => ({
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  });
  type Params = { projectId: string; workflowId: string };
  app.post<{
    Params: Params;
    Body: { path: string; definition: WorkflowDefinition };
  }>(
    path,
    {
      schema: {
        params: params(false),
        body: body(['path', 'definition'], {
          path: { type: 'string', maxLength: 63 },
          definition: { type: 'object' },
        }),
      },
    },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await options.service.create(
            req.params.projectId,
            options.ownerId,
            req.body.path,
            req.body.definition,
          ),
        ),
  );
  app.get<{ Params: Params }>(
    path,
    { schema: { params: params(false) } },
    (req) => options.service.list(req.params.projectId, options.ownerId),
  );
  app.get<{ Params: Params }>(
    item,
    { schema: { params: params(true) } },
    (req) =>
      options.service.get(
        req.params.projectId,
        options.ownerId,
        req.params.workflowId,
      ),
  );
  app.put<{
    Params: Params;
    Body: { expectedDraftRevision: number; definition: WorkflowDefinition };
  }>(
    `${item}/draft`,
    {
      schema: {
        params: params(true),
        body: body(['expectedDraftRevision', 'definition'], {
          expectedDraftRevision: revision,
          definition: { type: 'object' },
        }),
      },
    },
    (req) =>
      options.service.edit(
        req.params.projectId,
        options.ownerId,
        req.params.workflowId,
        req.body.expectedDraftRevision,
        req.body.definition,
      ),
  );
  app.post<{ Params: Params }>(
    `${item}/preview`,
    {
      schema: { params: params(true) },
      preValidation: async (req) => {
        if (req.body !== undefined)
          throw invalid('Preview does not accept a body');
      },
    },
    (req) =>
      options.service.preview(
        req.params.projectId,
        options.ownerId,
        req.params.workflowId,
      ),
  );
  app.post<{
    Params: Params;
    Body: { expectedDraftRevision: number; definitionHash: string };
  }>(
    `${item}/publish`,
    {
      schema: {
        params: params(true),
        body: body(['expectedDraftRevision', 'definitionHash'], {
          expectedDraftRevision: revision,
          definitionHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        }),
      },
    },
    (req) =>
      options.service.publish(
        req.params.projectId,
        options.ownerId,
        req.params.workflowId,
        req.body.expectedDraftRevision,
        req.body.definitionHash,
      ),
  );
  app.patch<{
    Params: Params;
    Body: { expectedDraftRevision: number; enabled: boolean };
  }>(
    item,
    {
      schema: {
        params: params(true),
        body: body(['expectedDraftRevision', 'enabled'], {
          expectedDraftRevision: revision,
          enabled: { type: 'boolean' },
        }),
      },
    },
    (req) =>
      options.service.toggle(
        req.params.projectId,
        options.ownerId,
        req.params.workflowId,
        req.body.expectedDraftRevision,
        req.body.enabled,
      ),
  );
}
