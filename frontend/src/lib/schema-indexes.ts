import type { Field, ManagedIndex } from './contracts';
export const indexableTypes = new Set(['uuid', 'integer', 'bigint', 'boolean', 'decimal', 'timestamp']);
export function validateIndexForms(indexes: ManagedIndex[], fields: Field[]) {
  if (indexes.length > 8) throw new Error('At most eight user indexes are supported.');
  const definitions = new Set<string>();
  for (const index of indexes) {
    if (index.fieldIds.length < 1 || index.fieldIds.length > 4 || new Set(index.fieldIds).size !== index.fieldIds.length) throw new Error('Choose one to four distinct ordered fields for each index.');
    for (const id of index.fieldIds) {
      const field = fields.find((candidate) => candidate.id === id);
      if (!id || !field || !indexableTypes.has(field.type)) throw new Error('Choose a saved eligible field for every index key.');
      if (index.unique && field.relationship) throw new Error('Unique reference indexes are not supported.');
      if (index.fieldIds.length === 1 && (field.relationship || field.unique)) throw new Error('An existing managed index already supplies this field.');
    }
    const key = JSON.stringify([index.unique, index.unique ? [...index.fieldIds].sort() : index.fieldIds]);
    if (definitions.has(key)) throw new Error('This index definition already exists.'); definitions.add(key);
  }
}
