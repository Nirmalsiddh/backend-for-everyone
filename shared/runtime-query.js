// Public query vocabulary and URL encoding only; no persistence metadata.
export const maxFilterClauses = 5;
export const maxInValues = 25;
export function filterOperators(field) {
  if (field.type === 'jsonb') return [];
  const operators = ['eq', 'neq'];
  if (['integer', 'bigint', 'decimal', 'date', 'timestamp'].includes(field.type))
    operators.push('gt', 'gte', 'lt', 'lte');
  if (['uuid', 'integer', 'bigint', 'decimal', 'text', 'varchar'].includes(field.type))
    operators.push('in');
  if (field.nullable) operators.push('is_null');
  return operators;
}
export function queryCapabilities(fields) {
  return {
    version: 1, maxClauses: maxFilterClauses, maxInValues,
    fields: [{ name: 'id', type: 'uuid', nullable: false, options: {} }, ...fields]
      .map(({ name, type, nullable, options }) => ({
        name, type, nullable, options: { ...options },
        operators: filterOperators({ type, nullable }),
      })).filter((field) => field.operators.length),
  };
}
export function serializeRuntimeQuery(options = {}) {
  const query = new URLSearchParams();
  for (const key of ['limit', 'offset', 'sort', 'direction'])
    if (options[key] !== undefined && options[key] !== '') query.set(key, String(options[key]));
  for (const filter of [...(options.filters ?? [])].sort((a, b) =>
    a.field < b.field ? -1 : a.field > b.field ? 1 : a.operator < b.operator ? -1 : a.operator > b.operator ? 1 : 0)) {
    const key = `filter[${filter.field}]${filter.operator === 'legacy_eq' ? '' : `[${filter.operator}]`}`;
    query.append(key, filter.operator === 'in' ? JSON.stringify(filter.values) : filter.value);
  }
  if (options.includes?.length) query.set('include', [...options.includes].sort().join(','));
  return query.toString();
}
