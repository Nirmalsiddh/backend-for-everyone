import { relationshipCatalog } from './relationship-catalog.js';
import type { ManagedTable } from '../../modules/schema-builder/types.js';
import type { SchemaClient } from './schema-executor.js';
import { conflict } from '../../modules/schema-builder/errors.js';

export async function catalog(
  client: SchemaClient,
  schema: string,
  table: string,
  tables: ManagedTable[] = [],
) {
  const relation = await client.query(
    `SELECT c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relispartition
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  );
  if (
    relation.rows.length !== 1 ||
    relation.rows[0]?.relkind !== 'r' ||
    relation.rows[0]?.relispartition
  )
    throw conflict(
      'Managed table is missing or has an unsupported object kind',
    );
  const columns = await client.query(
    `SELECT a.attname, a.attnum, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
    a.attnotnull, a.attidentity, a.attgenerated, a.attcollation::text,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [schema, table],
  );
  const constraints = await client.query(
    `SELECT con.conname, con.convalidated, pg_catalog.pg_get_constraintdef(con.oid) AS definition
    FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 ORDER BY con.conname`,
    [schema, table],
  );
  const indexes = await client.query(
    'SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname',
    [schema, table],
  );
  const triggers = await client.query(
    `SELECT t.tgname, t.tgenabled, pg_catalog.pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 ORDER BY t.tgname`,
    [schema, table],
  );
  const relationships = await relationshipCatalog(
    client,
    schema,
    table,
    tables,
  );
  return {
    ...(relationships.outgoing.length
      ? { version: 2, foreignKeys: relationships.outgoing }
      : {}),
    relation: relation.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows.filter(
      (t) => !relationships.triggers.has(String(t.tgname)),
    ),
  };
}
