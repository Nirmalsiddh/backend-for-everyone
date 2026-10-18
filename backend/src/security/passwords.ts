import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
export class PasswordError extends Error {
  constructor(public readonly capacity = false) { super(capacity ? 'Authentication capacity exhausted' : 'Invalid password'); }
}
export interface PasswordHasher { hash(password: string): Promise<string>; verify(hash: string, password: string): Promise<boolean>; dummyVerify(password: string): Promise<void> }
let active = 0;
export function validatePassword(value: unknown, minimum = 15): asserts value is string {
  if (typeof value !== 'string' || [...value].length < minimum || [...value].length > 128 || Buffer.byteLength(value) > 512) throw new PasswordError();
}
export function createPasswordHasher(capacity = 2): PasswordHasher {
  const options = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32 } as const;
  let dummy: Promise<string> | undefined;
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= capacity) throw new PasswordError(true);
    active++;
    try { return await operation(); } finally { active--; }
  }
  return {
    hash(password) { validatePassword(password); return bounded(() => argon2.hash(password, options)); },
    verify(hash, password) {
      validatePassword(password, 1);
      return bounded(async () => {
        // Never let a corrupted stored PHC string request unbounded memory/CPU.
        if (!/^\$argon2id\$v=19\$m=19456,(?:t=2,p=1|p=1,t=2)\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(hash)) return false;
        return argon2.verify(hash, password);
      });
    },
    dummyVerify(password) {
      validatePassword(password, 1);
      return bounded(async () => {
        dummy ??= argon2.hash(randomBytes(32).toString('hex'), options).catch((error: unknown) => { dummy = undefined; throw error; });
        await argon2.verify(await dummy!, password);
      });
    },
  };
}
