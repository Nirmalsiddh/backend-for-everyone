import type { FieldDefinition } from '../schema-builder/types.js';
import type { InputField } from '../workflows/types.js';
import type { ApiResponse, JsonSchema } from './types.js';
export const uuid: JsonSchema = { type: 'string', format: 'uuid' };
export const errorSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'requestId'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string' },
  },
};
export const requestId = {
  'X-Request-Id': {
    description:
      'Request correlation ID. Exposed to configured browser origins for support diagnostics.',
    schema: { type: 'string' },
  },
};
export function fieldSchema(field: FieldDefinition): JsonSchema {
  let schema: JsonSchema;
  switch (field.type) {
    case 'text':
    case 'varchar':
      schema = {
        type: 'string',
        maxLength: field.options.length ?? 10000,
        description: 'Unicode text; NUL is not accepted.',
      };
      break;
    case 'integer':
      schema = {
        type: 'integer',
        format: 'int32',
        minimum: -2147483648,
        maximum: 2147483647,
      };
      break;
    case 'bigint':
      schema = {
        type: 'string',
        pattern: '^-?\\d{1,19}$',
        description:
          'Exact integer string, between -9223372036854775808 and 9223372036854775807.',
      };
      break;
    case 'decimal':
      schema = {
        type: 'string',
        pattern: '^-?\\d+(\\.\\d+)?$',
        maxLength: 42,
        allOf: [
          {
            pattern: `^-?0*\\d{0,${field.options.precision! - field.options.scale!}}${field.options.scale ? `(?:\\.\\d{1,${field.options.scale}})?` : ''}$`,
          },
        ],
        description: `Exact decimal string. Precision ${field.options.precision}, scale ${field.options.scale}; no exponent notation.`,
      };
      break;
    case 'boolean':
      schema = { type: 'boolean' };
      break;
    case 'uuid':
      schema = { ...uuid };
      break;
    case 'date':
      schema = {
        type: 'string',
        format: 'date',
        description:
          'Valid YYYY-MM-DD calendar date; year 0000 is not accepted.',
      };
      break;
    case 'timestamp':
      schema = {
        type: 'string',
        format: 'date-time',
        description:
          'Timezone required. Input permits up to six fractional digits; responses use UTC ISO timestamps.',
      };
      break;
    case 'jsonb':
      schema = {
        description:
          'Any supported JSON value. Maximum 8192 UTF-8 bytes and nesting depth 20; invalid Unicode and NUL are rejected.',
        ...(field.nullable ? {} : { not: { type: 'null' } }),
      };
      break;
  }
  if (field.nullable && schema.type)
    schema.type = [schema.type as string, 'null'];
  if (field.default)
    schema.description =
      `${schema.description ?? ''} A server default is configured; its stored value is intentionally omitted.`.trim();
  return schema;
}
export function inputSchema(field: InputField): JsonSchema {
  const type = field.type === 'uuid' ? 'string' : field.type;
  return {
    type: field.nullable ? [type, 'null'] : type,
    ...(field.type === 'uuid' ? { format: 'uuid' } : {}),
    ...(field.type === 'string'
      ? { minLength: field.minLength ?? 0, maxLength: field.maxLength ?? 10000 }
      : {}),
    ...(field.type === 'integer'
      ? {
          format: 'int32',
          minimum: Math.max(-2147483648, field.min ?? -2147483648),
          maximum: Math.min(2147483647, field.max ?? 2147483647),
        }
      : {}),
  };
}
export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}
export function response(
  description: string,
  schema?: JsonSchema,
  example?: unknown,
): ApiResponse {
  return {
    description,
    headers: requestId,
    ...(schema
      ? {
          content: {
            'application/json': {
              schema,
              ...(example !== undefined ? { example } : {}),
            },
          },
        }
      : {}),
  };
}
export function errors(statuses: number[]): Record<string, ApiResponse> {
  const labels: Record<number, string> = {
    400: 'Invalid request',
    401: 'Invalid or missing runtime credential',
    403: 'Permission or credential scope denied',
    404: 'Resource or row not found',
    409: 'Conflict',
    413: 'Request body too large',
    422: 'Destination policy or workflow constraint rejected',
    429: 'Rate limit exceeded',
    500: 'Internal failure',
    503: 'Runtime temporarily unavailable',
    504: 'Runtime timeout; a write may have completed',
  };
  return Object.fromEntries(
    statuses.map((s) => [
      String(s),
      response(
        labels[s]!,
        { $ref: '#/components/schemas/RuntimeError' },
        {
          code: 'ERROR_CODE',
          message: 'Safe error message',
          requestId: 'example-request-id',
        },
      ),
    ]),
  );
}
