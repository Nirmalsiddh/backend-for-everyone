import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { PlatformDatabase } from '../database/platform-db/client.js';
import {
  apiKeys,
  databaseConnections,
  endpoints,
  projects,
  schemaMigrations,
  schemaTables,
} from '../database/platform-db/schema.js';
import type { RuntimeRepository } from './types.js';
export class PostgresRuntimeRepository implements RuntimeRepository {
  constructor(private readonly db: PlatformDatabase) {}
  async authenticate(slug: string, keyHash: string) {
    const [identity] = await this.db
      .select({
        projectId: projects.id,
        keyId: apiKeys.id,
        scope: apiKeys.scope,
      })
      .from(projects)
      .innerJoin(apiKeys, eq(apiKeys.projectId, projects.id))
      .where(
        and(
          eq(projects.slug, slug),
          eq(apiKeys.keyHash, keyHash),
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1);
    return identity;
  }
  async resolve(projectId: string, resource: string) {
    return this.db.transaction(
      async (tx) => {
        const [row] = await tx
          .select({
            endpoint: endpoints,
            applied: schemaTables.appliedDefinition,
            connection: databaseConnections,
          })
          .from(endpoints)
          .innerJoin(
            schemaTables,
            and(
              eq(schemaTables.id, endpoints.tableId),
              eq(schemaTables.projectId, endpoints.projectId),
            ),
          )
          .innerJoin(
            databaseConnections,
            and(
              eq(databaseConnections.id, schemaTables.connectionId),
              eq(databaseConnections.projectId, endpoints.projectId),
            ),
          )
          .where(
            and(
              eq(endpoints.projectId, projectId),
              eq(endpoints.resourceName, resource),
            ),
          )
          .limit(1);
        if (!row) return undefined;
        const [active] = await tx
          .select({ id: schemaMigrations.id })
          .from(schemaMigrations)
          .where(
            and(
              eq(schemaMigrations.projectId, projectId),
              inArray(schemaMigrations.status, ['applying', 'outcome_unknown']),
            ),
          )
          .limit(1);
        const managedTables = await tx
          .select({
            id: schemaTables.id,
            appliedRevision: schemaTables.appliedRevision,
            appliedDefinition: schemaTables.appliedDefinition,
          })
          .from(schemaTables)
          .where(
            and(
              eq(schemaTables.projectId, projectId),
              eq(schemaTables.connectionId, row.connection.id),
            ),
          );
        return {
          endpointId: row.endpoint.id,
          projectId: row.endpoint.projectId,
          enabledOperations: row.endpoint.enabledOperations,
          policies: row.endpoint.policies,
          applied: row.applied ? { ...row.applied, managedTables } : null,
          connection: row.connection,
          blocked: !!active,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
