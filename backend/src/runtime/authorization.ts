import type { Definition } from '../modules/schema-builder/types.js';
import type { Operation, OperationPolicy } from '../modules/endpoints/types.js';
import { operations } from '../modules/endpoints/types.js';
import { invalid } from '../modules/schema-builder/errors.js';
import { badRequest } from './errors.js';
export interface Ownership { field: string; userId: string }
export function validatePolicies(policies: Partial<Record<Operation, OperationPolicy>>, definition: Definition) {
  if (!policies || typeof policies !== 'object' || Array.isArray(policies)) throw invalid('Invalid authorization policies');
  for (const [operation, policy] of Object.entries(policies)) {
    if (!operations.includes(operation as Operation) || !policy || typeof policy !== 'object') throw invalid('Invalid authorization policy');
    const keys = policy.mode === 'owner' ? ['mode', 'ownerFieldId', 'allowAdmin'] : ['mode'];
    if (Object.keys(policy).some((key) => !keys.includes(key)) || !['key_only', 'authenticated', 'owner'].includes(policy.mode)) throw invalid('Invalid authorization policy');
    if (policy.mode === 'owner') {
      if (typeof policy.allowAdmin !== 'boolean' || !definition.fields.some((field) => field.id === policy.ownerFieldId && field.type === 'uuid')) throw invalid('Owner policies require an applied UUID field');
    }
  }
}
export function ownerColumn(definition: Definition, policy: OperationPolicy) {
  if (policy.mode !== 'owner') return undefined;
  const field = definition.fields.find((candidate) => candidate.id === policy.ownerFieldId && candidate.type === 'uuid');
  if (!field) throw badRequest(); return field.name;
}
