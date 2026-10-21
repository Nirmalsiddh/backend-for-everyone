import { createHash } from 'node:crypto';
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
  async resolve(projectId: string, resource: string, includes: string[] = []) {
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
        const [project] = includes.length ? await tx.select({ runtimeState: projects.runtimeState })
          .from(projects).where(eq(projects.id, projectId)).limit(1) : [];
        const targetIds = row.applied?.definition.fields.flatMap((field) =>
          includes.includes(field.name) && field.relationship ? [field.relationship.tableId] : []) ?? [];
        const related = targetIds.length ? await tx.select({
          tableId: schemaTables.id,
          revision: schemaTables.appliedRevision,
          physicalRevision: schemaTables.appliedPhysicalRevision,
          applied: schemaTables.appliedDefinition,
          endpoint: endpoints,
        }).from(schemaTables).innerJoin(endpoints, and(
          eq(endpoints.tableId, schemaTables.id), eq(endpoints.projectId, projectId),
        )).where(and(eq(schemaTables.projectId, projectId),
          eq(schemaTables.connectionId, row.connection.id), inArray(schemaTables.id, targetIds))).limit(2) : [];
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
            appliedPhysicalRevision: schemaTables.appliedPhysicalRevision,
            appliedDefinition: schemaTables.appliedDefinition,
          })
          .from(schemaTables)
          .where(
            and(
              eq(schemaTables.projectId, projectId),
              eq(schemaTables.connectionId, row.connection.id),
            ),
          );
        managedTables.sort((a, b) => a.id.localeCompare(b.id));
        related.sort((a, b) => a.tableId.localeCompare(b.tableId));
        const blocked = !!active || (includes.length > 0 && project?.runtimeState !== 'active');
        const fingerprint = includes.length ? createHash('sha256').update(JSON.stringify({
          row, managedTables, related, project, blocked,
        })).digest('hex') : undefined;
        const relatedTargets = Object.fromEntries(related.map((candidate) => [candidate.tableId, {
          endpointId: candidate.endpoint.id, projectId,
          enabledOperations: candidate.endpoint.enabledOperations,
          policies: candidate.endpoint.policies,
          applied: candidate.applied && candidate.revision !== null
            ? { ...candidate.applied, managedTables } : null,
          connection: row.connection, blocked,
        }]));
        return {
          ...(fingerprint ? { fingerprint, relatedTargets } : {}),
          endpointId: row.endpoint.id,
          resourceName: row.endpoint.resourceName,
          projectId: row.endpoint.projectId,
          enabledOperations: row.endpoint.enabledOperations,
          policies: row.endpoint.policies,
          applied: row.applied ? { ...row.applied, managedTables } : null,
          connection: row.connection,
          blocked,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
