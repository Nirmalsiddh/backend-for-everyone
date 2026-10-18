import type { OpenApiDocument, ApiOperation } from '../../shared/openapi.js';
const create: ApiOperation = {
  operationId: 'crud_tasks_create',
  tags: ['Resources'],
  summary: 'create tasks',
  description:
    'Authenticated application user required; clients cannot set or transfer ownership.',
  'x-access-policy': 'owner',
  security: [{ ApplicationSession: [] }],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
        example: { title: 'Example title' },
      },
    },
  },
  responses: {
    '201': {
      description: 'Created record',
      content: { 'application/json': { schema: { type: 'object' } } },
    },
  },
};
export const documentFixture: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Docs project',
    version: '1.0.0',
    description: 'Test-only public document',
  },
  servers: [{ url: 'https://api.example.test/api/docs-project' }],
  paths: {
    '/tasks': { post: create },
    '/auth/login': {
      post: {
        ...create,
        operationId: 'auth_login',
        tags: ['Authentication'],
        summary: 'Application login',
        'x-access-policy': 'public',
        security: [],
      },
    },
    '/place-order': {
      post: {
        ...create,
        operationId: 'workflow_place_order',
        tags: ['Workflows'],
        summary: 'Run place-order',
        'x-access-policy': 'authenticated',
        responses: {
          '201': { description: 'Accepted' },
          '409': {
            description: 'Business rejection',
            content: {
              'application/json': {
                schema: { anyOf: [{ type: 'string' }, { type: 'object' }] },
              },
            },
          },
        },
      },
    },
  },
  components: { schemas: {}, securitySchemes: {} },
};
