import { checkManagedCatalogs } from './managed-catalog.js';
import { boundedClient } from './admission.js';
import { verifySessionGuard } from './auth-store.js';
import pg from 'pg';
import { RuntimeError } from '../../runtime/errors.js';
import type { RuntimeExecutor } from '../../runtime/types.js';
import type { SchemaClient } from './schema-executor.js';
import {
  createTransactionRunner,
  type CustomerTransactionRunner,
} from './transaction-runner.js';
export function createRuntimeExecutor(
  factory: (options: pg.ClientConfig) => SchemaClient = (options) =>
    boundedClient(options, 'runtime'),
  capacity = 10,
  runner: CustomerTransactionRunner = createTransactionRunner(
    factory,
    capacity,
  ),
): RuntimeExecutor {
  return (config, applied, query, guard) =>
    runner(config, async (client) => {
      if (guard) await verifySessionGuard(client, config.schema, guard);
      await checkManagedCatalogs(client, [applied], applied.managedTables);
      const rows = (await client.query(query.text, query.values)).rows;
      if (Buffer.byteLength(JSON.stringify(rows)) > 1048576 - 2048)
        throw new RuntimeError(
          422,
          'RESPONSE_TOO_LARGE',
          'Response exceeds 1 MiB; request fewer records or smaller results',
        );
      return rows;
    });
}
