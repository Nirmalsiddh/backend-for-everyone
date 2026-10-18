import { uuidPattern } from '../config/env.js';
import { validateScalar } from '../modules/schema-builder/validation.js';
import type { Definition, FieldDefinition } from '../modules/schema-builder/types.js';
import { badRequest } from './errors.js';
import type { ListOptions } from './types.js';
export function validateId(value: string) {
  if (!new RegExp(uuidPattern).test(value)) throw badRequest();
}
export function validateValue(field: FieldDefinition, value: unknown) {
  if (value === null) { if (!field.nullable) throw badRequest(); return; }
  try { validateScalar(field, value); } catch { throw badRequest(); }
}
export function validateBody(definition: Definition, body: unknown, create: boolean): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest();
  const record = body as Record<string, unknown>;
  if (!create && !Object.keys(record).length) throw badRequest();
  for (const [name, value] of Object.entries(record)) {
    const field = definition.fields.find((item) => item.name === name);
    if (name === 'id' || !field) throw badRequest();
    validateValue(field, value);
  }
  if (create) for (const field of definition.fields) {
    if (!field.nullable && !field.default && !Object.hasOwn(record, field.name)) throw badRequest();
  }
  return record;
}
function scalarFilter(field: FieldDefinition, input: string): unknown {
  let value: unknown = input;
  if (field.type === 'integer') {
    if (!/^-?\d+$/.test(input)) throw badRequest(); value = Number(input);
  } else if (field.type === 'boolean') {
    if (!['true', 'false'].includes(input)) throw badRequest(); value = input === 'true';
  }
  // Filters cannot express SQL NULL; a text value "null" remains literal text.
  validateValue({ ...field, nullable: false }, value);
  return value;
}
export function validateList(definition: Definition, query: Record<string, unknown>): ListOptions {
  const result: ListOptions = { limit: 25, offset: 0, sort: 'id', direction: 'ASC', filters: [] };
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') throw badRequest();
    if (key === 'limit' || key === 'offset') {
      if (!/^\d{1,5}$/.test(value)) throw badRequest();
      const number = Number(value);
      if (number < (key === 'limit' ? 1 : 0) || number > (key === 'limit' ? 100 : 10000)) throw badRequest();
      result[key] = number;
    } else if (key === 'sort') {
      if (value !== 'id' && !definition.fields.some((field) => field.name === value && field.type !== 'jsonb')) throw badRequest();
      result.sort = value;
    } else if (key === 'direction') {
      if (!['asc', 'desc'].includes(value)) throw badRequest(); result.direction = value === 'asc' ? 'ASC' : 'DESC';
    } else {
      const match = /^filter\[([a-z][a-z0-9_]*)\]$/.exec(key);
      if (!match || result.filters.length >= 5) throw badRequest();
      const name = match[1]!;
      if (name === 'id') { validateId(value); result.filters.push({ field: 'id', value }); continue; }
      const field = definition.fields.find((item) => item.name === name);
      if (!field || field.type === 'jsonb') throw badRequest();
      result.filters.push({ field: name, value: scalarFilter(field, value) });
    }
  }
  return result;
}
