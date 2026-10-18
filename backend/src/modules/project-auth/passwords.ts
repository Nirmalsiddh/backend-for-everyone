import { createPasswordHasher as sharedHasher, validatePassword as sharedValidate, PasswordError } from '../../security/passwords.js';
import { RuntimeError, badRequest } from '../../runtime/errors.js';
import type { PasswordHasher } from './types.js';
function mapped(error: unknown): never {
  if (error instanceof PasswordError) {
    if (error.capacity) throw new RuntimeError(503, 'AUTH_CAPACITY_EXHAUSTED', 'Authentication capacity exhausted');
    throw badRequest();
  }
  throw error;
}
export function validatePassword(value: unknown, minimum = 15): asserts value is string {
  try { sharedValidate(value, minimum); } catch (error) { mapped(error); }
}
export function createPasswordHasher(capacity = 2): PasswordHasher {
  const hasher = sharedHasher(capacity);
  return {
    async hash(password) { try { return await hasher.hash(password); } catch (error) { return mapped(error); } },
    async verify(hash, password) { try { return await hasher.verify(hash, password); } catch (error) { return mapped(error); } },
    async dummyVerify(password) { try { await hasher.dummyVerify(password); } catch (error) { mapped(error); } },
  };
}
