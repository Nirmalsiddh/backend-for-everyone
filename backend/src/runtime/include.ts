import { RuntimeError } from './errors.js';
export const invalidInclude = () => new RuntimeError(400, 'INVALID_INCLUDE', 'Invalid relationship include');
export const includeUnavailable = () => new RuntimeError(403, 'INCLUDE_UNAVAILABLE', 'Requested relationship expansion is unavailable');
export const metadataChanged = () => new RuntimeError(503, 'RUNTIME_METADATA_CHANGED', 'Runtime metadata changed; retry the request');
export function parseInclude(query: Record<string, unknown>): string[] {
  if (Object.keys(query).some((key) => /^include[.\[\]]/.test(key))) throw invalidInclude();
  if (!Object.hasOwn(query, 'include')) return [];
  const value = query.include;
  if (typeof value !== 'string') throw invalidInclude();
  const names = value.split(',');
  if (names.length > 2 || new Set(names).size !== names.length ||
      names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name))) throw invalidInclude();
  return names;
}
