import { selectByIds, serializeRow } from '../../runtime/queries.js';
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
  return (config, applied, query, guard, expansion) =>
    runner(config, async (client) => {
      if (guard) await verifySessionGuard(client, config.schema, guard);
      await checkManagedCatalogs(client, [applied], applied.managedTables);
      if (expansion) for (const include of expansion.includes)
        await checkManagedCatalogs(client, [include.applied], applied.managedTables);
      const rows = (await client.query(query.text, query.values)).rows;
      if (Buffer.byteLength(JSON.stringify(rows)) > 1048576 - 2048)
        throw new RuntimeError(
          422,
          'RESPONSE_TOO_LARGE',
          'Response exceeds 1 MiB; request fewer records or smaller results',
        );
      if (expansion) {
        const page = expansion.limit === undefined ? rows : rows.slice(0, expansion.limit);
        let bytes = Buffer.byteLength(JSON.stringify(rows));
        for (const row of page) row._related = {};
        for (const include of expansion.includes) {
          const ids = [...new Set(page.flatMap((row) => typeof row[include.name] === 'string' ? [row[include.name] as string] : []))];
          const batch = selectByIds(include.applied.definition, ids, include.ownership);
          const related = (await client.query(batch.text, batch.values)).rows;
          if (Buffer.byteLength(JSON.stringify(related)) > 1048576 - 2048) throw new RuntimeError(422, 'RESPONSE_TOO_LARGE', 'Response exceeds 1 MiB; request fewer records or smaller results');
          const records = new Map(related.map((row) => [row.id, serializeRow(include.applied.definition, row)]));
          for (const row of page) {
            const value = records.get(row[include.name]) ?? null;
            bytes += Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(include.name) + 32;
            if (bytes > 1048576 - 2048) throw new RuntimeError(422, 'RESPONSE_TOO_LARGE', 'Response exceeds 1 MiB; request fewer records or smaller results');
            (row._related as Record<string, unknown>)[include.name] = value;
          }
        }
        await expansion.fence();
      }
      return rows;
    }, undefined, { expandedRead: !!expansion });
}
