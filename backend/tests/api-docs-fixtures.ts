import type { DocsSnapshot } from '../src/modules/api-docs/types.js';
import type {
  FieldDefinition,
  FieldType,
} from '../src/modules/schema-builder/types.js';
export function field(
  name: string,
  type: FieldType,
  extra: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    id: `internal-field-${name}`,
    name,
    type,
    nullable: false,
    unique: false,
    default: null,
    options: {},
    position: 0,
    ...extra,
  };
}
export function snapshot(): DocsSnapshot {
  const fields = [
    field('title', 'text'),
    field('done', 'boolean', { default: { kind: 'literal', value: false } }),
    field('owner_id', 'uuid'),
  ];
  const policy = {
    mode: 'owner' as const,
    ownerFieldId: fields[2]!.id,
    allowAdmin: false,
  };
  return {
    project: { slug: 'docs-project' },
    blocked: false,
    resources: [
      {
        name: 'tasks',
        fields,
        operations: ['list', 'get', 'create', 'update', 'delete'],
        policies: {
          list: policy,
          get: policy,
          create: policy,
          update: policy,
          delete: policy,
        },
      },
    ],
    auth: {
      enabled: true,
      signupEnabled: true,
      provisioningStatus: 'ready',
      sessionLifetimeSeconds: 86400,
    },
    tables: [{ id: 'internal-table', appliedRevision: 1, applied: true }],
    workflows: [
      {
        path: 'place-order',
        dependencies: [{ tableId: 'internal-table', appliedRevision: 1 }],
        definition: {
          input: { accepted: { type: 'boolean', required: true } },
          auth: 'authenticated',
          steps: [
            {
              id: 'internal-step',
              name: 'condition',
              type: 'condition',
              operator: 'equals',
              left: {
                kind: 'reference',
                source: 'request',
                path: ['body', 'accepted'],
              },
              right: { kind: 'literal', value: true },
              then: [
                {
                  id: 'success-step',
                  name: 'OK',
                  type: 'response',
                  status: 201,
                  body: {
                    kind: 'object',
                    fields: {
                      accepted: {
                        kind: 'reference',
                        source: 'request',
                        path: ['body', 'accepted'],
                      },
                    },
                  },
                },
              ],
              else: [
                {
                  id: 'rejection-step',
                  name: 'Rejected',
                  type: 'response',
                  status: 409,
                  body: {
                    kind: 'literal',
                    value: { reason: 'literal-secret-sentinel' },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}
