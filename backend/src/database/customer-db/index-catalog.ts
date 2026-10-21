import { normalizeManagedDefault, expectedDefault, type DefaultField } from './default-catalog.js';
import { catalog } from './catalog.js';
import type { SchemaClient } from './schema-executor.js';
import type { Definition, ManagedTable } from '../../modules/schema-builder/types.js';
import { canonical } from '../../modules/schema-builder/plan.js';
import { indexName } from '../../modules/schema-builder/indexes.js';
import { conflict } from '../../modules/schema-builder/errors.js';
export function catalogVersion(value: unknown): number {
  return value && typeof value === 'object' && 'version' in value ? Number(value.version) : 1;
}
// Legacy readers are deliberately untouched, including their exact index/FK serialization.
async function readLegacyOrV3Catalog(client: SchemaClient, schema: string, table: string, tables: ManagedTable[] = [], expected?: unknown) {
  if (![1, 2, 3, 4].includes(catalogVersion(expected))) throw conflict('Unsupported applied catalog version');
  if (catalogVersion(expected) !== 3) return catalog(client, schema, table, tables);
  const legacy = await catalog(client, schema, table, tables);
  const collations = (await client.query(`SELECT a.attname, CASE WHEN co.oid IS NULL THEN NULL ELSE cn.nspname || '.' || co.collname END AS collation
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
    WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [schema, table])).rows;
  const indexes = (await client.query(`SELECT ic.relname AS name, n.nspname AS schema, c.relname AS table,
    am.amname AS method, i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live,
    i.indnullsnotdistinct AS nulls_not_distinct, i.indnkeyatts AS key_count, i.indnatts AS attribute_count,
    i.indexprs IS NULL AS no_expression, i.indpred IS NULL AS no_predicate,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,pos)
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num WHERE k.pos<=i.indnkeyatts ORDER BY k.pos) AS columns,
    ARRAY(SELECT opt::integer FROM unnest(i.indoption) WITH ORDINALITY v(opt,pos) ORDER BY pos) AS options,
    ARRAY(SELECT pn.nspname || '.' || op.opcname FROM unnest(i.indclass) WITH ORDINALITY v(oid,pos)
      JOIN pg_opclass op ON op.oid=v.oid JOIN pg_namespace pn ON pn.oid=op.opcnamespace ORDER BY pos) AS operator_classes,
    (SELECT bool_and(op.opcdefault) FROM unnest(i.indclass) v(oid) JOIN pg_opclass op ON op.oid=v.oid) AS default_operator_classes,
    ARRAY(SELECT CASE WHEN co.oid IS NULL THEN NULL ELSE cn.nspname || '.' || co.collname END
      FROM unnest(i.indcollation) WITH ORDINALITY v(oid,pos) LEFT JOIN pg_collation co ON co.oid=v.oid
      LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace ORDER BY pos) AS collations,
    (SELECT con.conname FROM pg_constraint con WHERE con.conindid=i.indexrelid AND con.contype IN ('p','u')) AS constraint
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
    WHERE n.nspname=$1 AND c.relname=$2 ORDER BY ic.relname`, [schema, table])).rows;
  return { version: 3, ...Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== 'version' && key !== 'indexes' && key !== 'columns')),
    columns: legacy.columns.map(({ attcollation: _, ...column }) => ({ ...column, collation: collations.find((candidate) => candidate.attname === column.attname)?.collation ?? null })),
    indexes: indexes.map((index) => ({ ...index, category: String(index.name).startsWith('ix_usr_') ? 'user' : String(index.name).startsWith('ix_fk_') ? 'relationship' : index.constraint ? 'constraint' : 'external' })),
  };
}
export async function readCatalog(client: SchemaClient, schema: string, table: string, tables: ManagedTable[] = [], expected?: unknown) {
  if (catalogVersion(expected) === 4) {
    const base = await readLegacyOrV3Catalog(client, schema, table, tables, { version: 3 });
    const descriptors = (expected as { managedDefaultFields: DefaultField[] }).managedDefaultFields;
    if (!Array.isArray(descriptors)) throw conflict('Invalid v4 managed catalog');
    return { ...base, version: 4, managedDefaultFields: descriptors,
      columns: base.columns.map((column: Record<string, unknown>) => {
        const descriptor = descriptors.find((field) => field.name === column.attname);
        return descriptor ? { ...column, default_value: normalizeManagedDefault(column.default_value, descriptor) } : column;
      }) };
  }
  return readLegacyOrV3Catalog(client, schema, table, tables, expected);
}
export function verifyPostCatalog(snapshot: Awaited<ReturnType<typeof readCatalog>>, definition: Definition) {
  if (![3, 4].includes(catalogVersion(snapshot))) return;
  if (catalogVersion(snapshot) === 4) {
    const columns = snapshot.columns as Record<string, unknown>[];
    if (columns.length !== definition.fields.length + 1 || columns[0]?.attname !== 'id') throw conflict('Post-Apply columns do not match managed metadata');
    for (const field of definition.fields) {
      const column = columns.find((candidate) => candidate.attname === field.name);
      const type = field.type === 'varchar' ? `character varying(${field.options.length})` : field.type === 'decimal' ? `numeric(${field.options.precision},${field.options.scale})` : field.type === 'timestamp' ? 'timestamp with time zone' : field.type;
      if (!column || column.type !== type || column.attidentity !== '' || column.attgenerated !== '') throw conflict('Post-Apply column type does not match managed metadata');
    }
    for (const descriptor of (snapshot as { managedDefaultFields?: DefaultField[] }).managedDefaultFields ?? []) {
      const field = definition.fields.find((candidate) => candidate.name === descriptor.name);
      const column = (snapshot.columns as Record<string, unknown>[]).find((candidate) => candidate.attname === descriptor.name);
      if (!field || !column || canonical(column.default_value) !== canonical(expectedDefault(field))) throw conflict('Post-Apply managed default does not match metadata');
    }
  }
  const indexes = snapshot.indexes as Record<string, unknown>[];
  for (const field of definition.fields) if ((snapshot.columns as Record<string, unknown>[]).find((column) => column.attname === field.name)?.attnotnull !== !field.nullable)
    throw conflict('Post-Apply requiredness does not match managed metadata');
  if (indexes.some((index) => index.method !== 'btree' || !index.valid || !index.ready || !index.live || !index.no_expression || !index.no_predicate ||
      index.key_count !== index.attribute_count || index.nulls_not_distinct || !index.default_operator_classes || (index.options as number[]).some((option) => option !== 0)))
    throw conflict('Post-Apply index state does not match supported managed metadata');
  for (const spec of definition.indexes ?? []) {
    const index = indexes.find((candidate) => candidate.name === indexName(spec.id));
    if (!index || index.unique !== spec.unique || index.constraint !== null || canonical(index.columns) !== canonical(spec.fieldIds.map((id) => definition.fields.find((field) => field.id === id)!.name)))
      throw conflict('Post-Apply user index does not match managed metadata');
  }
  if (indexes.filter((index) => index.category === 'user').length !== (definition.indexes?.length ?? 0)) throw conflict('Unexpected managed user index');
}
