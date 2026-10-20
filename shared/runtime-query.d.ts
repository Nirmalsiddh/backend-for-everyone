import type { fieldTypes } from './public-contracts.js';
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is_null';
export interface QueryField {
  name: string;
  type: (typeof fieldTypes)[number];
  nullable: boolean;
  options: { length?: number; precision?: number; scale?: number };
}
export interface QueryCapabilities {
  version: 1;
  maxClauses: 5;
  maxInValues: 25;
  fields: (QueryField & { operators: FilterOperator[] })[];
}
export type PublicFilter = { field: string } & (
  { operator: 'in'; values: string[] } |
  { operator: Exclude<FilterOperator, 'in'> | 'legacy_eq'; value: string }
);
export const maxFilterClauses: 5;
export const maxInValues: 25;
export function filterOperators(field: Pick<QueryField, 'type' | 'nullable'>): FilterOperator[];
export function queryCapabilities(fields: QueryField[]): QueryCapabilities;
export function serializeRuntimeQuery(options?: {
  limit?: string | number; offset?: string | number; sort?: string; direction?: string;
  filters?: PublicFilter[]; includes?: string[];
}): string;
