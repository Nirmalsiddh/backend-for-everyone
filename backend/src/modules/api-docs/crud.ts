import type { DocsSnapshot, ApiOperation, JsonSchema } from './types.js';
import {
  fieldSchema,
  objectSchema,
  uuid,
  response,
  errors,
} from './schemas.js';
import { synthetic } from './examples.js';
export function crud(resource: DocsSnapshot['resources'][number]) {
  const fields = [...resource.fields!].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const record = objectSchema(
    {
      id: uuid,
      ...Object.fromEntries(fields.map((f) => [f.name, fieldSchema(f)])),
    },
    ['id', ...fields.map((f) => f.name)],
  );
  const protectedIds = new Set(
    Object.values(resource.policies).flatMap((p) =>
      p.mode === 'owner' ? [p.ownerFieldId] : [],
    ),
  );
  return [...resource.operations].sort().map((op) => {
    const policy = resource.policies[op] ?? { mode: 'key_only' };
    const owner =
      policy.mode === 'owner'
        ? fields.find((f) => f.id === policy.ownerFieldId)?.name
        : undefined;
    const write = ['create', 'update', 'delete'].includes(op);
    const description =
      policy.mode === 'key_only'
        ? `Authorization: Bearer <project-api-key>. Requires ${write ? 'read_write' : 'read or read_write'} scope.`
        : policy.mode === 'authenticated'
          ? 'Signed-in application user required. This policy does not automatically restrict rows to their owner.'
          : `Authenticated application user required. Rows are restricted by ${owner}. Create injects ownership; clients cannot set or transfer ownership. Foreign and missing rows both appear as 404.${policy.mode === 'owner' && policy.allowAdmin ? ' Application administrators may bypass row restriction; create still injects the signed-in user.' : ' No administrator bypass is enabled.'}`;
    const operation: ApiOperation = {
      operationId: `crud_${resource.name}_${op}`,
      tags: ['Resources'],
      summary: `${op} ${resource.name}`,
      description,
      'x-access-policy': policy.mode,
      security: [
        {
          [policy.mode === 'key_only' ? 'ProjectApiKey' : 'ApplicationSession']:
            [],
        },
      ],
      responses: errors([
        400,
        401,
        404,
        422,
        500,
        503,
        504,
        ...(write ? [403, 409] : []),
        ...(['create', 'update'].includes(op) ? [413] : []),
      ]),
    };
    if (
      write &&
      ((op === 'delete' && resource.relationshipDelete) ||
        (op !== 'delete' && fields.some((f) => f.relationship)))
    )
      operation.description +=
        ' RELATIONSHIP_CONFLICT (409): a referenced record is unavailable, or this change conflicts with related records.';
    if (['get', 'update', 'delete'].includes(op))
      operation.parameters = [
        { name: 'id', in: 'path', required: true, schema: uuid },
      ];
    if (op === 'list') {
      operation.description +=
        ' Equality filters use AND semantics, at most five filters. SQL NULL filtering and JSONB filters are unsupported.';
      operation.parameters = [
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', default: 25, minimum: 1, maximum: 100 },
        },
        {
          name: 'offset',
          in: 'query',
          schema: { type: 'integer', default: 0, minimum: 0, maximum: 10000 },
        },
        {
          name: 'sort',
          in: 'query',
          schema: {
            type: 'string',
            default: 'id',
            enum: [
              'id',
              ...fields.filter((f) => f.type !== 'jsonb').map((f) => f.name),
            ],
          },
        },
        {
          name: 'direction',
          in: 'query',
          schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
        },
        {
          name: 'filter[id]',
          in: 'query',
          description: 'Equality filter',
          schema: uuid,
        },
        ...fields
          .filter((f) => f.type !== 'jsonb')
          .map((f) => {
            const schema = fieldSchema({
              ...f,
              nullable: false,
              default: null,
            });
            return {
              name: `filter[${f.name}]`,
              in: 'query' as const,
              description: 'Equality filter; no SQL NULL matching',
              schema,
            };
          }),
      ];
    }
    if (op === 'create' || op === 'update') {
      const writable = fields.filter((f) =>
        op === 'create'
          ? f.id !== (policy.mode === 'owner' ? policy.ownerFieldId : undefined)
          : !protectedIds.has(f.id),
      );
      const body: JsonSchema = {
        ...objectSchema(
          Object.fromEntries(writable.map((f) => [f.name, fieldSchema(f)])),
          op === 'create'
            ? writable
                .filter((f) => !f.nullable && !f.default)
                .map((f) => f.name)
            : [],
        ),
        ...(op === 'update' ? { minProperties: 1 } : {}),
      };
      if (op === 'update' && !writable.length)
        operation.description +=
          ' No writable fields exist; this enabled operation currently cannot accept a successful PATCH.';
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: body,
            ...(op === 'update' && !writable.length
              ? {}
              : { example: synthetic(body) }),
          },
        },
      };
    }
    const success =
      op === 'delete'
        ? response('Deleted; no content')
        : op === 'list'
          ? response(
              'Records and pagination',
              objectSchema(
                {
                  data: { type: 'array', items: record },
                  pagination: objectSchema(
                    {
                      limit: { type: 'integer' },
                      offset: { type: 'integer' },
                      hasMore: { type: 'boolean' },
                    },
                    ['limit', 'offset', 'hasMore'],
                  ),
                },
                ['data', 'pagination'],
              ),
              {
                data: [synthetic(record)],
                pagination: { limit: 25, offset: 0, hasMore: false },
              },
            )
          : response(
              op === 'create' ? 'Created record' : 'Record',
              record,
              synthetic(record),
            );
    if (op === 'create')
      success.headers = {
        ...success.headers,
        Location: {
          description: 'Relative URL of the created record',
          schema: { type: 'string' },
        },
      };
    operation.responses[
      op === 'delete' ? '204' : op === 'create' ? '201' : '200'
    ] = success;
    const method = {
      list: 'get',
      get: 'get',
      create: 'post',
      update: 'patch',
      delete: 'delete',
    }[op];
    return {
      path: `/${resource.name}${['get', 'update', 'delete'].includes(op) ? '/{id}' : ''}`,
      method,
      operation,
    };
  });
}
