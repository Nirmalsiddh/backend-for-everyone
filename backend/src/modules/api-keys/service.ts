import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ApiKeyRepository, KeyScope } from './types.js';
import { invalid } from '../schema-builder/errors.js';
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
export class ApiKeyService {
  constructor(private readonly repository: ApiKeyRepository) {}
  async create(projectId: string, ownerId: string, name: string, scope: KeyScope) {
    if (!name.trim() || name.trim().length > 100 || !['read', 'read_write'].includes(scope)) throw invalid('Invalid API key configuration');
    const key = `pk_${randomBytes(32).toString('base64url')}`;
    const metadata = await this.repository.create(projectId, ownerId, { id: randomUUID(), projectId, name: name.trim(), scope,
      keyHash: hashKey(key), keyPrefix: key.slice(0, 11), createdAt: new Date(), revokedAt: null });
    return { ...metadata, key };
  }
  list(projectId: string, ownerId: string) { return this.repository.list(projectId, ownerId); }
  revoke(projectId: string, ownerId: string, keyId: string) { return this.repository.revoke(projectId, ownerId, keyId); }
}
