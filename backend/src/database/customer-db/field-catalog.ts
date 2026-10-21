import type { Plan } from '../../modules/schema-builder/types.js';
import { canonical } from '../../modules/schema-builder/plan.js';
import { conflict } from '../../modules/schema-builder/errors.js';
import type { SchemaClient } from './schema-executor.js';

type Snapshot = { version?: number; columns: Record<string, unknown>[]; constraints: Record<string, unknown>[]; indexes: Record<string, unknown>[]; relation: unknown; triggers: unknown; foreignKeys?: unknown };
// Verify the bounded delta, in addition to verifying the final managed field/default semantics.
// No unrelated customer object may be adopted into an authenticated v4 receipt.
export async function verifyFieldCatalogTransition(client: SchemaClient, plan: Plan, value: unknown) {
  if (plan.evolution?.version !== 4) return;
  const before = plan.evolution.before!.catalog as Snapshot, after = value as Snapshot;
  const bundle = plan.evolution.bundle;
  const field = plan.definition.fields.find((candidate) => candidate.id === bundle.fieldId)!;
  const referenceAddition = bundle.addition && field.relationship;
  const fk = referenceAddition ? `fk_${field.id.replaceAll('-', '')}` : undefined;
  const ix = referenceAddition ? `ix_fk_${field.id.replaceAll('-', '')}` : undefined;
  const mismatch = () => conflict('Post-Apply catalog contains an unexpected structural change');
  if (canonical(before.relation) !== canonical(after.relation) || canonical(before.triggers) !== canonical(after.triggers)) throw mismatch();
  const comparableColumn = (column: Record<string, unknown>, changed: boolean) => Object.fromEntries(Object.entries(column).filter(([key]) =>
    key !== 'attcollation' && (key !== 'collation' || (before.version ?? 1) >= 3) &&
    !(changed && bundle.enforceRequired && key === 'attnotnull') && !(changed && bundle.defaultChanged && key === 'default_value')));
  for (const old of before.columns) {
    const current = after.columns.find((column) => column.attname === old.attname);
    if (!current || canonical(comparableColumn(old, old.attname === field.name)) !== canonical(comparableColumn(current, old.attname === field.name))) throw mismatch();
  }
  if (bundle.addition && after.columns.find((column) => column.attname === field.name)?.attnum !== Math.max(...before.columns.map((column) => Number(column.attnum))) + 1) throw mismatch();
  if ((before.version ?? 1) < 3) {
    const collations = (await client.query(`SELECT a.attname,a.attcollation::text AS collation_oid FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped`, [plan.definition.schema, plan.definition.name])).rows;
    if (before.columns.some((column) => collations.find((current) => current.attname === column.attname)?.collation_oid !== column.attcollation)) throw mismatch();
  }
  if (bundle.addition && after.columns.find((column) => column.attname === field.name)?.collation !== (['text', 'varchar'].includes(field.type) ? 'pg_catalog.default' : null)) throw mismatch();
  let requiredConstraints = 0;
  const constraints = after.constraints.filter((constraint) => {
    if (fk && constraint.conname === fk) return false; // FK semantics are checked by relationshipCatalog.
    if (bundle.enforceRequired && !before.constraints.some((old) => old.conname === constraint.conname) && constraint.definition === `NOT NULL ${field.name}` && constraint.convalidated === true) { requiredConstraints++; return false; }
    return true;
  });
  if (requiredConstraints > 1 || canonical(before.constraints) !== canonical(constraints)) throw mismatch();
  let indexes = after.indexes.filter((index) => index.name !== ix);
  if ((before.version ?? 1) < 3) indexes = (await client.query('SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname', [plan.definition.schema, plan.definition.name])).rows.filter((index) => index.indexname !== ix);
  if (canonical(before.indexes) !== canonical(indexes)) throw mismatch();
  if (!referenceAddition && canonical(before.foreignKeys) !== canonical(after.foreignKeys)) throw mismatch();
}
