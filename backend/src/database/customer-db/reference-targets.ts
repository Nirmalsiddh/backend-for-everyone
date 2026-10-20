import { boundedClient } from './admission.js';
import { customerConnectionOptions } from '../../security/customer-destination.js';
import { readCatalog } from './index-catalog.js';
import {
  canonical,
  quoteIdentifier,
} from '../../modules/schema-builder/plan.js';
import { conflict, SchemaError } from '../../modules/schema-builder/errors.js';
import type { ConnectionConfig } from '../../modules/database-connections/types.js';
import type { ManagedTable } from '../../modules/schema-builder/types.js';

export async function inspectReferenceTargets(
  config: ConnectionConfig,
  tables: ManagedTable[],
  ids?: string[],
) {
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
      application_name: 'platform-reference-check',
    }),
    'diagnostic',
  );
  const eligible: { id: string; name: string }[] = [];
  let unavailable = false;
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL search_path=pg_catalog');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `schema-builder:${config.schema}`,
    ]);
    for (const table of [...tables].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!table.appliedDefinition || (ids && !ids.includes(table.id)))
        continue;
      const d = table.appliedDefinition.definition;
      await client.query(
        `LOCK TABLE ONLY ${quoteIdentifier(d.schema)}.${quoteIdentifier(d.name)} IN ACCESS SHARE MODE`,
      );
      if (
        canonical(await readCatalog(client, d.schema, d.name, tables, table.appliedDefinition.catalog)) !==
        canonical(table.appliedDefinition.catalog)
      ) {
        if (ids)
          throw conflict(
            'Reference target needs attention; refresh and preview again',
          );
        unavailable = true;
        continue;
      }
      eligible.push({ id: table.id, name: d.name });
    }
    if (ids && ids.some((id) => !eligible.some((t) => t.id === id)))
      throw conflict('Reference target is unavailable');
    await client.query('ROLLBACK');
    return { targets: eligible, unavailable };
  } catch (error) {
    if (error instanceof SchemaError) throw error;
    throw new SchemaError(
      503,
      'REFERENCE_CHECK_UNAVAILABLE',
      'Could not check reference targets. Check the database connection and refresh.',
    );
  } finally {
    await client.end().catch(() => {});
  }
}
