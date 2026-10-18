import { verifySessionGuard } from './auth-store.js';
import pg from 'pg';
import { canonical, quoteIdentifier } from '../../modules/schema-builder/plan.js';
import { unavailable } from '../../runtime/errors.js';
import type { RuntimeExecutor } from '../../runtime/types.js';
import { catalog } from './catalog.js';
import type { SchemaClient } from './schema-executor.js';
import { createTransactionRunner, type CustomerTransactionRunner } from './transaction-runner.js';
export function createRuntimeExecutor(factory: (options: pg.ClientConfig) => SchemaClient = (options) => new pg.Client(options), capacity = 10,
  runner: CustomerTransactionRunner = createTransactionRunner(factory, capacity)): RuntimeExecutor {
  return (config, applied, query, guard) => runner(config, async (client) => {
    if (guard) await verifySessionGuard(client, config.schema, guard);
    const definition = applied.definition;
    await client.query(`LOCK TABLE ONLY ${quoteIdentifier(definition.schema)}.${quoteIdentifier(definition.name)} IN ACCESS SHARE MODE`);
    if (canonical(await catalog(client, definition.schema, definition.name)) !== canonical(applied.catalog)) throw unavailable();
    return (await client.query(query.text, query.values)).rows;
  });
}
