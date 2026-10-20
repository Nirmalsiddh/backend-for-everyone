import { createHash } from 'node:crypto';
import { canonical, generateLegacyPlan, quoteIdentifier as q } from './plan.js';
import { indexName, normalizeIndexes } from './indexes.js';
import { relationshipDependencies } from './relationships.js';
import { conflict } from './errors.js';
import type { EvolutionAction, ManagedTable, Plan, RelationshipDependency, TableRecord } from './types.js';
export function needsEvolution(table: TableRecord) {
  return !!table.indexes?.length || !!table.appliedDefinition?.definition.indexes ||
    (table.appliedDefinition?.catalog as { version?: number } | undefined)?.version === 3 ||
    !!table.appliedDefinition?.definition.fields.some((old) => old.nullable && table.fields.find((field) => field.id === old.id)?.nullable === false);
}
export function generateEvolutionPlan(table: TableRecord, tables: ManagedTable[], bound?: RelationshipDependency[]): Plan {
  const before = table.appliedDefinition;
  const oldIndexes = before?.definition.indexes ?? [];
  const indexes = normalizeIndexes((table.indexes ?? []).map(({ specificationVersion: _, ...index }) => index), table.fields, table.indexes ?? [], oldIndexes);
  const dependencies = bound ?? relationshipDependencies(table, tables).map((dependency) => ({
    ...dependency, appliedPhysicalRevision: tables.find((candidate) => candidate.id === dependency.tableId)?.appliedPhysicalRevision ?? dependency.appliedRevision,
  }));
  const definition = { schema: table.schemaName, name: table.name, fields: table.fields, indexes };
  const actions: EvolutionAction[] = indexes.filter((index) => !oldIndexes.some((old) => old.id === index.id))
    .map((index) => ({ kind: index.unique ? 'create_unique_index' : 'create_index', index }));
  const additions = table.fields.filter((field) => !before?.definition.fields.some((old) => old.id === field.id));
  let statements: string[] = [];
  const target = `${q(table.schemaName)}.${q(table.name)}`;
  if (before) {
    if (before.definition.name !== table.name || before.definition.schema !== table.schemaName) throw conflict('Applied tables cannot be renamed');
    for (const old of before.definition.fields) {
      const field = table.fields.find((candidate) => candidate.id === old.id);
      if (field && old.nullable && !field.nullable && canonical({ ...field, nullable: true }) === canonical(old)) actions.push({ kind: 'set_not_null', fieldId: field.id });
      else if (canonical(field) !== canonical(old)) throw conflict('Only nullable to required changes are supported for applied fields');
    }
    if (actions.length > 1 || (actions.length && additions.length)) throw conflict('Apply one index addition or one required-field change at a time');
    if (actions.some((action) => action.kind !== 'set_not_null' && action.index.fieldIds.some((id) => !before.definition.fields.some((field) => field.id === id)))) throw conflict('Post-Apply indexes require applied fields');
  }
  if (!before || additions.length) {
    // Legacy column/FK statement generation is kept byte-for-byte; only new plans wrap it.
    statements = generateLegacyPlan(table, tables, dependencies).statements;
  }
  for (const action of actions) {
    if (action.kind === 'set_not_null') statements.push(`ALTER TABLE ${target} ALTER COLUMN ${q(table.fields.find((field) => field.id === action.fieldId)!.name)} SET NOT NULL;`);
    else statements.push(`CREATE ${action.index.unique ? 'UNIQUE ' : ''}INDEX ${q(indexName(action.index.id))} ON ${target} USING btree (${action.index.fieldIds.map((id) => q(table.fields.find((field) => field.id === id)!.name)).join(', ')});`);
  }
  if (!statements.length) throw conflict('There are no schema changes to apply');
  const contractChange = !before || additions.length > 0 || actions.some((action) => action.kind !== 'create_index');
  const evolution = { version: 3 as const, dependencies, actions, contractChange, before,
    appliedRevision: table.appliedRevision, appliedPhysicalRevision: table.appliedPhysicalRevision ?? table.appliedRevision };
  const content = { version: 3 as const, tableId: table.id, connectionId: table.connectionId, revision: table.draftRevision,
    evolution, definition, statements, operation: before ? 'evolve_table' as const : 'create_table' as const };
  return { ...content, hash: createHash('sha256').update(canonical(content)).digest('hex'), managedTables: tables, dependencies };
}
