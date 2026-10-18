import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PlatformDatabase } from '../../database/platform-db/client.js';
import {
  databaseConnections,
  endpoints,
  projects,
  schemaMigrations,
  schemaTables,
  workflowEndpoints,
  workflowVersions,
} from '../../database/platform-db/schema.js';
import { lockProjectResource } from '../../database/platform-db/resource-reservation.js';
import { conflict, missing } from '../schema-builder/errors.js';
import {
  inspectWorkflow,
  previewWorkflow,
  validatePath,
} from './validation.js';
import type { WorkflowDefinition, WorkflowRepository } from './types.js';
export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: PlatformDatabase) {}
  private owned(projectId: string, ownerId: string) {
    return and(
      eq(workflowEndpoints.projectId, projectId),
      inArray(
        workflowEndpoints.projectId,
        this.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.ownerId, ownerId)),
      ),
    );
  }
  async get(projectId: string, ownerId: string, id: string) {
    const [row] = await this.db
      .select({
        endpoint: workflowEndpoints,
        publishedDefinition: workflowVersions.definition,
        publishedDependencies: workflowVersions.schemaDependencies,
      })
      .from(workflowEndpoints)
      .leftJoin(
        workflowVersions,
        and(
          eq(workflowVersions.id, workflowEndpoints.publishedVersionId),
          eq(workflowVersions.workflowEndpointId, workflowEndpoints.id),
        ),
      )
      .where(and(this.owned(projectId, ownerId), eq(workflowEndpoints.id, id)));
    if (!row) throw missing();
    const [active] = await this.db
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
      ...row.endpoint,
      publishedDefinition: row.publishedDefinition,
      publishedDependencies: row.publishedDependencies,
      managementBlocked: !!active,
    };
  }
  async list(projectId: string, ownerId: string) {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
    if (!project) throw missing();
    return this.db
      .select()
      .from(workflowEndpoints)
      .where(this.owned(projectId, ownerId));
  }
  async tables(projectId: string, ownerId: string) {
    return this.db
      .select({
        id: schemaTables.id,
        connectionId: schemaTables.connectionId,
        appliedRevision: schemaTables.appliedRevision,
        appliedDefinition: schemaTables.appliedDefinition,
      })
      .from(schemaTables)
      .innerJoin(projects, eq(projects.id, schemaTables.projectId))
      .where(
        and(
          eq(schemaTables.projectId, projectId),
          eq(projects.ownerId, ownerId),
        ),
      );
  }
  async create(
    projectId: string,
    ownerId: string,
    path: string,
    definition: WorkflowDefinition,
  ) {
    validatePath(path);
    inspectWorkflow(definition);
    return this.db.transaction(async (tx) => {
      const canonicalId = await lockProjectResource(tx, projectId, ownerId);
      const [connection] = await tx
        .select({ id: databaseConnections.id })
        .from(databaseConnections)
        .where(eq(databaseConnections.projectId, canonicalId))
        .for('update');
      if (!connection)
        throw conflict('A customer database connection is required');
      const [existing] = await tx
        .select({ id: workflowEndpoints.id })
        .from(workflowEndpoints)
        .where(
          and(
            eq(workflowEndpoints.projectId, canonicalId),
            eq(workflowEndpoints.path, path),
          ),
        );
      const [resource] = await tx
        .select({ id: endpoints.id })
        .from(endpoints)
        .where(
          and(
            eq(endpoints.projectId, canonicalId),
            eq(endpoints.resourceName, path),
          ),
        );
      if (existing || resource)
        throw conflict('Runtime resource is already reserved');
      const [row] = await tx
        .insert(workflowEndpoints)
        .values({
          projectId: canonicalId,
          connectionId: connection.id,
          path,
          draftDefinition: definition,
        })
        .returning();
      if (!row) throw new Error('Workflow insert failed');
      return row;
    });
  }
  async edit(
    projectId: string,
    ownerId: string,
    id: string,
    revision: number,
    definition: WorkflowDefinition,
  ) {
    inspectWorkflow(definition);
    const [row] = await this.db
      .update(workflowEndpoints)
      .set({
        draftDefinition: definition,
        draftRevision: revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          this.owned(projectId, ownerId),
          eq(workflowEndpoints.id, id),
          eq(workflowEndpoints.draftRevision, revision),
        ),
      )
      .returning();
    if (!row) {
      await this.get(projectId, ownerId, id);
      throw conflict('Workflow draft revision changed');
    }
    return row;
  }
  async toggle(
    projectId: string,
    ownerId: string,
    id: string,
    revision: number,
    enabled: boolean,
  ) {
    const [row] = await this.db
      .update(workflowEndpoints)
      .set({ enabled, updatedAt: new Date() })
      .where(
        and(
          this.owned(projectId, ownerId),
          eq(workflowEndpoints.id, id),
          eq(workflowEndpoints.draftRevision, revision),
        ),
      )
      .returning();
    if (!row) {
      await this.get(projectId, ownerId, id);
      throw conflict('Workflow draft revision changed');
    }
    return row;
  }
  async publish(
    projectId: string,
    ownerId: string,
    id: string,
    revision: number,
    hash: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [workflow] = await tx
        .select()
        .from(workflowEndpoints)
        .where(
          and(this.owned(projectId, ownerId), eq(workflowEndpoints.id, id)),
        )
        .for('update');
      if (!workflow) throw missing();
      if (workflow.draftRevision !== revision)
        throw conflict('Workflow draft revision changed');
      const tables = await tx
        .select({
          id: schemaTables.id,
          connectionId: schemaTables.connectionId,
          appliedRevision: schemaTables.appliedRevision,
          appliedDefinition: schemaTables.appliedDefinition,
        })
        .from(schemaTables)
        .where(eq(schemaTables.projectId, workflow.projectId))
        .for('share');
      const preview = previewWorkflow(
        workflow.draftDefinition,
        revision,
        tables,
        workflow.connectionId,
      );
      if (preview.definitionHash !== hash)
        throw conflict('Workflow preview or schema dependencies changed');
      const [previous] = await tx
        .select({ version: workflowVersions.version })
        .from(workflowVersions)
        .where(eq(workflowVersions.workflowEndpointId, id))
        .orderBy(desc(workflowVersions.version))
        .limit(1);
      const [version] = await tx
        .insert(workflowVersions)
        .values({
          workflowEndpointId: id,
          version: (previous?.version ?? 0) + 1,
          definition: workflow.draftDefinition,
          definitionHash: hash,
          schemaDependencies: preview.schemaDependencies,
        })
        .returning();
      if (!version) throw new Error('Workflow version insert failed');
      await tx
        .update(workflowEndpoints)
        .set({ publishedVersionId: version.id, updatedAt: new Date() })
        .where(
          and(this.owned(projectId, ownerId), eq(workflowEndpoints.id, id)),
        );
      return version;
    });
  }
  async resolve(projectId: string, path: string) {
    return this.db.transaction(
      async (tx) => {
        const [row] = await tx
          .select({
            endpoint: workflowEndpoints,
            version: workflowVersions,
            connection: databaseConnections,
          })
          .from(workflowEndpoints)
          .innerJoin(
            workflowVersions,
            and(
              eq(workflowVersions.id, workflowEndpoints.publishedVersionId),
              eq(workflowVersions.workflowEndpointId, workflowEndpoints.id),
            ),
          )
          .innerJoin(
            databaseConnections,
            and(
              eq(databaseConnections.id, workflowEndpoints.connectionId),
              eq(databaseConnections.projectId, workflowEndpoints.projectId),
            ),
          )
          .where(
            and(
              eq(workflowEndpoints.projectId, projectId),
              eq(workflowEndpoints.path, path),
              eq(workflowEndpoints.enabled, true),
            ),
          );
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
        const tables = await tx
          .select({
            id: schemaTables.id,
            connectionId: schemaTables.connectionId,
            appliedRevision: schemaTables.appliedRevision,
            appliedDefinition: schemaTables.appliedDefinition,
          })
          .from(schemaTables)
          .where(eq(schemaTables.projectId, projectId));
        return { ...row, tables, blocked: !!active };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
