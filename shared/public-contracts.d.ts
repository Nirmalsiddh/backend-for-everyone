export const fieldTypes: readonly [
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
];
export const operations: readonly ['list', 'get', 'create', 'update', 'delete'];
export const policyModes: readonly ['key_only', 'authenticated', 'owner'];
export const workflowAuthModes: readonly ['key_only', 'authenticated'];
export const workflowStepKinds: readonly [
  'query',
  'insert',
  'update',
  'delete',
  'condition',
  'response',
];
export const comparisonOperators: readonly [
  'equals',
  'not_equals',
  'greater_than',
  'greater_or_equal',
  'less_than',
  'less_or_equal',
  'is_null',
  'is_not_null',
];
export const responseStatuses: readonly [
  200,
  201,
  204,
  400,
  403,
  404,
  409,
  422,
];
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
}
export type PublicPolicy =
  | {
      mode: 'key_only' | 'authenticated';
      ownerFieldId?: never;
      allowAdmin?: never;
    }
  | { mode: 'owner'; ownerFieldId: string; allowAdmin: boolean };
