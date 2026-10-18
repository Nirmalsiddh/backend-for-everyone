import { and, eq, inArray } from 'drizzle-orm';
import type { PlatformDatabase } from '../../database/platform-db/client.js';
import {
  databaseConnections,
  projects,
  projectAuthConfigs,
  schemaTables,
  workflowEndpoints,
} from '../../database/platform-db/schema.js';
import { ConnectionError } from './errors.js';
import type {
  ConnectionRecord,
  ConnectionRepository,
  TestStatus,
} from './types.js';

export class PostgresConnectionRepository implements ConnectionRepository {
  constructor(private readonly db: PlatformDatabase) {}

  private owned(projectId: string, ownerId: string) {
    return and(
      eq(databaseConnections.projectId, projectId),
      inArray(
        databaseConnections.projectId,
        this.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.ownerId, ownerId)),
      ),
    );
  }

  async replacementStatus(projectId: string, ownerId: string) {
    const connection = await this.findOwned(projectId, ownerId);
    if (!connection)
      return { eligible: false, blockers: ['Connection unavailable'] };
    const blockers: string[] = [];
    for (const [table, label] of [
      [schemaTables, 'Managed schema definitions'],
      [projectAuthConfigs, 'Authentication configuration'],
      [workflowEndpoints, 'Workflow definitions'],
    ] as const) {
      const rows = await this.db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.connectionId, connection.id))
        .limit(1);
      if (rows.length) blockers.push(label);
    }
    return { eligible: blockers.length === 0, blockers };
  }
  async findOwned(projectId: string, ownerId: string) {
    const [record] = await this.db
      .select()
      .from(databaseConnections)
      .where(this.owned(projectId, ownerId))
      .limit(1);
    return record;
  }

  async create(record: ConnectionRecord, ownerId: string) {
    // Recheck ownership inside the insert transaction, keeping network testing outside it.
    try {
      return await this.db.transaction(async (tx) => {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, record.projectId),
              eq(projects.ownerId, ownerId),
            ),
          )
          .for('share');
        if (!project)
          throw new ConnectionError(
            404,
            'PROJECT_NOT_FOUND',
            'Project not found',
          );
        const [saved] = await tx
          .insert(databaseConnections)
          .values(record)
          .returning();
        if (!saved) throw new Error('Insert returned no connection');
        return saved;
      });
    } catch (error) {
      const cause =
        error && typeof error === 'object' && 'cause' in error
          ? error.cause
          : error;
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === '23505'
      ) {
        throw new ConnectionError(
          409,
          'CONNECTION_EXISTS',
          'Project already has a database connection',
        );
      }
      throw error;
    }
  }

  async replace(
    record: ConnectionRecord,
    ownerId: string,
    expectedConfig: string,
  ) {
    return this.db.transaction(async (tx) => {
      await this.requireUnmanaged(tx, record.projectId, ownerId);
      const [saved] = await tx
        .update(databaseConnections)
        .set({
          label: record.label,
          encryptedConfig: record.encryptedConfig,
          encryptionIv: record.encryptionIv,
          encryptionTag: record.encryptionTag,
          encryptionVersion: record.encryptionVersion,
          lastTestStatus: record.lastTestStatus,
          lastTestedAt: record.lastTestedAt,
          updatedAt: record.updatedAt,
        })
        .where(
          and(
            this.owned(record.projectId, ownerId),
            eq(databaseConnections.id, record.id),
            eq(databaseConnections.encryptedConfig, expectedConfig),
          ),
        )
        .returning();
      return saved;
    });
  }

  async markTest(
    record: ConnectionRecord,
    ownerId: string,
    status: TestStatus,
    at: Date,
  ) {
    const [saved] = await this.db
      .update(databaseConnections)
      .set({ lastTestStatus: status, lastTestedAt: at, updatedAt: at })
      .where(
        and(
          this.owned(record.projectId, ownerId),
          eq(databaseConnections.id, record.id),
          eq(databaseConnections.encryptedConfig, record.encryptedConfig),
        ),
      )
      .returning();
    return saved;
  }

  private async requireUnmanaged(
    tx: Parameters<Parameters<PlatformDatabase['transaction']>[0]>[0],
    projectId: string,
    ownerId: string,
  ) {
    const [connection] = await tx
      .select({ id: databaseConnections.id })
      .from(databaseConnections)
      .where(this.owned(projectId, ownerId))
      .for('update');
    if (!connection) return;
    const [table] = await tx
      .select({ id: schemaTables.id })
      .from(schemaTables)
      .where(eq(schemaTables.connectionId, connection.id))
      .limit(1);
    const [auth] = await tx
      .select({ id: projectAuthConfigs.id })
      .from(projectAuthConfigs)
      .where(eq(projectAuthConfigs.connectionId, connection.id))
      .limit(1);
    const [workflow] = await tx
      .select({ id: workflowEndpoints.id })
      .from(workflowEndpoints)
      .where(eq(workflowEndpoints.connectionId, connection.id))
      .limit(1);
    if (table || auth || workflow)
      throw new ConnectionError(
        409,
        'CONNECTION_IN_USE',
        'Remove unapplied schema definitions before changing this connection; applied schemas require operator review',
      );
  }

  async deleteOwned(projectId: string, ownerId: string) {
    return this.db.transaction(async (tx) => {
      await this.requireUnmanaged(tx, projectId, ownerId);
      const deleted = await tx
        .delete(databaseConnections)
        .where(this.owned(projectId, ownerId))
        .returning({ id: databaseConnections.id });
      return deleted.length > 0;
    });
  }
}
