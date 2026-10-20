import type { CredentialEncryption } from '../../security/encryption.js';
import { writeReceipt } from '../../operations/receipts.js';
import { boundedClient } from './admission.js';
import {
  customerConnectionOptions,
  DestinationError,
} from '../../security/customer-destination.js';
import { catalog } from './catalog.js';
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
  ): Promise<{ rows: Record<string, unknown>[] }>;
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
      if (applied) {
        await client.query(
          `LOCK TABLE ONLY ${target} IN ACCESS EXCLUSIVE MODE`,
        );
        const actual = await catalog(
          client,
          plan.definition.schema,
          plan.definition.name,
        );
        if (canonical(actual) !== canonical(applied.catalog))
          throw conflict(
            'Customer schema drift detected; operator review is required',
          );
      }
      for (const statement of plan.statements) await client.query(statement);
      const snapshot = await catalog(
        client,
        plan.definition.schema,
        plan.definition.name,
      );
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
      if (['42P07', '42701', '42P01'].includes(code))
        throw conflict(
          'Customer database object conflicts with the schema plan',
        );
      if (['55P03', '57014', 'ETIMEDOUT'].includes(code))
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
