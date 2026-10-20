import { enforceQuota } from '../../operations/quotas.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { PlatformDatabase } from '../../database/platform-db/client.js';
import { apiKeys, projects } from '../../database/platform-db/schema.js';
import { missing } from '../schema-builder/errors.js';
import type { ApiKeyRecord, ApiKeyRepository } from './types.js';
const columns = {
  id: apiKeys.id,
  projectId: apiKeys.projectId,
  name: apiKeys.name,
  keyPrefix: apiKeys.keyPrefix,
  scope: apiKeys.scope,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
};
export class PostgresApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly db: PlatformDatabase) {}
  async create(projectId: string, ownerId: string, key: ApiKeyRecord) {
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
        .for('share');
      if (!project) throw missing();
      await enforceQuota(tx, 'api_keys', projectId);
      const [saved] = await tx
        .insert(apiKeys)
        .values({ ...key, projectId: project.id })
        .returning(columns);
      if (!saved) throw new Error('Key insert returned no record');
      return saved;
    });
  }
  async list(projectId: string, ownerId: string) {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
    if (!project) throw missing();
    return this.db
      .select(columns)
      .from(apiKeys)
      .innerJoin(projects, eq(projects.id, apiKeys.projectId))
      .where(
        and(eq(apiKeys.projectId, projectId), eq(projects.ownerId, ownerId)),
      );
  }
  async revoke(projectId: string, ownerId: string, keyId: string) {
    const [key] = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.projectId, projectId),
          inArray(
            apiKeys.projectId,
            this.db
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.ownerId, ownerId)),
          ),
        ),
      )
      .returning({ id: apiKeys.id });
    if (!key) throw missing();
  }
}
