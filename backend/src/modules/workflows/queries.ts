import type { Definition, FieldDefinition } from '../schema-builder/types.js';
import { quoteIdentifier as q, sqlType } from '../schema-builder/plan.js';
import type { Ownership } from '../../runtime/authorization.js';
import type { Query } from '../../runtime/types.js';
import { executionError } from './values.js';
export function workflowField(
  definition: Definition,
  id: string,
): FieldDefinition {
  const field = definition.fields.find((candidate) => candidate.id === id);
  if (!field) throw executionError();
  return field;
}
export function projection(definition: Definition, select: string[]) {
  if (!select.length) return '"id" AS "__workflow_internal_id"';
  return select
    .map((id) => {
      if (id === 'id') return '"id"';
      const field = workflowField(definition, id);
      const name = q(field.name);
      return `${name}${['bigint', 'decimal', 'date'].includes(field.type) ? '::pg_catalog.text' : ''} AS ${q(id)}`;
    })
    .join(', ');
}
const target = (definition: Definition) =>
  `${q(definition.schema)}.${q(definition.name)}`;
export function projectRow(row: Record<string, unknown>, select: string[]) {
  return Object.fromEntries(
    select.map((id) => [
      id,
      row[id] instanceof Date ? row[id].toISOString() : row[id],
    ]),
  );
}
export function workflowQuery(
  definition: Definition,
  id: string,
  select: string[],
  ownership: Ownership | undefined,
  forUpdate: boolean,
): Query {
  return {
    text: `SELECT ${projection(definition, select)} FROM ONLY ${target(definition)} WHERE "id" = $1::pg_catalog.uuid${ownership ? ` AND ${q(ownership.field)} = $2::pg_catalog.uuid` : ''}${forUpdate ? ' FOR UPDATE' : ''}`,
    values: ownership ? [id, ownership.userId] : [id],
  };
}
export function workflowInsert(
  definition: Definition,
  body: Record<string, unknown>,
  select: string[],
): Query {
  const values: unknown[] = [];
  const names = Object.keys(body);
  const params = names.map((name) => {
    const field = definition.fields.find(
      (candidate) => candidate.name === name,
    );
    if (!field) throw executionError();
    values.push(
      field.type === 'jsonb' && body[name] !== null
        ? JSON.stringify(body[name])
        : body[name],
    );
    return `$${values.length}::${sqlType(field)}`;
  });
  return {
    text: `INSERT INTO ${target(definition)} ${names.length ? `(${names.map(q).join(', ')}) VALUES (${params.join(', ')})` : 'DEFAULT VALUES'} RETURNING ${projection(definition, select)}`,
    values,
  };
}
export function workflowUpdate(
  definition: Definition,
  id: string,
  assignments: {
    fieldId: string;
    operation: 'set' | 'decrement';
    value: unknown;
  }[],
  select: string[],
  ownership?: Ownership,
): Query {
  const values: unknown[] = [id];
  const guards: string[] = [];
  const sets = assignments.map((assignment) => {
    const field = workflowField(definition, assignment.fieldId);
    const column = q(field.name);
    values.push(
      field.type === 'jsonb' && assignment.value !== null
        ? JSON.stringify(assignment.value)
        : assignment.value,
    );
    const parameter = `$${values.length}::${sqlType(field)}`;
    if (assignment.operation === 'decrement') {
      guards.push(`${column} >= ${parameter}`);
      return `${column} = ${column} - ${parameter}`;
    }
    return `${column} = ${parameter}`;
  });
  if (ownership) {
    values.push(ownership.userId);
    guards.push(`${q(ownership.field)} = $${values.length}::pg_catalog.uuid`);
  }
  return {
    text: `UPDATE ONLY ${target(definition)} SET ${sets.join(', ')} WHERE "id" = $1::pg_catalog.uuid${guards.length ? ` AND ${guards.join(' AND ')}` : ''} RETURNING ${projection(definition, select)}`,
    values,
  };
}
export function workflowDelete(
  definition: Definition,
  id: string,
  ownership?: Ownership,
): Query {
  return {
    text: `DELETE FROM ONLY ${target(definition)} WHERE "id" = $1::pg_catalog.uuid${ownership ? ` AND ${q(ownership.field)} = $2::pg_catalog.uuid` : ''} RETURNING "id"`,
    values: ownership ? [id, ownership.userId] : [id],
  };
}
