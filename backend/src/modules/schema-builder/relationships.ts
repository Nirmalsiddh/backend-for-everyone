import { conflict, invalid } from './errors.js';
import type {
  ManagedTable,
  RelationshipDependency,
  TableRecord,
} from './types.js';

export function relationshipDependencies(
  table: TableRecord,
  tables: ManagedTable[],
): RelationshipDependency[] {
  const ids = new Set(
    table.fields.flatMap((f) =>
      f.relationship ? [f.relationship.tableId] : [],
    ),
  );
  if (ids.has(table.id))
    throw invalid('Self references are not supported in this version');
  const graph = new Map(
    tables.map((t) => [
      t.id,
      t.appliedDefinition?.definition.fields.flatMap((f) =>
        f.relationship ? [f.relationship.tableId] : [],
      ) ?? [],
    ]),
  );
  graph.set(table.id, [...ids]);
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id))
      throw invalid(
        'This relationship would create a circular table dependency, which is not supported in this version.',
      );
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of graph.get(id) ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  }
  visit(table.id);
  return [...ids].sort().map((id) => {
    const target = tables.find((t) => t.id === id);
    const record = target as TableRecord | undefined;
    if (id === table.id)
      throw invalid('Self references are not supported in this version');
    if (
      !target?.appliedDefinition ||
      target.appliedRevision === null ||
      record?.projectId !== table.projectId ||
      /^(platform_|internal_|pg_|schema_)/.test(
        target.appliedDefinition.definition.name,
      ) ||
      record?.connectionId !== table.connectionId ||
      target.appliedDefinition.definition.schema !== table.schemaName ||
      ['applying', 'outcome_unknown'].includes(
        record?.applyStatus?.status ?? '',
      )
    )
      throw conflict(
        'Reference target must be an available applied table in this project',
      );
    return {
      tableId: id,
      appliedRevision: target.appliedRevision,
      definition: target.appliedDefinition.definition,
      catalog: target.appliedDefinition.catalog,
    };
  });
}
