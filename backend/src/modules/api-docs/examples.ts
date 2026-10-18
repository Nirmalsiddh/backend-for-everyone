import type { JsonSchema } from './types.js';
export const exampleUuid = '00000000-0000-4000-8000-000000000001';
// Only schema structure is read. Stored defaults and literal values never enter examples.
export function synthetic(schema: JsonSchema): unknown {
  if (schema.anyOf) return synthetic(schema.anyOf[0]!);
  const type = Array.isArray(schema.type)
    ? (schema.type.find((t) => t !== 'null') ?? 'null')
    : schema.type;
  if (type === 'null') return null;
  if (type === 'boolean') return false;
  if (type === 'integer' || type === 'number')
    return Math.min(
      Number(schema.maximum ?? 2147483647),
      Math.max(1, Number(schema.minimum ?? -2147483648)),
    );
  if (type === 'array') return [];
  if (type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, child]) => [
        name,
        synthetic(child),
      ]),
    );
  if (type === 'string') {
    if (schema.format === 'uuid') return exampleUuid;
    if (schema.format === 'date') return '2026-01-01';
    if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
    if (schema.pattern === '^-?\\d{1,19}$') return '1';
    if (schema.pattern === '^-?\\d+(\\.\\d+)?$') return '0';
    const min = Number(schema.minLength ?? 0),
      max = Number(schema.maxLength ?? 10000);
    return 'Example title'.slice(0, max).padEnd(min, 'x');
  }
  return {};
}
