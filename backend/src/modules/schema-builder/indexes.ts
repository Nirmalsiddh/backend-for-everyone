import { randomUUID } from 'node:crypto';
import { canonical } from './plan.js';
import { invalid, conflict } from './errors.js';
import type { FieldDefinition, IndexInput, ManagedIndex } from './types.js';
export const indexableTypes = new Set(['uuid', 'integer', 'bigint', 'boolean', 'decimal', 'timestamp']);
export const indexName = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw invalid('Invalid index identity');
  return `ix_usr_${id.replaceAll('-', '').toLowerCase()}`;
};
export function normalizeIndexes(input: IndexInput[] | undefined, fields: FieldDefinition[], existing: ManagedIndex[] = [], applied: ManagedIndex[] = []): ManagedIndex[] {
  if (input === undefined) return existing;
  if (!Array.isArray(input) || input.length > 8) throw invalid('At most eight user indexes are supported');
  const ids = new Set<string>();
  const definitions = new Set<string>();
  const uniqueSets = new Set<string>();
  const result = input.map((item): ManagedIndex => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['id', 'fieldIds', 'unique'].includes(key)) ||
        typeof item.unique !== 'boolean' || !Array.isArray(item.fieldIds) || item.fieldIds.length < 1 || item.fieldIds.length > 4 || new Set(item.fieldIds).size !== item.fieldIds.length)
      throw invalid('Indexes require one to four distinct ordered fields');
    if (item.id !== undefined && (!existing.some((candidate) => candidate.id === item.id) || ids.has(item.id))) throw invalid('Unknown or duplicate index identity');
    const id = item.id ?? randomUUID(); ids.add(id); indexName(id);
    const selected = item.fieldIds.map((fieldId) => {
      const field = fields.find((candidate) => candidate.id === fieldId);
      if (!field || !indexableTypes.has(field.type)) throw invalid('Index fields must belong to this table and use a supported scalar type');
      if (item.unique && field.relationship) throw invalid('Unique reference indexes are not supported');
      return field;
    });
    if (selected.length === 1 && (selected[0]!.relationship || selected[0]!.unique)) throw invalid('An existing managed index already supplies this field');
    const key = canonical([item.unique, item.fieldIds]);
    const uniqueKey = canonical([...item.fieldIds].sort());
    if (definitions.has(key) || (item.unique && uniqueSets.has(uniqueKey))) throw invalid('Duplicate index definition');
    definitions.add(key); if (item.unique) uniqueSets.add(uniqueKey);
    return { id, specificationVersion: 1, fieldIds: [...item.fieldIds], unique: item.unique };
  });
  for (const index of result) if (!index.unique && !applied.some((old) => old.id === index.id) && result.some((candidate) => candidate.unique && canonical(candidate.fieldIds) === canonical(index.fieldIds)))
    throw invalid('A unique index already supplies these ordered fields');
  for (const index of applied) if (canonical(result.find((candidate) => candidate.id === index.id)) !== canonical(index)) throw conflict('Applied indexes cannot be changed or removed');
  return result.sort((a, b) => a.id.localeCompare(b.id));
}
