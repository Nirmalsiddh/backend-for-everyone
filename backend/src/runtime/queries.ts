import type { Ownership } from './authorization.js';
import type { Definition, FieldDefinition } from '../modules/schema-builder/types.js';
import { quoteIdentifier as q, sqlType } from '../modules/schema-builder/plan.js';
import { badRequest } from './errors.js';
import type { ListOptions, Query } from './types.js';
const target = (definition: Definition) => `${q(definition.schema)}.${q(definition.name)}`;
function projection(definition: Definition) {
  return ['"id"', ...definition.fields.map((field) => {
    const name = q(field.name);
    // Keep dates and exact numbers out of implicit JavaScript Date/number conversion.
    return ['bigint', 'decimal', 'date'].includes(field.type) ? `${name}::pg_catalog.text AS ${name}` : name;
  })].join(', ');
}
function field(definition: Definition, name: string): FieldDefinition {
  const item = definition.fields.find((candidate) => candidate.name === name);
  if (!item) throw badRequest();
  return item;
}
function parameter(values: unknown[], value: unknown, item?: FieldDefinition) {
  // pg serializes arrays as PostgreSQL arrays, so JSONB must be explicitly serialized.
  values.push(item?.type === 'jsonb' && value !== null ? JSON.stringify(value) : value);
  return `$${values.length}${item ? `::${sqlType(item)}` : '::pg_catalog.uuid'}`;
}
export function selectList(definition: Definition, options: ListOptions, ownership?: Ownership): Query {
  const values: unknown[] = [];
  const filters = options.filters.map((filter) => {
    const item = filter.field === 'id' ? undefined : field(definition, filter.field);
    return `${q(filter.field)} = ${parameter(values, filter.value, item)}`;
  });
  if (ownership) filters.push(`${q(field(definition, ownership.field).name)} = ${parameter(values, ownership.userId, field(definition, ownership.field))}`);
  if (options.sort !== 'id' && field(definition, options.sort).type === 'jsonb') throw badRequest();
  if (!['ASC', 'DESC'].includes(options.direction)) throw badRequest();
  const order = `"runtime_row".${q(options.sort)} ${options.direction} NULLS LAST${options.sort === 'id' ? '' : ', "runtime_row"."id" ASC'}`;
  values.push(options.limit + 1, options.offset);
  return { text: `SELECT ${projection(definition)} FROM ONLY ${target(definition)} AS "runtime_row"${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`, values };
}
export function selectById(definition: Definition, id: string, ownership?: Ownership): Query {
  const values: unknown[] = [id];
  const owner = ownership ? ` AND ${q(field(definition, ownership.field).name)} = ${parameter(values, ownership.userId, field(definition, ownership.field))}` : '';
  return { text: `SELECT ${projection(definition)} FROM ONLY ${target(definition)} WHERE "id" = $1::pg_catalog.uuid${owner}`, values };
}
export function insertRow(definition: Definition, body: Record<string, unknown>): Query {
  const values: unknown[] = [];
  const names = Object.keys(body);
  const params = names.map((name) => parameter(values, body[name], field(definition, name)));
  return { text: `INSERT INTO ${target(definition)} ${names.length ? `(${names.map(q).join(', ')}) VALUES (${params.join(', ')})` : 'DEFAULT VALUES'} RETURNING ${projection(definition)}`, values };
}
export function updateRow(definition: Definition, id: string, body: Record<string, unknown>, ownership?: Ownership): Query {
  const values: unknown[] = [];
  const sets = Object.keys(body).map((name) => `${q(name)} = ${parameter(values, body[name], field(definition, name))}`);
  if (!sets.length) throw badRequest();
  const idParameter = parameter(values, id);
  const owner = ownership ? ` AND ${q(field(definition, ownership.field).name)} = ${parameter(values, ownership.userId, field(definition, ownership.field))}` : '';
  return { text: `UPDATE ONLY ${target(definition)} SET ${sets.join(', ')} WHERE "id" = ${idParameter}${owner} RETURNING ${projection(definition)}`, values };
}
export function deleteRow(definition: Definition, id: string, ownership?: Ownership): Query {
  const values: unknown[] = [id];
  const owner = ownership ? ` AND ${q(field(definition, ownership.field).name)} = ${parameter(values, ownership.userId, field(definition, ownership.field))}` : '';
  return { text: `DELETE FROM ONLY ${target(definition)} WHERE "id" = $1::pg_catalog.uuid${owner} RETURNING "id"`, values };
}
export function serializeRow(definition: Definition, row: Record<string, unknown>) {
  const result: Record<string, unknown> = { id: row.id };
  for (const item of definition.fields) {
    const value = row[item.name];
    result[item.name] = item.type === 'timestamp' && value instanceof Date ? value.toISOString() : value;
  }
  return result;
}

export function selectByIds(definition: Definition, ids: string[], ownership?: Ownership): Query {
  const values: unknown[] = [ids];
  const owner = ownership ? ` AND ${q(field(definition, ownership.field).name)} = ${parameter(values, ownership.userId, field(definition, ownership.field))}` : '';
  return { text: `SELECT ${projection(definition)} FROM ONLY ${target(definition)} WHERE "id" = ANY($1::pg_catalog.uuid[])${owner} LIMIT 100`, values };
}
