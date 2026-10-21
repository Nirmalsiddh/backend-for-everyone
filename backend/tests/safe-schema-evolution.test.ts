import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import { generatePlan, canonical } from '../src/modules/schema-builder/plan.js';
import { generateEvolutionPlan } from '../src/modules/schema-builder/evolution.js';
import { normalizeManagedDefault } from '../src/database/customer-db/default-catalog.js';
import { v4Preview } from '../src/modules/schema-builder/evolution-v4.js';
import type { FieldDefinition, TableRecord } from '../src/modules/schema-builder/types.js';
function fixture(type: FieldDefinition['type'] = 'text'): TableRecord {
  const draft = normalizeDraft({ name: 'records', fields: [{ name: 'status', type, ...(type === 'decimal' ? { options: { precision: 38, scale: 6 } } : {}) }] });
  return { ...draft, id: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', connectionId: '33333333-3333-4333-8333-333333333333', schemaName: 'public', draftRevision: 2, appliedRevision: 1, appliedPhysicalRevision: 1, appliedDefinition: { definition: { schema: 'public', ...draft }, catalog: {} }, createdAt: new Date(0), updatedAt: new Date(0) };
}
test('v4 intent is bound to hash, absent from applied definition and structured preview values', () => {
  const table = fixture(); table.fields = [{ ...table.fields[0]!, nullable: false, backfillIntent: { kind: 'literal', value: 'historical-marker' }, default: { kind: 'literal', value: 'future-marker' } }];
  const plan = generatePlan(table);
  assert.equal(plan.version, 4); assert.equal(plan.evolution?.contractChange, true);
  assert.ok(!canonical(plan.definition).includes('historical-marker'));
  assert.ok(!canonical(v4Preview(plan)).includes('marker'));
  assert.deepEqual(plan.statements, []);
  assert.notEqual(plan.hash, generatePlan({ ...table, fields: [{ ...table.fields[0]!, backfillIntent: { kind: 'literal', value: 'other' } }] }).hash);
});
test('standalone fill, unsupported defaults, additions without strategy and unrelated bundles fail closed', () => {
  const table = fixture();
  assert.throws(() => generatePlan({ ...table, fields: [{ ...table.fields[0]!, backfillIntent: { kind: 'literal', value: '' } }] }));
  for (const type of ['uuid', 'jsonb', 'date', 'timestamp'] as const) {
    const record = fixture(type);
    assert.throws(() => generatePlan({ ...record, fields: [{ ...record.fields[0]!, default: { kind: 'literal', value: 'unsupported' } }] }));
  }
  const addition = normalizeDraft({ name: table.name, fields: [{ name: 'added', type: 'text', nullable: false }] }).fields[0]!;
  assert.throws(() => generatePlan({ ...table, fields: [...table.fields, addition] }));
  assert.throws(() => generatePlan({ ...table, fields: [{ ...table.fields[0]!, default: { kind: 'literal', value: 'x' } }, { ...addition, default: { kind: 'literal', value: 'y' } }] }));
});
test('falsy values survive normalization, plan serialization and typed fills', () => {
  for (const [type, value] of [['text', ''], ['boolean', false], ['integer', 0], ['bigint', '0'], ['decimal', '0']] as const) {
    const table = fixture(type);
    const { position: _, ...input } = table.fields[0]!;
    const draft = normalizeDraft({ name: table.name, fields: [{ ...input, default: { kind: 'literal', value }, nullable: false, backfillIntent: { kind: 'literal', value } }] }, table.fields);
    const plan = generatePlan({ ...table, fields: draft.fields });
    assert.equal(plan.evolution?.version, 4);
    if (plan.evolution?.version === 4) assert.equal(plan.evolution.bundle.fill?.value, value);
  }
});
test('structured default grammar preserves exact values and rejects expression/function shapes', () => {
  const matrix = [
    ['text', "'a''b'::text", "a'b"], ['boolean', 'false', false], ['integer', "'-2147483648'::integer", -2147483648],
    ['bigint', "'9223372036854775807'::bigint", '9223372036854775807'], ['decimal', "'-9007199254740993.120000'::numeric", '-9007199254740993.12'],
  ] as const;
  for (const [type, expression, value] of matrix) assert.deepEqual(normalizeManagedDefault(expression, fixture(type).fields[0]!), { kind: 'literal', value });
  for (const expression of ['now()', 'CURRENT_TIMESTAMP', 'gen_random_uuid()', '(SELECT 1)', '1 + 2', "'x'::regclass", 'NULL::text']) assert.throws(() => normalizeManagedDefault(expression, fixture().fields[0]!));
});
test('unchanged historical v3 requiredness continues through frozen planner', () => {
  const table = fixture(); table.fields = [{ ...table.fields[0]!, nullable: false }];
  assert.equal(generatePlan(table).hash, generateEvolutionPlan(table, []).hash);
  assert.equal(generatePlan(table).version, 3);
});
test('v4 POST delta rejects unrelated columns, constraints, indexes and triggers', async () => {
  const { verifyFieldCatalogTransition } = await import('../src/database/customer-db/field-catalog.js');
  const table = fixture();
  const before = { version: 3, relation: [], triggers: [], constraints: [], indexes: [], columns: [
    { attname: 'id', attnum: 1, type: 'uuid', attnotnull: true, default_value: 'gen_random_uuid()', collation: null },
    { attname: 'status', attnum: 2, type: 'text', attnotnull: false, default_value: null, collation: 'pg_catalog.default' },
  ] };
  table.appliedDefinition!.catalog = before; table.fields = [{ ...table.fields[0]!, default: { kind: 'literal', value: 'future' } }];
  const plan = generatePlan(table);
  const after = { ...before, version: 4, columns: before.columns.map((column) => column.attname === 'status' ? { ...column, default_value: { kind: 'literal', value: 'future' } } : column) };
  const client = { connect: async () => {}, end: async () => {}, on: () => {}, query: async () => ({ rows: [] }) };
  await verifyFieldCatalogTransition(client, plan, after);
  for (const changed of [
    { ...after, columns: after.columns.map((column) => column.attname === 'id' ? { ...column, type: 'text' } : column) },
    { ...after, constraints: [{ conname: 'unplanned', definition: 'CHECK (true)' }] },
    { ...after, indexes: [{ name: 'unplanned' }] },
    { ...after, triggers: [{ tgname: 'unplanned' }] },
  ]) await assert.rejects(verifyFieldCatalogTransition(client, plan, changed), { code: 'SCHEMA_CONFLICT' });
});
