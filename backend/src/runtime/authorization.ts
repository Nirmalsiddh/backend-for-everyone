import type { Definition } from '../modules/schema-builder/types.js';
import type { Operation, OperationPolicy } from '../modules/endpoints/types.js';
import { operations } from '../modules/endpoints/types.js';
import { invalid } from '../modules/schema-builder/errors.js';
import { badRequest } from './errors.js';
export interface Ownership {
  field: string;
  userId: string;
}
export function validatePolicies(
  policies: Partial<Record<Operation, OperationPolicy>>,
  definition: Definition,
) {
  if (!policies || typeof policies !== 'object' || Array.isArray(policies))
    throw invalid('Invalid authorization policies');
  for (const [operation, policy] of Object.entries(policies)) {
    if (
      !operations.includes(operation as Operation) ||
      !policy ||
      typeof policy !== 'object'
    )
      throw invalid('Invalid authorization policy');
    const keys =
      policy.mode === 'owner'
        ? ['mode', 'ownerFieldId', 'allowAdmin']
        : ['mode'];
    if (
      Object.keys(policy).some((key) => !keys.includes(key)) ||
      !['key_only', 'authenticated', 'owner'].includes(policy.mode)
    )
      throw invalid('Invalid authorization policy');
    if (policy.mode === 'owner') {
      if (
        typeof policy.allowAdmin !== 'boolean' ||
        !definition.fields.some(
          (field) =>
            field.id === policy.ownerFieldId &&
            field.type === 'uuid' &&
            !field.relationship,
        )
      )
        throw invalid('Owner policies require an applied UUID field');
    }
  }
}
export function ownerColumn(definition: Definition, policy: OperationPolicy) {
  if (policy.mode !== 'owner') return undefined;
  const field = definition.fields.find(
    (candidate) =>
      candidate.id === policy.ownerFieldId && candidate.type === 'uuid',
  );
  if (!field) throw badRequest();
  return field.name;
}

// Derive authorization independently for every operation, including related GETs.
export function authorizeRead(definition: Definition, policy: OperationPolicy,
  identity: import('./types.js').RuntimePrincipal) {
  const isUser = 'kind' in identity && identity.kind === 'user';
  if ((policy.mode === 'key_only') === isUser) return { compatible: false as const };
  const owner = ownerColumn(definition, policy);
  const ownership = owner && isUser && !(policy.mode === 'owner' && policy.allowAdmin && identity.role === 'admin')
    ? { field: owner, userId: identity.userId } : undefined;
  return { compatible: true as const, ownership };
}
