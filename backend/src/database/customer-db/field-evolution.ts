import type { Plan } from '../../modules/schema-builder/types.js';
import type { SchemaClient } from './schema-executor.js';
import { quoteIdentifier as q, sqlType } from '../../modules/schema-builder/plan.js';
import { defaultSql } from '../../modules/schema-builder/evolution-v4.js';
import { conflict, SchemaError } from '../../modules/schema-builder/errors.js';

export async function executeFieldBundle(client: SchemaClient, plan: Plan) {
  if (plan.evolution?.version !== 4) return;
  const bundle = plan.evolution.bundle;
  const before = plan.evolution.before?.catalog as { triggers?: unknown[] } | undefined;
  if ((bundle.fill || (bundle.addition && bundle.enforceRequired)) && before?.triggers?.length) throw conflict('Historical fills are unsupported on tables with external triggers');
  const field = plan.definition.fields.find((candidate) => candidate.id === bundle.fieldId)!;
  const target = `${q(plan.definition.schema)}.${q(plan.definition.name)}`;
  const column = q(field.name);
  if (field.type === 'text' || field.type === 'varchar') {
    const values = [...(bundle.fill ? [bundle.fill.value] : []), ...((bundle.defaultChanged || bundle.addition) && field.default?.kind === 'literal' ? [field.default.value] : [])];
    for (const value of values) {
      const row = (await client.query(`SELECT $1::${sqlType(field)}::pg_catalog.text AS value`, [value])).rows[0];
      if (row?.value !== value) throw new SchemaError(422, 'SCHEMA_DATA_INVALID', 'Value cannot be represented exactly by the target field');
    }
  }
  if (bundle.addition) await client.query(`ALTER TABLE ${target} ADD COLUMN ${column} ${sqlType(field)}${!bundle.enforceRequired && field.default ? ` DEFAULT ${defaultSql(field)}` : ''}`);
  // Install a new reference before filling so the real FK is always authoritative.
  if (bundle.addition && field.relationship) {
    const dependency = plan.dependencies!.find((candidate) => candidate.tableId === field.relationship!.tableId)!;
    const suffix = field.id.replaceAll('-', '');
    await client.query(`ALTER TABLE ${target} ADD CONSTRAINT ${q(`fk_${suffix}`)} FOREIGN KEY (${column}) REFERENCES ${q(dependency.definition.schema)}.${q(dependency.definition.name)} ("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE`);
    await client.query(`CREATE INDEX ${q(`ix_fk_${suffix}`)} ON ${target} USING btree (${column})`);
  }
  const fill = bundle.fill ?? (bundle.addition && bundle.enforceRequired && field.default?.kind === 'literal' ? field.default : undefined);
  if (fill !== undefined) {
    const privilege = (await client.query("SELECT has_column_privilege(current_user, $1, $2, 'UPDATE') AS allowed", [target, field.name])).rows[0];
    if (!privilege?.allowed) throw new SchemaError(422, 'SCHEMA_PERMISSION_DENIED', 'Customer credential cannot perform this schema operation');
    await client.query(`UPDATE ONLY ${target} SET ${column} = $1::${sqlType(field)} WHERE ${column} IS NULL`, [fill.value]);
  }
  if (bundle.enforceRequired && (await client.query(`SELECT 1 FROM ONLY ${target} WHERE ${column} IS NULL LIMIT 1`)).rows.length) throw new SchemaError(422, 'SCHEMA_DATA_INVALID', 'Existing data does not satisfy the proposed constraint');
  if (bundle.defaultChanged) await client.query(`ALTER TABLE ${target} ALTER COLUMN ${column} ${field.default ? `SET DEFAULT ${defaultSql(field)}` : 'DROP DEFAULT'}`);
  if (bundle.enforceRequired) await client.query(`ALTER TABLE ${target} ALTER COLUMN ${column} SET NOT NULL`);
}
