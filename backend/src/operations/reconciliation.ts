import { SchemaError } from '../modules/schema-builder/errors.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { PlatformDatabase } from '../database/platform-db/client.js';
import {
  databaseConnections,
  schemaTables,
  schemaFields,
  schemaMigrations,
  projectAuthConfigs,
} from '../database/platform-db/schema.js';
import { CredentialEncryption } from '../security/encryption.js';
import { customerConnectionOptions } from '../security/customer-destination.js';
import type { ConnectionConfig } from '../modules/database-connections/types.js';
import {
  generatePlan,
  canonical,
  quoteIdentifier,
} from '../modules/schema-builder/plan.js';
import { catalog } from '../database/customer-db/catalog.js';
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
    const inspect = async (name: string) => {
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
        return await catalog(client, config.schema, name);
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
      const plan = generatePlan({
        ...table,
        fields: fields.map(({ tableId: _tableId, ...field }) => field),
      });
      if (
        plan.hash !== operation.planHash ||
        canonical(plan.definition) !== canonical(operation.definition)
      )
        throw new Error('Operation plan does not match durable metadata');
      actual = (await exists(table.name)) ? await inspect(table.name) : null;
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
      classification = classifyCatalog(
        table.appliedDefinition?.catalog ?? null,
        actual,
        receipt,
      );
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
          if (classification === 'POST_STATE')
            await tx
              .update(schemaTables)
              .set({
                appliedRevision: operation.draftRevision,
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
