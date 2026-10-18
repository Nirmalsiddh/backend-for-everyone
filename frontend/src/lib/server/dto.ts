const projectKeys = ['id', 'name', 'slug', 'createdAt'];
const tableKeys = [
  'id',
  'name',
  'draftRevision',
  'appliedRevision',
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
export function tableDto(value: unknown): unknown {
  const row = pick(value, tableKeys);
  row.fields = (row.fields as unknown[]).map((f) => pick(f, fieldKeys));
  if (row.appliedDefinition) {
    const d = (
      row.appliedDefinition as {
        definition: { name: string; fields: unknown[] };
      }
    ).definition;
    row.appliedDefinition = {
      definition: {
        name: d.name,
        fields: d.fields.map((f) => pick(f, fieldKeys)),
      },
    };
  }
  return row;
}
