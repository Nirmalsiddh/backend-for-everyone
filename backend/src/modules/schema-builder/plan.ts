import { relationshipDependencies } from './relationships.js';
import { createHash } from 'node:crypto';
import { conflict, invalid } from './errors.js';
import { validateIdentifier, validateTargetSchema } from './validation.js';
import type {
  Definition,
  ManagedTable,
  RelationshipDependency,
  FieldDefinition,
  Plan,
  TableRecord,
} from './types.js';

// Canonical serialization makes object key order irrelevant to plan hashes and comparisons.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function quoteIdentifier(value: string) {
  if (!value || value.includes('\0') || Buffer.byteLength(value) > 63)
    throw invalid('Invalid SQL identifier');
  return `"${value.replaceAll('"', '""')}"`;
}
export function sqlType(field: FieldDefinition) {
  switch (field.type) {
    case 'varchar':
      return `pg_catalog.varchar(${field.options.length})`;
    case 'decimal':
      return `pg_catalog.numeric(${field.options.precision},${field.options.scale})`;
    case 'integer':
      return 'pg_catalog.int4';
    case 'bigint':
      return 'pg_catalog.int8';
    case 'boolean':
      return 'pg_catalog.bool';
    case 'timestamp':
      return 'pg_catalog.timestamptz';
    default:
      return `pg_catalog.${field.type}`;
  }
}
function literal(field: FieldDefinition): string {
  const def = field.default!;
  if (def.kind === 'current_timestamp') return 'CURRENT_TIMESTAMP';
  const value = def.value;
  if (field.type === 'integer') return String(value);
  if (field.type === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = field.type === 'jsonb' ? canonical(value) : String(value);
  // E strings explicitly escape both backslashes and quotes, independent of session settings.
  return `E'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'::${sqlType(field)}`;
}
function fieldSql(field: FieldDefinition) {
  validateIdentifier(field.name);
  const unique = field.unique
    ? ` CONSTRAINT ${quoteIdentifier(`uq_${field.id.replaceAll('-', '')}`)} UNIQUE`
    : '';
  return `${quoteIdentifier(field.name)} ${sqlType(field)}${field.nullable ? '' : ' NOT NULL'}${field.default ? ` DEFAULT ${literal(field)}` : ''}${unique}`;
}
export function generatePlan(
  table: TableRecord,
  tables: ManagedTable[] = [],
  bound?: RelationshipDependency[],
): Plan {
  const dependencies = bound ?? relationshipDependencies(table, tables);
  validateIdentifier(table.name);
  validateTargetSchema(table.schemaName);
  const definition: Definition = {
    schema: table.schemaName,
    name: table.name,
    fields: table.fields,
  };
  const target = `${quoteIdentifier(definition.schema)}.${quoteIdentifier(definition.name)}`;
  let statements: string[];
  let operation: Plan['operation'];
  if (!table.appliedDefinition) {
    operation = 'create_table';
    statements = [
      `CREATE TABLE ${target} (\n  ${[
        `"id" pg_catalog.uuid CONSTRAINT ${quoteIdentifier(`pk_${table.id.replaceAll('-', '')}`)} PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid()`,
        ...definition.fields.map(fieldSql),
      ].join(',\n  ')}\n);`,
    ];
  } else {
    operation = 'add_columns';
    const before = table.appliedDefinition.definition;
    if (before.name !== definition.name || before.schema !== definition.schema)
      throw conflict('Renaming applied tables is not supported');
    for (const field of before.fields) {
      if (
        canonical(
          definition.fields.find((candidate) => candidate.id === field.id),
        ) !== canonical(field)
      )
        throw conflict('Existing applied fields cannot be changed or removed');
    }
    const additions = definition.fields.filter(
      (field) => !before.fields.some((old) => old.id === field.id),
    );
    if (!additions.length)
      throw conflict('There are no schema changes to apply');
    if (
      additions.some(
        (field) => !field.nullable || field.unique || field.default,
      )
    )
      throw conflict(
        'New columns on applied tables must be nullable without defaults or uniqueness',
      );
    statements = additions.map(
      (field) => `ALTER TABLE ${target} ADD COLUMN ${fieldSql(field)};`,
    );
  }
  const oldIds = new Set(
    table.appliedDefinition?.definition.fields.map((f) => f.id) ?? [],
  );
  for (const field of definition.fields.filter(
    (f) => f.relationship && !oldIds.has(f.id),
  )) {
    const dependency = dependencies.find(
      (d) => d.tableId === field.relationship!.tableId,
    );
    if (!dependency) throw invalid('Reference target is unavailable');
    const name = field.id.replaceAll('-', '');
    statements.push(
      `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdentifier(`fk_${name}`)} FOREIGN KEY (${quoteIdentifier(field.name)}) REFERENCES ${quoteIdentifier(dependency.definition.schema)}.${quoteIdentifier(dependency.definition.name)} ("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE;`,
    );
    statements.push(
      `CREATE INDEX ${quoteIdentifier(`ix_fk_${name}`)} ON ${target} USING btree (${quoteIdentifier(field.name)});`,
    );
  }
  const relationshipPlan = dependencies.length
    ? { version: 2 as const, dependencies }
    : {};
  const content = {
    ...relationshipPlan,
    tableId: table.id,
    connectionId: table.connectionId,
    revision: table.draftRevision,
    appliedRevision: table.appliedRevision,
    definition,
    statements,
    operation,
  };
  return {
    ...relationshipPlan,
    ...(tables.length ? { managedTables: tables } : {}),
    hash: createHash('sha256').update(canonical(content)).digest('hex'),
    revision: table.draftRevision,
    definition,
    statements,
    operation,
  };
}
