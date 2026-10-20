import type {
  AppliedDefinition,
  ManagedTable,
} from '../../modules/schema-builder/types.js';
import {
  canonical,
  quoteIdentifier as q,
} from '../../modules/schema-builder/plan.js';
import { conflict } from '../../modules/schema-builder/errors.js';
import { readCatalog } from './index-catalog.js';
import type { SchemaClient } from './schema-executor.js';

// FK targets are catalog dependencies, not additional customer workflow actions.
export async function checkManagedCatalogs(
  client: SchemaClient,
  roots: AppliedDefinition[],
  tables: ManagedTable[] = [],
) {
  const definitions = new Map<string, AppliedDefinition>();
  function visit(applied: AppliedDefinition) {
    const identity = `${applied.definition.schema}.${applied.definition.name}`;
    if (definitions.has(identity)) return;
    definitions.set(identity, applied);
    for (const field of applied.definition.fields)
      if (field.relationship) {
        const target = tables.find(
          (t) => t.id === field.relationship!.tableId,
        )?.appliedDefinition;
        if (!target)
          throw conflict('Managed relationship target is unavailable');
        visit(target);
      }
  }
  roots.forEach(visit);
  const identity = (applied: AppliedDefinition) =>
    `${q(applied.definition.schema)}.${q(applied.definition.name)}`;
  const sorted = [...definitions.values()].sort((a, b) =>
    identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0,
  );
  for (const applied of sorted)
    await client.query(
      `LOCK TABLE ONLY ${q(applied.definition.schema)}.${q(applied.definition.name)} IN ACCESS SHARE MODE`,
    );
  for (const applied of sorted)
    if (
      canonical(
        await readCatalog(
          client,
          applied.definition.schema,
          applied.definition.name,
          tables,
          applied.catalog,
        ),
      ) !== canonical(applied.catalog)
    )
      throw conflict(
        'Customer schema drift detected; operator review is required',
      );
}
