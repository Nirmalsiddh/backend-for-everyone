const projectKeys = ['id', 'name', 'slug', 'runtimeState', 'createdAt'];
const tableKeys = [
  'id',
  'name',
  'draftRevision',
  'appliedRevision',
  'appliedPhysicalRevision',
  'indexes',
  'fields',
  'appliedDefinition',
  'applyStatus',
];
const fieldKeys = [
  'id',
  'name',
  'type',
  'nullable',
  'unique',
  'options',
  'default',
  'relationship',
];
export function pick(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unexpected response shape');
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((k) => Object.hasOwn(source, k)).map((k) => [k, source[k]]),
  );
}
export function projectDto(value: unknown) {
  return pick(value, projectKeys);
}
function fieldDto(value: unknown) {
  const row = pick(value, fieldKeys);
  if (row.relationship)
    row.relationship = pick(row.relationship, ['tableId', 'onDelete']);
  return row;
}
export function tableDto(value: unknown): unknown {
  const row = pick(value, tableKeys);
  if (row.indexes) row.indexes = (row.indexes as unknown[]).map((index) => pick(index, ['id', 'specificationVersion', 'fieldIds', 'unique']));
  row.fields = (row.fields as unknown[]).map((f) => fieldDto(f));
  if (row.appliedDefinition) {
    const d = (
      row.appliedDefinition as {
        definition: { name: string; fields: unknown[]; indexes?: unknown[] };
      }
    ).definition;
    row.appliedDefinition = {
      definition: {
        name: d.name,
        ...(d.indexes ? { indexes: d.indexes.map((index) => pick(index, ['id', 'specificationVersion', 'fieldIds', 'unique'])) } : {}),
        fields: d.fields.map((f) => fieldDto(f)),
      },
    };
  }
  return row;
}
