import { uuidPattern } from '../config/env.js';
import { validateScalar } from '../modules/schema-builder/validation.js';
import type { Definition, FieldDefinition } from '../modules/schema-builder/types.js';
import { filterOperators, maxFilterClauses, maxInValues } from '../../../shared/runtime-query.js';
import type { FilterOperator } from '../../../shared/runtime-query.js';
import { RuntimeError, badRequest } from './errors.js';
import type { FilterScalar, ListOptions } from './types.js';
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
function scalarFilter(field: FieldDefinition, input: string): FilterScalar {
  let value: FilterScalar = input;
  if (field.type === 'integer') {
    if (!/^-?\d+$/.test(input)) throw badRequest(); value = Number(input);
  } else if (field.type === 'boolean') {
    if (!['true', 'false'].includes(input)) throw badRequest(); value = input === 'true';
  }
  // Filters cannot express SQL NULL; a text value "null" remains literal text.
  validateValue({ ...field, nullable: false }, value);
  return value;
}
const primaryKey: FieldDefinition = {
  id: 'id', name: 'id', position: -1, type: 'uuid', options: {},
  nullable: false, unique: true, default: null,
};
export function validateList(definition: Definition, query: Record<string, unknown>): ListOptions {
  // Preserve legacy-only error codes, including malformed old query options.
  const advanced = Object.keys(query).some((key) => /^filter\[[^\]]*\]\[/.test(key));
  const invalidFilter = () => advanced
    ? new RuntimeError(400, 'INVALID_FILTER', 'Invalid runtime filter') : badRequest();
  const complexity = () => advanced
    ? new RuntimeError(400, 'QUERY_TOO_COMPLEX', 'Query exceeds filter limits') : badRequest();
  const invalidSort = () => advanced
    ? new RuntimeError(400, 'INVALID_SORT', 'Invalid runtime sorting') : badRequest();
  const result: ListOptions = { limit: 25, offset: 0, sort: 'id', direction: 'ASC', filters: [] };
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') {
      if (key === 'sort' || key === 'direction') throw invalidSort();
      if (key.startsWith('filter')) throw invalidFilter();
      throw badRequest();
    }
    if (key === 'limit' || key === 'offset') {
      if (!/^\d{1,5}$/.test(value)) throw badRequest();
      const number = Number(value);
      if (number < (key === 'limit' ? 1 : 0) || number > (key === 'limit' ? 100 : 10000)) throw badRequest();
      result[key] = number;
    } else if (key === 'sort') {
      const sortField = value === 'id' ? primaryKey : definition.fields.find((field) => field.name === value && field.type !== 'jsonb');
      if (!sortField) throw invalidSort();
      result.sort = sortField.name;
    } else if (key === 'direction') {
      if (!['asc', 'desc'].includes(value)) throw invalidSort();
      result.direction = value === 'asc' ? 'ASC' : 'DESC';
    } else {
      const match = /^filter\[([a-z][a-z0-9_]*)\](?:\[([a-z_]+)\])?$/.exec(key);
      if (!match) throw invalidFilter();
      const name = match[1]!;
      const operator = (match[2] ?? 'eq') as FilterOperator;
      const field = name === 'id' ? primaryKey : definition.fields.find((item) => item.name === name);
      if (!field || !filterOperators(field).includes(operator)) throw invalidFilter();
      const pair = `${name}:${operator}`;
      if (seen.has(pair)) throw invalidFilter();
      if (result.filters.length >= maxFilterClauses) throw complexity();
      seen.add(pair);
      if (operator === 'is_null') {
        if (!['true', 'false'].includes(value)) throw invalidFilter();
        result.filters.push({ kind: 'null', field, operator, isNull: value === 'true' });
      } else if (operator === 'in') {
        let items: unknown;
        try { items = JSON.parse(value); } catch { throw invalidFilter(); }
        if (!Array.isArray(items) || !items.length || items.some((item) => typeof item !== 'string')) throw invalidFilter();
        if (items.length > maxInValues) throw complexity();
        try {
          result.filters.push({ kind: 'membership', field, operator, values: items.map((item: string) => scalarFilter(field, item)) });
        } catch { throw invalidFilter(); }
      } else {
        try {
          result.filters.push({ kind: 'comparison', field, operator, value: scalarFilter(field, value) });
        } catch { throw invalidFilter(); }
      }
    }
  }
  return result;
}
