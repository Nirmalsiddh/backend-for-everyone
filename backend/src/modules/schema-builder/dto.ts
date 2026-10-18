import type { TableRecord } from './types.js';
export function schemaTableDto(table: TableRecord) {
  return {
    id: table.id,
    projectId: table.projectId,
    connectionId: table.connectionId,
    schemaName: table.schemaName,
    name: table.name,
    draftRevision: table.draftRevision,
    appliedRevision: table.appliedRevision,
    createdAt: table.createdAt,
    updatedAt: table.updatedAt,
    fields: table.fields,
    appliedDefinition: table.appliedDefinition
      ? { definition: table.appliedDefinition.definition }
      : null,
    applyStatus: table.applyStatus ?? null,
  };
}
