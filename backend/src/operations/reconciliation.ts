import { v4CatalogContext } from '../database/customer-db/default-catalog.js';
import { generateEvolutionPlan } from '../modules/schema-builder/evolution.js';
import { generateV4Plan } from '../modules/schema-builder/evolution-v4.js';
import type { ManagedTable } from '../modules/schema-builder/types.js';
import { SchemaError } from '../modules/schema-builder/errors.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { PlatformDatabase } from '../database/platform-db/client.js';
import {
  databaseConnections,
  schemaTables,
  schemaFields,
  schemaIndexes,
  schemaMigrations,
  projectAuthConfigs,
} from '../database/platform-db/schema.js';
import { CredentialEncryption } from '../security/encryption.js';
import { customerConnectionOptions } from '../security/customer-destination.js';
import type { ConnectionConfig } from '../modules/database-connections/types.js';
import {
  generateLegacyPlan,
  canonical,
  quoteIdentifier,
} from '../modules/schema-builder/plan.js';
import { readCatalog } from '../database/customer-db/index-catalog.js';
import { boundedClient } from '../database/customer-db/admission.js';
import { readReceipt } from './receipts.js';
export type Classification = 'PRE_STATE' | 'POST_STATE' | 'DIVERGED';
export function classifyCatalog(
  pre: unknown,
  actual: unknown,
  receipt: unknown,
): Classification {
  if (
    receipt !== undefined &&
    actual !== null &&
    canonical(actual) === canonical(receipt)
  )
    return 'POST_STATE';
  if (canonical(pre) === canonical(actual)) return 'PRE_STATE';
  return 'DIVERGED';
}
export async function reconcile(
  db: PlatformDatabase,
  encryption: CredentialEncryption,
  projectId: string,
  operationId: string,
  kind: 'schema' | 'auth',
  apply = false,
) {
  const [connection] = await db
    .select()
    .from(databaseConnections)
    .where(eq(databaseConnections.projectId, projectId));
  if (!connection) throw new Error('Connection unavailable');
  const config = encryption.decrypt<ConnectionConfig>(
    connection,
    `${projectId}:${connection.id}`,
  );
  const client = boundedClient(
    await customerConnectionOptions({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 5000,
      statement_timeout: 2000,
      query_timeout: 3000,
      application_name: 'platform-reconciliation',
    }),
    'reconciliation',
  );
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL search_path=pg_catalog');
    await client.query(
      'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
      [`schema-builder:${config.schema}`],
    );
    const exists = async (name: string) =>
      (
        await client.query(
          'SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2',
          [config.schema, name],
        )
      ).rows.length > 0;
    const inspect = async (name: string, tables: ManagedTable[] = [], expected?: unknown) => {
      const relation = await client.query(
        'SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2',
        [config.schema, name],
      );
      if (relation.rows[0]?.relkind !== 'r')
        return { unsupportedRelation: true };
      await client.query(
        `LOCK TABLE ONLY ${quoteIdentifier(config.schema)}.${quoteIdentifier(name)} IN ACCESS SHARE MODE`,
      );
      try {
        return await readCatalog(client, config.schema, name, tables, expected);
      } catch (error) {
        if (error instanceof SchemaError && error.code === 'SCHEMA_CONFLICT')
          return { unsupportedRelation: true };
        throw error;
      }
    };
    let classification: Classification = 'DIVERGED';
    let actual: unknown;
    if (kind === 'schema') {
      const [operation] = await db
        .select()
        .from(schemaMigrations)
        .where(
          and(
            eq(schemaMigrations.id, operationId),
            eq(schemaMigrations.projectId, projectId),
            inArray(schemaMigrations.status, ['applying', 'outcome_unknown']),
          ),
        );
      if (!operation) throw new Error('Active schema operation not found');
      if (operation.planContext && ![2, 3, 4].includes(operation.planContext.version))
        throw new Error('Unsupported schema operation format');
      const [table] = await db
        .select()
        .from(schemaTables)
        .where(
          and(
            eq(schemaTables.id, operation.tableId),
            eq(schemaTables.projectId, projectId),
          ),
        );
      if (
        !table ||
        table.connectionId !== connection.id ||
        table.schemaName !== config.schema ||
        table.draftRevision !== operation.draftRevision
      )
        throw new Error('Operation metadata changed');
      const fields = await db
        .select()
        .from(schemaFields)
        .where(eq(schemaFields.tableId, table.id))
        .orderBy(schemaFields.position);
      const managed = await db
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
            eq(schemaTables.connectionId, connection.id),
          ),
        );
      const indexes = (await db.select().from(schemaIndexes).where(eq(schemaIndexes.tableId, table.id))).map(({ id, specificationVersion, fieldIds, unique }) => ({ id, specificationVersion, fieldIds, unique })).sort((a, b) => a.id.localeCompare(b.id));
      const plan = (operation.planContext?.version === 4 ? generateV4Plan : operation.planContext?.version === 3 ? generateEvolutionPlan : generateLegacyPlan)(
        {
          ...table,
          indexes,
          fields: fields.map(
            ({ tableId: _tableId, relationship, backfillIntent, ...field }) => ({
              ...field,
              ...(backfillIntent ? { backfillIntent } : {}),
              ...(relationship ? { relationship } : {}),
            }),
          ),
        },
        managed,
        operation.planContext?.dependencies,
      );
      if (
        plan.hash !== operation.planHash ||
        ((plan.version === 3 || plan.version === 4) && canonical(plan.evolution) !== canonical(operation.planContext)) ||
        canonical(plan.definition) !== canonical(operation.definition)
      )
        throw new Error('Operation plan does not match durable metadata');
      const postTables = managed.filter((t) => t.id !== table.id);
      postTables.push({
        id: table.id,
        appliedRevision: plan.evolution?.contractChange === false ? table.appliedRevision : operation.draftRevision,
        appliedPhysicalRevision: operation.draftRevision,
        appliedDefinition: { definition: operation.definition, catalog: null },
      });
      actual = (await exists(table.name))
        ? await inspect(table.name, postTables, plan.version === 4 ? v4CatalogContext(plan) : plan.version === 3 ? ((table.appliedDefinition?.catalog as { version?: number })?.version === 4 ? table.appliedDefinition?.catalog : { version: 3 }) : table.appliedDefinition?.catalog)
        : null;
      const receipt =
        actual === null
          ? undefined
          : await readReceipt(
              client,
              encryption,
              config.schema,
              table.name,
              `schema:${projectId}:${operationId}:${operation.planHash}`,
            );
      classification = classifyCatalog(undefined, actual, receipt);
      let dependenciesValid = true;
      for (const dependency of plan.dependencies ?? []) {
        const target = managed.find((t) => t.id === dependency.tableId);
        if (
          target?.appliedRevision !== dependency.appliedRevision ||
          (dependency.appliedPhysicalRevision !== undefined && (target?.appliedPhysicalRevision ?? target?.appliedRevision) !== dependency.appliedPhysicalRevision) ||
          canonical(target?.appliedDefinition?.catalog) !==
            canonical(dependency.catalog) ||
          canonical(target?.appliedDefinition?.definition) !==
            canonical(dependency.definition) ||
          canonical(
            await inspect(
              dependency.definition.name,
              classification === 'POST_STATE' ? postTables : managed,
              dependency.catalog,
            ),
          ) !== canonical(dependency.catalog)
        )
          dependenciesValid = false;
      }
      if (classification !== 'POST_STATE') {
        const preActual = (await exists(table.name))
          ? await inspect(table.name, managed, table.appliedDefinition?.catalog)
          : null;
        classification =
          canonical(preActual) ===
          canonical(table.appliedDefinition?.catalog ?? null)
            ? 'PRE_STATE'
            : 'DIVERGED';
      }
      if (!dependenciesValid) classification = 'DIVERGED';
      if (apply && classification !== 'DIVERGED')
        await db.transaction(async (tx) => {
          await tx
            .select()
            .from(databaseConnections)
            .where(eq(databaseConnections.id, connection.id))
            .for('update');
          const [current] = await tx
            .select()
            .from(schemaMigrations)
            .where(eq(schemaMigrations.id, operationId))
            .for('update');
          if (
            !current ||
            current.status !== operation.status ||
            current.planHash !== operation.planHash
          )
            throw new Error('Operation changed during inspection');
          if (classification === 'POST_STATE' && plan.version === 4) await tx.update(schemaFields).set({ backfillIntent: null }).where(eq(schemaFields.tableId, table.id));
          if (classification === 'POST_STATE')
            await tx
              .update(schemaTables)
              .set({
                appliedRevision: plan.evolution?.contractChange === false ? table.appliedRevision : operation.draftRevision,
                appliedPhysicalRevision: operation.draftRevision,
                appliedDefinition: {
                  definition: operation.definition,
                  catalog: actual,
                },
                updatedAt: new Date(),
              })
              .where(eq(schemaTables.id, table.id));
          await tx
            .update(schemaMigrations)
            .set({
              status: classification === 'POST_STATE' ? 'applied' : 'failed',
              completedAt: new Date(),
              errorCode:
                classification === 'PRE_STATE' ? 'RECONCILED_PRE_STATE' : null,
            })
            .where(eq(schemaMigrations.id, operationId));
        });
    } else {
      const [auth] = await db
        .select()
        .from(projectAuthConfigs)
        .where(
          and(
            eq(projectAuthConfigs.projectId, projectId),
            eq(projectAuthConfigs.id, operationId),
            inArray(projectAuthConfigs.provisioningStatus, [
              'provisioning',
              'outcome_unknown',
            ]),
          ),
        );
      if (!auth || auth.connectionId !== connection.id)
        throw new Error('Active authentication provisioning not found');
      const users = await exists(auth.authUsersTableName),
        sessions = await exists(auth.authSessionsTableName);
      if (!users && !sessions) classification = 'PRE_STATE';
      else if (users && sessions) {
        actual = {
          users: await inspect(auth.authUsersTableName),
          sessions: await inspect(auth.authSessionsTableName),
        };
        // finish(outcome_unknown) increments the config revision; the receipt was written at begin's revision.
        const receiptRevision =
          auth.provisioningStatus === 'outcome_unknown'
            ? auth.revision - 1
            : auth.revision;
        const receiptContext = `auth:${projectId}:${auth.id}:${receiptRevision}`;
        const a = await readReceipt(
          client,
          encryption,
          config.schema,
          auth.authUsersTableName,
          receiptContext,
        );
        const b = await readReceipt(
          client,
          encryption,
          config.schema,
          auth.authSessionsTableName,
          receiptContext,
        );
        if (
          a !== undefined &&
          b !== undefined &&
          canonical(a) === canonical(b) &&
          canonical(a) === canonical(actual)
        )
          classification = 'POST_STATE';
      }
      if (apply && classification !== 'DIVERGED')
        await db.transaction(async (tx) => {
          await tx
            .select()
            .from(databaseConnections)
            .where(eq(databaseConnections.id, connection.id))
            .for('update');
          const changed = await tx
            .update(projectAuthConfigs)
            .set({
              provisioningStatus:
                classification === 'POST_STATE' ? 'ready' : 'failed',
              catalog: classification === 'POST_STATE' ? actual : null,
              revision: auth.revision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(projectAuthConfigs.id, auth.id),
                eq(projectAuthConfigs.revision, auth.revision),
                eq(
                  projectAuthConfigs.provisioningStatus,
                  auth.provisioningStatus,
                ),
              ),
            )
            .returning({ id: projectAuthConfigs.id });
          if (!changed.length)
            throw new Error(
              'Authentication configuration changed during inspection',
            );
        });
    }
    await client.query('ROLLBACK');
    return {
      projectId,
      operationId,
      kind,
      classification,
      applied: apply && classification !== 'DIVERGED',
      nextAction:
        classification === 'DIVERGED'
          ? 'Keep blocked and investigate; do not rerun DDL or adopt objects'
          : classification === 'PRE_STATE'
            ? 'Review failure, then explicitly preview and retry setup'
            : 'Refresh saved metadata; no DDL was executed',
    };
  } finally {
    await client.end();
  }
}
