import pg from 'pg';
import type { ConnectionConfig } from '../../modules/database-connections/types.js';
import { RuntimeError, unavailable } from '../../runtime/errors.js';
import type { SchemaClient } from './schema-executor.js';
export class TransactionAbort<T> extends Error { constructor(public readonly result: T) { super('Business response requires rollback'); } }
export interface CustomerTransactionRunner {
  <T>(config: ConnectionConfig, work: (client: SchemaClient) => Promise<T>, deadlineMs?: number): Promise<T>;
}
export function createTransactionRunner(factory: (options: pg.ClientConfig) => SchemaClient = (options) => new pg.Client(options), capacity = 10): CustomerTransactionRunner {
  let active = 0;
  return async <T>(config: ConnectionConfig, work: (client: SchemaClient) => Promise<T>, deadlineMs = 10000): Promise<T> => {
    if (active >= capacity) throw new RuntimeError(503, 'RUNTIME_CAPACITY_EXHAUSTED', 'Runtime capacity exhausted');
    active++;
    let raw: SchemaClient | undefined; let closing: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    let transaction = false; let committing = false; let expired = false;
    const end = () => { if (raw && !closing) closing = raw.end().catch(() => {}); return closing; };
    const timeout = () => new RuntimeError(504, 'QUERY_TIMEOUT', 'Customer database request timed out');
    const deadline = Date.now() + deadlineMs;
    const remaining = () => { if (expired || Date.now() >= deadline) throw timeout(); return Math.max(1, Math.min(2000, deadline - Date.now())); };
    try {
      raw = factory({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: Math.min(5000, deadlineMs), statement_timeout: 2000, query_timeout: 3000, application_name: 'platform-runtime' });
      raw.on('error', () => {});
      // pg.Client.end destroys the socket when a query is active, cancelling server work.
      timer = setTimeout(() => { expired = true; void end(); }, deadlineMs);
      await raw.connect(); remaining(); await raw.query('BEGIN'); transaction = true;
      await raw.query('SET LOCAL search_path = pg_catalog'); await raw.query("SET LOCAL TIME ZONE 'UTC'");
      await raw.query("SET LOCAL lock_timeout = '1s'"); await raw.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
      const client: SchemaClient = {
        connect: () => { throw new Error('Transaction already connected'); }, end: () => { throw new Error('Transaction lifecycle is internal'); }, on: (_event, _listener) => {},
        query: async (text, values) => {
          const milliseconds = remaining();
          await raw!.query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [String(milliseconds)]);
          remaining(); return raw!.query(text, values);
        },
      };
      const result = await work(client); remaining(); committing = true; await raw.query('COMMIT'); transaction = false; return result;
    } catch (error) {
      if (committing) throw new RuntimeError(503, 'WRITE_OUTCOME_UNKNOWN', 'Request outcome could not be confirmed; do not automatically retry writes');
      if (transaction && raw && !expired) await raw.query('ROLLBACK').catch(() => {});
      if (expired) throw timeout();
      if (error instanceof TransactionAbort) return error.result as T;
      if (error instanceof RuntimeError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === '23505') throw new RuntimeError(409, 'VALUE_CONFLICT', 'A unique value is already in use');
      if (['57014', '55P03', 'ETIMEDOUT'].includes(code) || (error instanceof Error && /timeout|timed out/i.test(error.message))) throw timeout();
      throw unavailable();
    } finally { if (timer) clearTimeout(timer); try { await end(); } finally { active--; } }
  };
}
