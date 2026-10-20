import { canonical } from '../../modules/schema-builder/plan.js';
import { conflict } from '../../modules/schema-builder/errors.js';
import type { ManagedTable } from '../../modules/schema-builder/types.js';
import type { SchemaClient } from './schema-executor.js';

// OIDs and PostgreSQL-generated trigger names are inspection identities, never durable fingerprints.
export async function relationshipCatalog(
  client: SchemaClient,
  schema: string,
  table: string,
  tables: ManagedTable[],
) {
  const expected = tables
    .flatMap(
      (source) =>
        source.appliedDefinition?.definition.fields.flatMap((field) => {
          if (!field.relationship) return [];
          const target = tables.find(
            (t) => t.id === field.relationship!.tableId,
          )?.appliedDefinition?.definition;
          if (!target)
            throw conflict('Managed relationship target is unavailable');
          const definition = source.appliedDefinition!.definition;
          return [
            {
              schema: definition.schema,
              source: definition.name,
              field: field.name,
              targetSchema: target.schema,
              target: target.name,
              constraint: `fk_${field.id.replaceAll('-', '')}`,
              index: `ix_fk_${field.id.replaceAll('-', '')}`,
            },
          ];
        }) ?? [],
    )
    .filter(
      (r) =>
        (r.schema === schema && r.source === table) ||
        (r.targetSchema === schema && r.target === table),
    );
  if (!expected.length) return { triggers: new Set<string>(), outgoing: [] };
  const { rows } = await client.query(
    `SELECT con.conname, sn.nspname AS source_schema, s.relname AS source,
    tn.nspname AS target_schema, t.relname AS target, con.confdeltype, con.confupdtype,
    con.convalidated, con.condeferrable, con.condeferred, con.confmatchtype,
    COALESCE((to_jsonb(con)->>'conenforced')::boolean, true) AS enforced,
    ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num, pos) JOIN pg_attribute a ON a.attrelid=s.oid AND a.attnum=k.num ORDER BY k.pos) AS source_columns,
    ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num, pos) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.num ORDER BY k.pos) AS target_columns,
    (SELECT jsonb_agg(jsonb_build_object('name', tr.tgname, 'enabled', tr.tgenabled, 'internal', tr.tgisinternal,
      'deferrable', tr.tgdeferrable, 'deferred', tr.tginitdeferred, 'type', tr.tgtype, 'schema', rn.nspname, 'table', rc.relname, 'function', p.proname, 'functionSchema', pn.nspname))
      FROM pg_trigger tr JOIN pg_class rc ON rc.oid=tr.tgrelid JOIN pg_namespace rn ON rn.oid=rc.relnamespace
      JOIN pg_proc p ON p.oid=tr.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE tr.tgconstraint=con.oid) AS triggers
    FROM pg_constraint con JOIN pg_class s ON s.oid=con.conrelid JOIN pg_namespace sn ON sn.oid=s.relnamespace
    JOIN pg_class t ON t.oid=con.confrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace
    WHERE con.contype='f' AND ((sn.nspname=$1 AND s.relname=$2) OR (tn.nspname=$1 AND t.relname=$2))`,
    [schema, table],
  );
  const indexes = await client.query(
    `SELECT n.nspname AS schema, c.relname AS source, ic.relname AS name,
    am.amname, i.indisvalid, i.indisready, i.indisunique, i.indnkeyatts, i.indnatts,
    i.indpred IS NULL AND i.indexprs IS NULL AS plain,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,pos) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.pos) AS columns
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
    [schema, [...new Set(expected.map((r) => r.source))]],
  );
  const triggers = new Set<string>();
  const outgoing: unknown[] = [];
  for (const relationship of expected) {
    const matches = rows.filter(
      (r) =>
        r.source_schema === relationship.schema &&
        r.source === relationship.source &&
        r.conname === relationship.constraint,
    );
    const row = matches[0];
    if (
      matches.length !== 1 ||
      !row ||
      row.target_schema !== relationship.targetSchema ||
      row.target !== relationship.target ||
      canonical(row.source_columns) !== canonical([relationship.field]) ||
      canonical(row.target_columns) !== canonical(['id']) ||
      row.confdeltype !== 'r' ||
      row.confupdtype !== 'a' ||
      row.confmatchtype !== 's' ||
      row.convalidated !== true ||
      row.enforced !== true ||
      row.condeferrable !== false ||
      row.condeferred !== false
    )
      throw conflict(
        'Managed relationship drift detected; operator review is required',
      );
    const actualTriggers = row.triggers as Record<string, unknown>[] | null;
    const required = [
      ['RI_FKey_check_ins', relationship.schema, relationship.source, 5],
      ['RI_FKey_check_upd', relationship.schema, relationship.source, 17],
      [
        'RI_FKey_restrict_del',
        relationship.targetSchema,
        relationship.target,
        9,
      ],
      [
        'RI_FKey_noaction_upd',
        relationship.targetSchema,
        relationship.target,
        17,
      ],
    ];
    if (
      !actualTriggers ||
      actualTriggers.length !== 4 ||
      required.some(
        ([fn, ns, name, type]) =>
          !actualTriggers.some(
            (t) =>
              t.function === fn &&
              t.functionSchema === 'pg_catalog' &&
              t.schema === ns &&
              t.table === name &&
              t.type === type &&
              t.enabled === 'O' &&
              t.deferrable === false &&
              t.deferred === false &&
              t.internal === true,
          ),
      )
    )
      throw conflict('Managed relationship enforcement needs operator review');
    const index = indexes.rows.find(
      (i) =>
        i.schema === relationship.schema &&
        i.source === relationship.source &&
        i.name === relationship.index,
    );
    if (
      !index ||
      index.amname !== 'btree' ||
      !index.indisvalid ||
      !index.indisready ||
      index.indisunique ||
      index.indnkeyatts !== 1 ||
      index.indnatts !== 1 ||
      !index.plain ||
      canonical(index.columns) !== canonical([relationship.field])
    )
      throw conflict('Managed relationship index needs operator review');
    for (const trigger of actualTriggers)
      if (trigger.schema === schema && trigger.table === table)
        triggers.add(String(trigger.name));
    if (relationship.schema === schema && relationship.source === table)
      outgoing.push({
        ...relationship,
        delete: 'restrict',
        update: 'no_action',
        validated: true,
        enforced: true,
        deferrable: false,
        enforcement: 'verified',
      });
  }
  return {
    triggers,
    outgoing: outgoing.sort((a, b) => canonical(a).localeCompare(canonical(b))),
  };
}
