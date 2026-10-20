import { normalizeIndexes } from './indexes.js';
import { enforceQuota } from '../../operations/quotas.js';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm';
import type { PlatformDatabase } from '../../database/platform-db/client.js';
import {
  databaseConnections,
  projects,
  schemaFields,
  schemaIndexes,
  schemaMigrations,
  schemaTables,
} from '../../database/platform-db/schema.js';
import { conflict, missing } from './errors.js';
import { canonical, generatePlan } from './plan.js';
import { needsEvolution } from './evolution.js';
import { normalizeDraft, validateTargetSchema } from './validation.js';
import type {
  DraftInput,
  MigrationStatus,
  Plan,
  SchemaRepository,
  TableRecord,
} from './types.js';

type Transaction = Parameters<
  Parameters<PlatformDatabase['transaction']>[0]
>[0];
type Reader = PlatformDatabase | Transaction;
export class PostgresSchemaRepository implements SchemaRepository {
  constructor(private readonly db: PlatformDatabase) {}
  private owned(projectId: string, ownerId: string) {
    return and(
      eq(schemaTables.projectId, projectId),
      inArray(
        schemaTables.projectId,
        this.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.ownerId, ownerId)),
      ),
    );
  }
  private async project(reader: Reader, projectId: string, ownerId: string) {
    const [project] = await reader
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
    if (!project) throw missing();
  }
  private async lock(tx: Transaction, projectId: string, ownerId: string) {
    await this.project(tx, projectId, ownerId);
    const [connection] = await tx
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.projectId, projectId))
      .for('update');
    if (!connection) throw conflict('A saved database connection is required');
    return connection;
  }
  private async idle(tx: Transaction, projectId: string) {
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
    if (active)
      throw conflict(
        'An apply is in progress or requires operator reconciliation',
      );
  }
  private async read(
    reader: Reader,
    projectId: string,
    ownerId: string,
    tableId: string,
  ): Promise<TableRecord> {
    const [table] = await reader
      .select()
      .from(schemaTables)
      .where(and(this.owned(projectId, ownerId), eq(schemaTables.id, tableId)));
    if (!table) throw missing();
    const fields = await reader
      .select()
      .from(schemaFields)
      .where(eq(schemaFields.tableId, tableId))
      .orderBy(asc(schemaFields.position));
    const indexRows = await reader.select().from(schemaIndexes).where(eq(schemaIndexes.tableId, tableId)).orderBy(asc(schemaIndexes.id));
    const indexes = indexRows.map(({ id, specificationVersion, fieldIds, unique }) => ({ id, specificationVersion, fieldIds, unique }));
    const [applyStatus] = await reader
      .select({
        status: schemaMigrations.status,
        migrationId: schemaMigrations.id,
        errorCode: schemaMigrations.errorCode,
        completedAt: schemaMigrations.completedAt,
      })
      .from(schemaMigrations)
      .where(
        and(
          eq(schemaMigrations.projectId, projectId),
          eq(schemaMigrations.tableId, tableId),
        ),
      )
      .orderBy(desc(schemaMigrations.createdAt), desc(schemaMigrations.id))
      .limit(1);
    return {
      ...table,
      indexes,
      applyStatus: applyStatus ?? null,
      fields: fields.map(({ tableId: _tableId, relationship, ...field }) => ({
        ...field,
        ...(relationship ? { relationship } : {}),
      })),
    };
  }
  private async managed(reader: Reader, projectId: string, ownerId: string) {
    const rows = await reader
      .select({ id: schemaTables.id })
      .from(schemaTables)
      .where(this.owned(projectId, ownerId));
    const tables: TableRecord[] = [];
    for (const row of rows)
      tables.push(await this.read(reader, projectId, ownerId, row.id));
    return tables;
  }
  async list(projectId: string, ownerId: string) {
    await this.project(this.db, projectId, ownerId);
    const tables = await this.db
      .select({ id: schemaTables.id })
      .from(schemaTables)
      .where(this.owned(projectId, ownerId))
      .orderBy(asc(schemaTables.createdAt), asc(schemaTables.id));
    return Promise.all(
      tables.map((table) => this.read(this.db, projectId, ownerId, table.id)),
    );
  }
  async get(projectId: string, ownerId: string, tableId: string) {
    return this.read(this.db, projectId, ownerId, tableId);
  }
  async create(
    projectId: string,
    ownerId: string,
    input: DraftInput,
    target: {
      connectionId: string;
      encryptedConfig: string;
      schemaName: string;
    },
  ) {
    return this.translateConflict(() =>
      this.db.transaction(async (tx) => {
        const connection = await this.lock(tx, projectId, ownerId);
        if (
          connection.id !== target.connectionId ||
          connection.encryptedConfig !== target.encryptedConfig
        )
          throw conflict('Database connection changed');
        await this.idle(tx, projectId);
        await enforceQuota(tx, 'schema_tables', projectId);
        validateTargetSchema(target.schemaName);
        const draft = normalizeDraft(input);
        const indexes = normalizeIndexes(input.indexes, draft.fields);
        const [table] = await tx
          .insert(schemaTables)
          .values({
            projectId,
            connectionId: connection.id,
            schemaName: target.schemaName,
            name: draft.name,
          })
          .returning();
        if (!table) throw new Error('Insert returned no table');
        generatePlan(
          { ...table, fields: draft.fields, indexes },
          await this.managed(tx, projectId, ownerId),
        );
        if (draft.fields.length)
          await tx
            .insert(schemaFields)
            .values(
              draft.fields.map((field) => ({ ...field, tableId: table.id })),
            );
        if (indexes.length) await tx.insert(schemaIndexes).values(indexes.map((index) => ({ ...index, tableId: table.id })));
        return { ...table, fields: draft.fields, indexes };
      }),
    );
  }
  async update(
    projectId: string,
    ownerId: string,
    tableId: string,
    revision: number,
    input: DraftInput,
  ) {
    return this.translateConflict(() =>
      this.db.transaction(async (tx) => {
        await this.lock(tx, projectId, ownerId);
        const table = await this.read(tx, projectId, ownerId, tableId);
        await this.idle(tx, projectId);
        if (revision !== table.draftRevision)
          throw conflict('Draft revision changed');
        const draft = normalizeDraft(input, table.fields);
        const indexes = normalizeIndexes(input.indexes, draft.fields, table.indexes, table.appliedDefinition?.definition.indexes);
        const candidate = {
          ...table,
          ...draft,
          indexes,
          draftRevision: table.draftRevision + 1,
          updatedAt: new Date(),
        };
        const before = table.appliedDefinition?.definition;
        const revertedEvolution = needsEvolution(table) && before && candidate.name === before.name &&
          canonical(candidate.fields) === canonical(before.fields) && canonical(candidate.indexes) === canonical(before.indexes ?? []);
        if (!revertedEvolution) generatePlan(candidate, await this.managed(tx, projectId, ownerId));
        await tx
          .update(schemaTables)
          .set({
            name: draft.name,
            draftRevision: candidate.draftRevision,
            updatedAt: candidate.updatedAt,
          })
          .where(
            and(this.owned(projectId, ownerId), eq(schemaTables.id, tableId)),
          );
        await tx.delete(schemaIndexes).where(and(eq(schemaIndexes.tableId, tableId), indexes.length ? notInArray(schemaIndexes.id, indexes.map((index) => index.id)) : undefined));
        for (const index of indexes) await tx.insert(schemaIndexes).values({ ...index, tableId }).onConflictDoUpdate({ target: schemaIndexes.id, set: { fieldIds: index.fieldIds, unique: index.unique, updatedAt: new Date() } });
        await tx.delete(schemaFields).where(eq(schemaFields.tableId, tableId));
        if (draft.fields.length)
          await tx
            .insert(schemaFields)
            .values(draft.fields.map((field) => ({ ...field, tableId })));
        return candidate;
      }),
    );
  }
  async delete(projectId: string, ownerId: string, tableId: string) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, projectId, ownerId);
      const table = await this.read(tx, projectId, ownerId, tableId);
      await this.idle(tx, projectId);
      if (table.appliedDefinition)
        throw conflict('Applied tables cannot be deleted');
      await tx
        .delete(schemaTables)
        .where(
          and(this.owned(projectId, ownerId), eq(schemaTables.id, tableId)),
        );
    });
  }
  async begin(projectId: string, ownerId: string, tableId: string, plan: Plan) {
    return this.translateConflict(() =>
      this.db.transaction(async (tx) => {
        await this.lock(tx, projectId, ownerId);
        await this.idle(tx, projectId);
        const table = await this.read(tx, projectId, ownerId, tableId);
        if (
          generatePlan(table, await this.managed(tx, projectId, ownerId))
            .hash !== plan.hash
        )
          throw conflict('Draft or applied revision changed');
        const id = randomUUID();
        await tx.insert(schemaMigrations).values({
          id,
          projectId,
          tableId,
          draftRevision: plan.revision,
          planHash: plan.hash,
          definition: plan.definition,
          ...(plan.evolution ? { planContext: plan.evolution } : {}),
          ...(plan.version === 2
            ? {
                planContext: {
                  version: 2 as const,
                  dependencies: plan.dependencies!,
                },
              }
            : {}),
          status: 'applying',
        });
        return id;
      }),
    );
  }
  async finish(
    projectId: string,
    ownerId: string,
    tableId: string,
    migrationId: string,
    plan: Plan,
    status: Exclude<MigrationStatus, 'applying'>,
    catalog: unknown,
    errorCode: string | null,
  ) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, projectId, ownerId);
      const table = await this.read(tx, projectId, ownerId, tableId);
      const [migration] = await tx
        .select()
        .from(schemaMigrations)
        .where(
          and(
            eq(schemaMigrations.id, migrationId),
            eq(schemaMigrations.projectId, projectId),
            eq(schemaMigrations.tableId, tableId),
            eq(schemaMigrations.status, 'applying'),
          ),
        )
        .for('update');
      if (
        !migration ||
        migration.planHash !== plan.hash ||
        table.draftRevision !== plan.revision
      )
        throw conflict('Migration state changed');
      if (status === 'applied')
        await tx
          .update(schemaTables)
          .set({
            appliedRevision: plan.evolution?.contractChange === false ? table.appliedRevision : plan.revision,
            appliedPhysicalRevision: plan.revision,
            appliedDefinition: { definition: plan.definition, catalog },
            updatedAt: new Date(),
          })
          .where(
            and(this.owned(projectId, ownerId), eq(schemaTables.id, tableId)),
          );
      await tx
        .update(schemaMigrations)
        .set({ status, errorCode, completedAt: new Date() })
        .where(eq(schemaMigrations.id, migrationId));
    });
  }
  private async translateConflict<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
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
      )
        throw conflict('Table name is already reserved or an apply is active');
      throw error;
    }
  }
}
