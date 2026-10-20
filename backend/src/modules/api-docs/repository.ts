import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PlatformDatabase } from '../../database/platform-db/client.js';
import {
  projects,
  schemaTables,
  schemaMigrations,
  endpoints,
  projectAuthConfigs,
  workflowEndpoints,
  workflowVersions,
} from '../../database/platform-db/schema.js';
import type { FieldDefinition } from '../schema-builder/types.js';
import type { DocsRepository } from './types.js';
export class PostgresDocsRepository implements DocsRepository {
  constructor(private readonly db: PlatformDatabase) {}
  snapshot(projectId: string, ownerId: string) {
    return this.db.transaction(
      async (tx) => {
        const [project] = await tx
          .select({ slug: projects.slug })
          .from(projects)
          .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
          .limit(1);
        if (!project) return undefined;
        // Deliberate projections: never select credentials, drafts, catalogs or auth table names.
        const resources = await tx
          .select({
            tableId: schemaTables.id,
            connectionId: schemaTables.connectionId,
            name: endpoints.resourceName,
            operations: endpoints.enabledOperations,
            policies: endpoints.policies,
            fields: sql<
              FieldDefinition[] | null
            >`${schemaTables.appliedDefinition}->'definition'->'fields'`,
          })
          .from(endpoints)
          .innerJoin(
            schemaTables,
            and(
              eq(schemaTables.id, endpoints.tableId),
              eq(schemaTables.projectId, projectId),
            ),
          )
          .where(eq(endpoints.projectId, projectId))
          .limit(501);
        const [auth] = await tx
          .select({
            enabled: projectAuthConfigs.enabled,
            signupEnabled: projectAuthConfigs.signupEnabled,
            provisioningStatus: projectAuthConfigs.provisioningStatus,
            sessionLifetimeSeconds: projectAuthConfigs.sessionLifetimeSeconds,
          })
          .from(projectAuthConfigs)
          .where(eq(projectAuthConfigs.projectId, projectId))
          .limit(1);
        const workflows = await tx
          .select({
            path: workflowEndpoints.path,
            definition: workflowVersions.definition,
            dependencies: workflowVersions.schemaDependencies,
          })
          .from(workflowEndpoints)
          .leftJoin(
            workflowVersions,
            and(
              eq(workflowVersions.id, workflowEndpoints.publishedVersionId),
              eq(workflowVersions.workflowEndpointId, workflowEndpoints.id),
            ),
          )
          .where(
            and(
              eq(workflowEndpoints.projectId, projectId),
              eq(workflowEndpoints.enabled, true),
            ),
          )
          .limit(501);
        const tables = await tx
          .select({
            id: schemaTables.id,
            connectionId: schemaTables.connectionId,
            appliedRevision: schemaTables.appliedRevision,
            name: sql<string>`${schemaTables.appliedDefinition}->'definition'->>'name'`,
            fields: sql<
              FieldDefinition[] | null
            >`${schemaTables.appliedDefinition}->'definition'->'fields'`,
          })
          .from(schemaTables)
          .where(eq(schemaTables.projectId, projectId))
          .limit(501);
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
        return {
          project,
          blocked:
            !!active ||
            resources.length > 500 ||
            workflows.length > 500 ||
            tables.length > 500,
          resources: resources.map((r) => ({
            name: r.name,
            includes: (r.fields ?? []).flatMap((field) => {
              const target = resources.find((candidate) => candidate.tableId === field.relationship?.tableId &&
                candidate.connectionId === r.connectionId && candidate.operations.includes('get'));
              const table = tables.find((candidate) => candidate.id === target?.tableId && candidate.appliedRevision !== null);
              return target?.fields && table && field.type === 'uuid' ? [{
                name: field.name, referenceName: target.name, fields: target.fields,
                policy: target.policies.get ?? { mode: 'key_only' as const },
              }] : [];
            }),
            relationshipDelete: tables.some((t) =>
              t.fields?.some((f) => f.relationship?.tableId === r.tableId),
            ),
            operations: r.operations,
            policies: r.policies,
            fields:
              r.fields?.map((f) => ({
                ...f,
                ...(f.relationship
                  ? {
                      referenceName:
                        tables.find(
                          (t) =>
                            t.id === f.relationship!.tableId &&
                            t.appliedRevision !== null,
                        )?.name ?? 'related record',
                    }
                  : {}),
              })) ?? null,
          })),
          ...(auth ? { auth } : {}),
          workflows: workflows.map((w) => ({
            ...w,
            dependencies: w.dependencies ?? [],
          })),
          tables: tables.map((t) => ({
            ...t,
            applied: t.appliedRevision !== null,
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
