import type {
  InputField,
  Step,
  Value,
  WorkflowDefinition,
} from '../workflows/types.js';
import type { ApiOperation, JsonSchema } from './types.js';
import {
  inputSchema,
  objectSchema,
  errors,
  response,
  uuid,
} from './schemas.js';
import { synthetic } from './examples.js';
const dynamic = (): JsonSchema => ({
  description:
    'Dynamic JSON value; exact response shape cannot be inferred statically.',
});
function literal(value: unknown, depth = 0): JsonSchema {
  if (depth > 20) return dynamic();
  if (value === null) return { type: 'null' };
  if (Array.isArray(value))
    return {
      type: 'array',
      items: value.length
        ? { anyOf: unique(value.map((v) => literal(v, depth + 1))) }
        : {},
    };
  if (typeof value === 'object')
    return objectSchema(
      Object.fromEntries(
        Object.entries(value!)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, literal(v, depth + 1)]),
      ),
      Object.keys(value!).sort(),
    );
  if (typeof value === 'number')
    return { type: Number.isInteger(value) ? 'integer' : 'number' };
  return { type: typeof value };
}
function unique(schemas: JsonSchema[]) {
  return [...new Map(schemas.map((s) => [JSON.stringify(s), s])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, s]) => s);
}
export function infer(
  value: Value | undefined,
  input: Record<string, InputField>,
): JsonSchema {
  if (!value) return { type: 'null' };
  if (value.kind === 'literal') return literal(value.value);
  if (value.kind === 'object')
    return objectSchema(
      Object.fromEntries(
        Object.entries(value.fields)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, v]) => [name, infer(v, input)]),
      ),
      Object.keys(value.fields).sort(),
    );
  if (value.kind === 'array')
    return {
      type: 'array',
      items: value.items.length
        ? { anyOf: unique(value.items.map((v) => infer(v, input))) }
        : {},
    };
  if (
    value.source === 'request' &&
    value.path.length === 2 &&
    value.path[0] === 'body' &&
    input[value.path[1]!]
  )
    return inputSchema(input[value.path[1]!]!);
  if (value.source === 'auth' && value.path.join('.') === 'user.id')
    return uuid;
  if (value.source === 'auth' && value.path.join('.') === 'user.role')
    return { type: 'string', enum: ['user', 'admin'] };
  return dynamic();
}
export function workflow(path: string, definition: WorkflowDefinition) {
  const input = Object.fromEntries(
    Object.entries(definition.input)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, field]) => [name, inputSchema(field)]),
  );
  const body = objectSchema(
    input,
    Object.keys(input).filter((name) => definition.input[name]!.required),
  );
  const terminals = new Map<number, JsonSchema[]>();
  let writes = false;
  const statuses = new Set([400, 401, 404, 413, 422, 500, 503, 504]);
  // Responses stop execution; only walk reachable branches, without executing predicates or DB steps.
  function walk(steps: Step[]): boolean {
    for (const step of steps) {
      if (step.type === 'response') {
        terminals.set(step.status, [
          ...(terminals.get(step.status) ?? []),
          infer(step.body, definition.input),
        ]);
        return true;
      }
      if (step.type === 'condition') {
        const left = walk(step.then),
          right = walk(step.else);
        if (left && right) return true;
      }
      if (['insert', 'update', 'delete'].includes(step.type)) {
        writes = true;
        statuses.add(409);
      }
      if (step.type === 'update') statuses.add(step.onNoMatch);
    }
    return false;
  }
  walk(definition.steps);
  // Scope checking inspects every branch, including structurally present unreachable steps.
  function hasWrites(steps: Step[]): boolean {
    return steps.some(
      (s) =>
        ['insert', 'update', 'delete'].includes(s.type) ||
        (s.type === 'condition' && (hasWrites(s.then) || hasWrites(s.else))),
    );
  }
  writes ||= hasWrites(definition.steps);
  if (definition.auth === 'key_only' && writes) statuses.add(403);
  const responses = errors([...statuses]);
  for (const [status, schemas] of terminals) {
    if (status === 204) {
      responses['204'] = response('Workflow response; no content');
      continue;
    }
    const alternatives = unique([
      ...schemas,
      ...(responses[status]
        ? [{ $ref: '#/components/schemas/RuntimeError' }]
        : []),
    ]);
    responses[status] = response(
      'Published workflow response' +
        (status >= 400
          ? '; business rejection or sanitized runtime failure'
          : ''),
      alternatives.length === 1 ? alternatives[0] : { anyOf: alternatives },
      synthetic(schemas[0]!),
    );
  }
  const operation: ApiOperation = {
    operationId: `workflow_${path.replaceAll('-', '_')}`,
    tags: ['Workflows'],
    summary: `Run ${path}`,
    description: `Published workflow. ${definition.auth === 'key_only' ? `API key requires ${writes ? 'read_write' : 'read or read_write'} scope.` : 'Signed-in application user required.'} Database access rules are enforced by the published workflow; endpoint authentication alone does not imply owner-only access.`,
    'x-access-policy': definition.auth,
    security: [
      {
        [definition.auth === 'key_only'
          ? 'ProjectApiKey'
          : 'ApplicationSession']: [],
      },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: body, example: synthetic(body) },
      },
    },
    responses,
  };
  return { path: `/${path}`, method: 'post', operation };
}
