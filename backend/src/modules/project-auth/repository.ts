import { and, eq, inArray } from 'drizzle-orm';
import type { PlatformDatabase } from '../../database/platform-db/client.js';
import { databaseConnections, endpoints, projectAuthConfigs, projects, schemaMigrations } from '../../database/platform-db/schema.js';
import { conflict, missing } from '../schema-builder/errors.js';
import type { AuthInput, AuthRepository } from './types.js';
type Tx = Parameters<Parameters<PlatformDatabase['transaction']>[0]>[0];
export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly db: PlatformDatabase) {}
  private async lock(tx: Tx, projectId: string, ownerId: string) {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
    if (!project) throw missing();
    const [connection] = await tx.select().from(databaseConnections).where(eq(databaseConnections.projectId, project.id)).for('update');
    if (!connection) throw conflict('An existing customer database connection is required');
    return connection;
  }
  async configure(projectId: string, ownerId: string, input: AuthInput) {
    return this.db.transaction(async (tx) => {
      const connection = await this.lock(tx, projectId, ownerId);
      const [existing] = await tx.select().from(projectAuthConfigs).where(eq(projectAuthConfigs.projectId, connection.projectId));
      if ((existing?.revision ?? 0) !== input.expectedRevision) throw conflict('Auth configuration revision changed');
      if (existing && ['provisioning', 'outcome_unknown'].includes(existing.provisioningStatus)) throw conflict('Auth provisioning requires operator review');
      if (input.enabled) {
        const [endpoint] = await tx.select({ id: endpoints.id }).from(endpoints).where(and(eq(endpoints.projectId, connection.projectId), eq(endpoints.resourceName, 'auth')));
        if (endpoint) throw conflict('The auth resource is already configured as a table API');
      }
      const values = { enabled: input.enabled, signupEnabled: input.signupEnabled, sessionLifetimeSeconds: input.sessionLifetimeSeconds, updatedAt: new Date() };
      const [saved] = existing ? await tx.update(projectAuthConfigs).set({ ...values, revision: existing.revision + 1 }).where(eq(projectAuthConfigs.id, existing.id)).returning()
        : await tx.insert(projectAuthConfigs).values({ ...values, projectId: connection.projectId, connectionId: connection.id,
          authUsersTableName: `platform_auth_users_${connection.projectId.replaceAll('-', '')}`,
          authSessionsTableName: `platform_auth_sessions_${connection.projectId.replaceAll('-', '')}` }).returning();
      if (!saved) throw new Error('Auth configuration write failed');
      return saved;
    });
  }
  async getOwned(projectId: string, ownerId: string) {
    const [project] = await this.db.select({ slug: projects.slug }).from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
    if (!project) throw missing();
    const context = await this.bySlug(project.slug); if (!context) throw missing(); return context;
  }
  async bySlug(slug: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select({ config: projectAuthConfigs, connection: databaseConnections }).from(projectAuthConfigs)
        .innerJoin(projects, eq(projects.id, projectAuthConfigs.projectId))
        .innerJoin(databaseConnections, and(eq(databaseConnections.id, projectAuthConfigs.connectionId), eq(databaseConnections.projectId, projectAuthConfigs.projectId)))
        .where(eq(projects.slug, slug));
      if (!row) return undefined;
      const [active] = await tx.select({ id: schemaMigrations.id }).from(schemaMigrations).where(and(eq(schemaMigrations.projectId, row.config.projectId), inArray(schemaMigrations.status, ['applying', 'outcome_unknown'])));
      return { ...row, blocked: !!active };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  async begin(projectId: string, ownerId: string, revision: number) {
    await this.db.transaction(async (tx) => {
      const connection = await this.lock(tx, projectId, ownerId);
      const [config] = await tx.select().from(projectAuthConfigs).where(eq(projectAuthConfigs.projectId, connection.projectId)).for('update');
      if (!config) throw missing();
      if (config.revision !== revision || !['unprovisioned', 'failed'].includes(config.provisioningStatus)) throw conflict('Auth provisioning state or revision changed');
      await tx.update(projectAuthConfigs).set({ provisioningStatus: 'provisioning', revision: revision + 1, updatedAt: new Date() }).where(eq(projectAuthConfigs.id, config.id));
    });
    return this.getOwned(projectId, ownerId);
  }
  async finish(projectId: string, ownerId: string, revision: number, status: 'ready' | 'failed' | 'outcome_unknown', catalog: unknown) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, projectId, ownerId);
      const [config] = await tx.update(projectAuthConfigs).set({ provisioningStatus: status, catalog, revision: revision + 1, updatedAt: new Date() })
        .where(and(eq(projectAuthConfigs.projectId, projectId), eq(projectAuthConfigs.revision, revision), eq(projectAuthConfigs.provisioningStatus, 'provisioning'))).returning({ id: projectAuthConfigs.id });
      if (!config) throw conflict('Auth provisioning state changed');
    });
  }
}
