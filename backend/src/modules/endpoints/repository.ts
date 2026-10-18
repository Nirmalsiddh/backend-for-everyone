import { lockProjectResource } from '../../database/platform-db/resource-reservation.js';
import { validatePolicies } from '../../runtime/authorization.js';
import { and, eq } from 'drizzle-orm';
import type { PlatformDatabase } from '../../database/platform-db/client.js';
import { databaseConnections, endpoints, projectAuthConfigs, projects, schemaTables, workflowEndpoints } from '../../database/platform-db/schema.js';
import { conflict, missing } from '../schema-builder/errors.js';
import type { EndpointInput, EndpointRepository } from './types.js';

export class PostgresEndpointRepository implements EndpointRepository {
  constructor(private readonly db: PlatformDatabase) {}
  private async owned(projectId: string, ownerId: string) {
    const [project] = await this.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
    if (!project) throw missing();
  }
  async list(projectId: string, ownerId: string) {
    await this.owned(projectId, ownerId);
    return this.db.select({ endpoint: endpoints }).from(endpoints).innerJoin(projects, eq(projects.id, endpoints.projectId))
      .where(and(eq(endpoints.projectId, projectId), eq(projects.ownerId, ownerId))).then((rows) => rows.map((row) => row.endpoint));
  }
  async get(projectId: string, ownerId: string, tableId: string) {
    const [row] = await this.db.select({ endpoint: endpoints }).from(endpoints).innerJoin(projects, eq(projects.id, endpoints.projectId))
      .where(and(eq(endpoints.projectId, projectId), eq(endpoints.tableId, tableId), eq(projects.ownerId, ownerId)));
    if (!row) throw missing();
    return row.endpoint;
  }
  async save(projectId: string, ownerId: string, tableId: string, input: EndpointInput) {
    return this.db.transaction(async (tx) => {
      await lockProjectResource(tx, projectId, ownerId);
      await tx.select({ id: databaseConnections.id }).from(databaseConnections).innerJoin(projects, eq(projects.id, databaseConnections.projectId))
        .where(and(eq(databaseConnections.projectId, projectId), eq(projects.ownerId, ownerId))).for('update', { of: databaseConnections });
      const [table] = await tx.select({ table: schemaTables }).from(schemaTables).innerJoin(projects, eq(projects.id, schemaTables.projectId))
        .where(and(eq(schemaTables.id, tableId), eq(schemaTables.projectId, projectId), eq(projects.ownerId, ownerId))).for('update', { of: schemaTables });
      if (!table) throw missing();
      if (!table.table.appliedDefinition || input.expectedAppliedRevision !== table.table.appliedRevision) throw conflict('A matching successfully applied table revision is required');
      const [existing] = await tx.select().from(endpoints).where(and(eq(endpoints.tableId, tableId), eq(endpoints.projectId, projectId)));
      if ((existing?.revision ?? 0) !== input.expectedConfigRevision) throw conflict('Endpoint configuration revision changed');
      const name = table.table.appliedDefinition.definition.name;
      const [workflow] = await tx.select({ id: workflowEndpoints.id }).from(workflowEndpoints).where(and(eq(workflowEndpoints.projectId, projectId), eq(workflowEndpoints.path, name)));
      if (workflow) throw conflict('Resource is reserved by a workflow');
      if (/^(platform_|internal_|pg_|schema_)/.test(name)) throw conflict('Internal resources cannot expose generic endpoints');
      const [auth] = await tx.select().from(projectAuthConfigs).where(eq(projectAuthConfigs.projectId, projectId));
      if (name === 'auth' && auth?.enabled) throw conflict('The auth resource is reserved');
      const policies = input.policies ?? existing?.policies ?? {};
      validatePolicies(policies, table.table.appliedDefinition.definition);
      if (Object.values(policies).some((policy) => policy.mode !== 'key_only') && (!auth?.enabled || auth.provisioningStatus !== 'ready')) throw conflict('Provision and enable project auth before configuring protected policies');
      const values = { policies, enabledOperations: input.enabledOperations, resourceName: table.table.appliedDefinition.definition.name, updatedAt: new Date() };
      const [saved] = existing
        ? await tx.update(endpoints).set({ ...values, revision: existing.revision + 1 }).where(and(eq(endpoints.id, existing.id), eq(endpoints.projectId, projectId))).returning()
        : await tx.insert(endpoints).values({ ...values, projectId: table.table.projectId, tableId }).returning();
      if (!saved) throw new Error('Endpoint write returned no record');
      return saved;
    });
  }
}
