import { verifyFieldCatalogTransition } from './field-catalog.js';
import { executeFieldBundle } from './field-evolution.js';
import { v4CatalogContext } from './default-catalog.js';
import type { CredentialEncryption } from '../../security/encryption.js';
import { writeReceipt } from '../../operations/receipts.js';
import { boundedClient } from './admission.js';
import {
  customerConnectionOptions,
  DestinationError,
} from '../../security/customer-destination.js';
import { readCatalog, verifyPostCatalog } from './index-catalog.js';
import pg from 'pg';
import {
  canonical,
  quoteIdentifier,
} from '../../modules/schema-builder/plan.js';
import { conflict, SchemaError } from '../../modules/schema-builder/errors.js';
import type { SchemaExecutor } from '../../modules/schema-builder/types.js';

export interface SchemaClient {
  connect(): Promise<unknown>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export function createSchemaExecutor(
  factory: (options: pg.ClientConfig) => SchemaClient = (options) =>
    boundedClient(options, 'schema', 10000),
  receipts?: CredentialEncryption,
): SchemaExecutor {
  return async (config, plan, applied) => {
    const client = factory(
      await customerConnectionOptions({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.username,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: true } : false,
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 6000,
        application_name: 'platform-schema-builder',
      }),
    );
    client.on('error', () => {});
    const beforeTables = plan.managedTables ?? [];
    const afterTables = beforeTables.filter(
      (t) => t.appliedDefinition?.definition.name !== plan.definition.name,
    );
    // Candidate metadata is used only for verification inside this transaction.
    afterTables.push({
      id:
        beforeTables.find(
          (t) => t.appliedDefinition?.definition.name === plan.definition.name,
        )?.id ?? '__candidate__',
      appliedRevision: plan.evolution?.contractChange === false ? plan.evolution.appliedRevision : plan.revision,
      appliedPhysicalRevision: plan.revision,
      appliedDefinition: { definition: plan.definition, catalog: null },
    });
    let committing = false;
    let transaction = false;
    try {
      await client.connect();
      await client.query('BEGIN');
      transaction = true;
      await client.query('SET LOCAL search_path = pg_catalog');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query(
        "SET LOCAL idle_in_transaction_session_timeout = '10s'",
      );
      await client.query(
        'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
        [`schema-builder:${plan.definition.schema}`],
      );
      const target = `${quoteIdentifier(plan.definition.schema)}.${quoteIdentifier(plan.definition.name)}`;
      const lockTargets = [
        ...new Set([
          ...(applied ? [target] : []),
          ...(plan.dependencies ?? []).map(
            (d) =>
              `${quoteIdentifier(d.definition.schema)}.${quoteIdentifier(d.definition.name)}`,
          ),
        ]),
      ].sort();
      for (const name of lockTargets)
        await client.query(`LOCK TABLE ONLY ${name} IN ACCESS EXCLUSIVE MODE`);
      for (const dependency of plan.dependencies ?? []) {
        if (
          canonical(
            await readCatalog(
              client,
              dependency.definition.schema,
              dependency.definition.name,
              beforeTables,
              dependency.catalog,
            ),
          ) !== canonical(dependency.catalog)
        )
          throw conflict('Reference target changed; refresh and preview again');
        const [privilege] = (
          await client.query(
            "SELECT has_column_privilege(current_user, $1, 'id', 'REFERENCES') AS allowed",
            [
              `${quoteIdentifier(dependency.definition.schema)}.${quoteIdentifier(dependency.definition.name)}`,
            ],
          )
        ).rows;
        if (!privilege?.allowed)
          throw new SchemaError(
            422,
            'RELATIONSHIP_CAPABILITY_MISSING',
            'Credential cannot create relationships to this table.',
          );
      }
      if (applied) {
        await client.query(
          `LOCK TABLE ONLY ${target} IN ACCESS EXCLUSIVE MODE`,
        );
        const actual = await readCatalog(
          client,
          plan.definition.schema,
          plan.definition.name,
          beforeTables,
          applied.catalog,
        );
        if (canonical(actual) !== canonical(applied.catalog))
          throw conflict(
            'Customer schema drift detected; operator review is required',
          );
      }
      for (const action of plan.evolution?.actions ?? []) {
        let invalidData = false;
        if (applied && action.kind === 'set_not_null') {
          const field = plan.definition.fields.find((candidate) => candidate.id === action.fieldId)!;
          invalidData = (await client.query(`SELECT 1 FROM ONLY ${target} WHERE ${quoteIdentifier(field.name)} IS NULL LIMIT 1`)).rows.length > 0;
        } else if (applied && action.kind === 'create_unique_index') {
          const columns = action.index.fieldIds.map((id) => quoteIdentifier(plan.definition.fields.find((field) => field.id === id)!.name));
          invalidData = (await client.query(`SELECT 1 FROM ONLY ${target} WHERE ${columns.map((name) => `${name} IS NOT NULL`).join(' AND ')} GROUP BY ${columns.join(', ')} HAVING count(*) > 1 LIMIT 1`)).rows.length > 0;
        }
        if (invalidData) throw new SchemaError(422, 'SCHEMA_DATA_INVALID', 'Existing data does not satisfy the proposed constraint; no schema changes were applied');
      }
      if (plan.version === 4) await executeFieldBundle(client, plan);
      for (const statement of plan.statements) await client.query(statement);
      const snapshot = await readCatalog(
        client,
        plan.definition.schema,
        plan.definition.name,
        afterTables,
        plan.version === 4 ? v4CatalogContext(plan) : plan.version === 3 ? ((applied?.catalog as { version?: number })?.version === 4 ? applied?.catalog : { version: 3 }) : applied?.catalog,
      );
      verifyPostCatalog(snapshot, plan.definition);
      await verifyFieldCatalogTransition(client, plan, snapshot);
      for (const dependency of plan.dependencies ?? []) {
        if (
          canonical(
            await readCatalog(
              client,
              dependency.definition.schema,
              dependency.definition.name,
              afterTables,
              dependency.catalog,
            ),
          ) !== canonical(dependency.catalog)
        )
          throw conflict('Reference target changed during Apply');
      }
      if (receipts && plan.receipt)
        await writeReceipt(
          client,
          receipts,
          plan.definition.schema,
          plan.definition.name,
          `schema:${plan.receipt.projectId}:${plan.receipt.operationId}:${plan.hash}`,
          snapshot,
        );
      committing = true;
      await client.query('COMMIT');
      transaction = false;
      return snapshot;
    } catch (error) {
      if (error instanceof DestinationError) throw error;
      if (committing)
        throw new SchemaError(
          503,
          'SCHEMA_OUTCOME_UNKNOWN',
          'Customer commit outcome is unknown; operator reconciliation is required',
        );
      if (transaction) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof SchemaError) throw error;
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
      if (plan.version === 4 && ['22001', '22021', '22P02', '22003', '22007', '22008'].includes(code)) throw new SchemaError(422, 'SCHEMA_DATA_INVALID', 'Value cannot be represented exactly by the target field');
      if (code === '23505') throw new SchemaError(422, 'SCHEMA_DATA_INVALID', 'Existing data conflicts with a managed uniqueness constraint');
      if (code === '23503') throw new SchemaError(409, 'RELATIONSHIP_CONFLICT', 'Existing data conflicts with a managed relationship');
      if (['42P07', '42701', '42P01'].includes(code))
        throw conflict(
          'Customer database object conflicts with the schema plan',
        );
      if (['55P03', '57014', 'ETIMEDOUT', 'CUSTOMER_OPERATION_TIMEOUT'].includes(code))
        throw new SchemaError(
          504,
          'SCHEMA_TIMEOUT',
          'Customer schema operation timed out',
        );
      if (code === '42501')
        throw new SchemaError(
          422,
          'SCHEMA_PERMISSION_DENIED',
          'Customer database role lacks required schema permissions',
        );
      throw new SchemaError(
        422,
        'SCHEMA_APPLY_FAILED',
        'Customer schema operation failed',
      );
    } finally {
      await client.end().catch(() => {});
    }
  };
}
