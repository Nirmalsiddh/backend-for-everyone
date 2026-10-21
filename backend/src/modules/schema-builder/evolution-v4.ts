import { createHash } from 'node:crypto';
import { canonical, sqlType } from './plan.js';
import { normalizeIndexes } from './indexes.js';
import { relationshipDependencies } from './relationships.js';
import { conflict, invalid } from './errors.js';
import { validateScalar } from './validation.js';
import type { FieldDefinition, ManagedTable, Plan, RelationshipDependency, TableRecord } from './types.js';

export const literalDefaultTypes = ['text', 'varchar', 'integer', 'bigint', 'decimal', 'boolean'] as const;
export function needsV4(table: TableRecord) {
  const before = table.appliedDefinition;
  return !!before && (table.fields.some((field) => field.backfillIntent !== undefined ||
    (!before.definition.fields.some((old) => old.id === field.id) && (!field.nullable || field.default !== null)) ||
    before.definition.fields.some((old) => old.id === field.id && canonical(old.default) !== canonical(field.default))));
}
export function managedLiteral(field: FieldDefinition) {
  if (!literalDefaultTypes.some((type) => type === field.type) || field.relationship || field.default?.kind !== 'literal') throw invalid('New managed defaults require a supported literal type');
  validateScalar(field, field.default.value);
  return field.default.value;
}
export function defaultSql(field: FieldDefinition) {
  const value = managedLiteral(field);
  // The literal has passed scalar validation. E strings are independent of standard_conforming_strings.
  const text = String(value).replaceAll('\\', '\\\\').replaceAll("'", "''");
  return `E'${text}'::${sqlType(field)}`;
}
export function generateV4Plan(table: TableRecord, tables: ManagedTable[] = [], bound?: RelationshipDependency[]): Plan {
  const before = table.appliedDefinition;
  if (!before || before.definition.name !== table.name || before.definition.schema !== table.schemaName) throw conflict('Field evolution requires an applied table');
  const fields = table.fields.map(({ backfillIntent: _, ...field }) => field);
  const indexes = normalizeIndexes((table.indexes ?? []).map(({ specificationVersion: _, ...index }) => index), fields, table.indexes ?? [], before.definition.indexes ?? []);
  if (canonical(indexes) !== canonical(before.definition.indexes ?? [])) throw conflict('Apply a field bundle separately from index additions');
  const changed = table.fields.filter(({ backfillIntent, ...field }) => backfillIntent !== undefined || canonical(field) !== canonical(before.definition.fields.find((old) => old.id === field.id)));
  if (changed.length !== 1 || before.definition.fields.some((old) => !fields.some((field) => field.id === old.id))) throw conflict('Apply one field evolution bundle at a time');
  const draft = changed[0]!;
  const field = fields.find((candidate) => candidate.id === draft.id)!;
  const old = before.definition.fields.find((candidate) => candidate.id === field.id);
  const addition = !old;
  if (old && canonical({ ...field, default: old.default, nullable: old.nullable }) !== canonical(old)) throw conflict('Only defaults and nullable to required transitions are supported');
  if (old && !old.nullable && field.nullable) throw conflict('Required fields cannot become nullable');
  if (addition && field.unique) throw conflict('New applied fields cannot introduce inline uniqueness');
  const defaultChanged = addition ? field.default !== null : canonical(old.default) !== canonical(field.default);
  if (defaultChanged && (field.type === 'jsonb' || field.type === 'uuid' || field.relationship)) throw invalid('Default evolution is unsupported for this field type');
  if (defaultChanged && field.default) managedLiteral(field);
  const enforceRequired = !field.nullable && (addition || old!.nullable);
  if (draft.backfillIntent !== undefined) {
    if (!enforceRequired || field.type === 'jsonb') throw invalid('Fill requires a supported final requiredness transition');
    if (draft.backfillIntent.kind !== 'literal' || !Object.hasOwn(draft.backfillIntent, 'value')) throw invalid('Invalid fill intent');
    validateScalar(field, draft.backfillIntent.value);
  }
  if (addition && enforceRequired && draft.backfillIntent === undefined && !field.default) throw conflict('New required fields need a fill or supported future default');
  if (addition && enforceRequired && field.default) managedLiteral(field);
  const dependencies = bound ?? relationshipDependencies(table, tables).map((dependency) => ({ ...dependency,
    appliedPhysicalRevision: tables.find((candidate) => candidate.id === dependency.tableId)?.appliedPhysicalRevision ?? dependency.appliedRevision }));
  const bundle = { fieldId: field.id, addition, enforceRequired, defaultChanged, ...(draft.backfillIntent !== undefined ? { fill: draft.backfillIntent } : {}) };
  const evolution = { version: 4 as const, dependencies, actions: [], contractChange: true, before,
    appliedRevision: table.appliedRevision, appliedPhysicalRevision: table.appliedPhysicalRevision ?? table.appliedRevision, bundle };
  const definition = { schema: table.schemaName, name: table.name, fields, indexes };
  const content = { version: 4 as const, tableId: table.id, connectionId: table.connectionId, revision: table.draftRevision,
    evolution, definition, statements: [] as string[], operation: 'evolve_table' as const };
  return { ...content, hash: createHash('sha256').update(canonical(content)).digest('hex'), managedTables: tables, dependencies };
}

export function v4Preview(plan: Plan) {
  if (plan.evolution?.version !== 4) return undefined;
  const bundle = plan.evolution.bundle;
  const field = plan.definition.fields.find((candidate) => candidate.id === bundle.fieldId)!;
  return [
    ...(bundle.addition ? [{ kind: 'add_field', field: field.name, description: `Add field ${field.name}.` }] : []),
    ...(bundle.fill || (bundle.addition && bundle.enforceRequired) ? [{ kind: 'fill_nulls', field: field.name, description: `Existing NULL values in ${field.name} will be replaced.` }] : []),
    ...(bundle.defaultChanged ? [{ kind: field.default ? 'set_default' : 'remove_default', field: field.name, description: field.default ? `Future inserts that omit ${field.name} will use the configured default.` : `Remove the future default for ${field.name}.` }] : []),
    ...(bundle.enforceRequired ? [{ kind: 'set_not_null', field: field.name, description: `${field.name} will become required.` }] : []),
    ...(field.relationship && bundle.addition ? [{ kind: 'add_reference', field: field.name, description: `Values in ${field.name} must reference an existing target record.` }] : []),
  ];
}
