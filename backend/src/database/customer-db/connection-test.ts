import { customerConnectionOptions, DestinationError } from '../../security/customer-destination.js';
import pg from 'pg';
import { ConnectionError, connectionTestError } from '../../modules/database-connections/errors.js';
import type { ConnectionConfig } from '../../modules/database-connections/types.js';

export interface TestClient {
  connect(): Promise<unknown>;
  query(text: string, values?: string[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

type ClientFactory = (options: pg.ClientConfig) => TestClient;

function sanitizedError(error: unknown): ConnectionError {
  if (error instanceof DestinationError) throw error;
  if (error instanceof ConnectionError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === '28P01' || code === '28000') return connectionTestError('AUTHENTICATION_FAILED');
  // pg also signals its own connection/read timeouts without a SQLSTATE.
  const message = error instanceof Error ? error.message : '';
  if (['ETIMEDOUT', '57014'].includes(code) || /timeout|timed out/i.test(message)) {
    return connectionTestError('CONNECTION_TIMEOUT');
  }
  return connectionTestError('CONNECTION_FAILED');
}

export function createConnectionTester(factory: ClientFactory = (options) => new pg.Client(options)) {
  return async (config: ConnectionConfig): Promise<void> => {
    const client = factory(await customerConnectionOptions({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 2_000,
      query_timeout: 3_000,
      application_name: 'platform-connection-test',
    }));
    // Prevent idle socket errors from becoming unhandled events. Never log driver details.
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('SELECT 1');
      const result = await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [config.schema]);
      if (result.rows.length === 0) throw connectionTestError('SCHEMA_UNAVAILABLE');
    } catch (error) {
      throw sanitizedError(error);
    } finally {
      await client.end().catch(() => {});
    }
  };
}
