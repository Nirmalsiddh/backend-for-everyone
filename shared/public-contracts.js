// Public transport vocabulary only. No persistence or database models.
export const fieldTypes = Object.freeze([
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
]);
export const operations = Object.freeze([
  'list',
  'get',
  'create',
  'update',
  'delete',
]);
export const policyModes = Object.freeze([
  'key_only',
  'authenticated',
  'owner',
]);
export const workflowAuthModes = Object.freeze(['key_only', 'authenticated']);
export const workflowStepKinds = Object.freeze([
  'query',
  'insert',
  'update',
  'delete',
  'condition',
  'response',
]);
export const comparisonOperators = Object.freeze([
  'equals',
  'not_equals',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
  'is_null',
  'is_not_null',
]);
export const responseStatuses = Object.freeze([
  200, 201, 204, 400, 403, 404, 409, 422,
]);
