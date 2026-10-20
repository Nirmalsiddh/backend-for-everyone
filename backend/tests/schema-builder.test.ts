import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { normalizeDraft, validateIdentifier, validateTargetSchema } from '../src/modules/schema-builder/validation.js';
import { canonical, generatePlan, generateLegacyPlan, quoteIdentifier } from '../src/modules/schema-builder/plan.js';
import type { DraftInput, FieldInput, TableRecord } from '../src/modules/schema-builder/types.js';

function table(input: DraftInput): TableRecord {
  const draft = normalizeDraft(input);
  return { id: randomUUID(), projectId: randomUUID(), connectionId: randomUUID(), schemaName: 'public', ...draft,
    draftRevision: 1, appliedRevision: null, appliedDefinition: null, createdAt: new Date(), updatedAt: new Date() };
}
test('drafts support all MVP field types and typed defaults', () => {
  const fields: FieldInput[] = [
    { name: 'title', type: 'text', nullable: false, unique: true, default: { kind: 'literal', value: "O'Reilly\\books" } },
    { name: 'short_name', type: 'varchar', options: { length: 20 }, default: { kind: 'literal', value: 'short' } },
    { name: 'count', type: 'integer', default: { kind: 'literal', value: -2147483648 } },
    { name: 'large_count', type: 'bigint', default: { kind: 'literal', value: '9223372036854775807' } },
    { name: 'price', type: 'decimal', options: { precision: 8, scale: 2 }, default: { kind: 'literal', value: '123456.78' } },
    { name: 'active', type: 'boolean', default: { kind: 'literal', value: false } },
    { name: 'external_id', type: 'uuid', default: { kind: 'literal', value: randomUUID() } },
    { name: 'birthday', type: 'date', default: { kind: 'literal', value: '2024-02-29' } },
    { name: 'created_at', type: 'timestamp', default: { kind: 'current_timestamp' } },
    { name: 'settings', type: 'jsonb', default: { kind: 'literal', value: { label: "x'); DROP TABLE users; --", enabled: true } } },
  ];
  const record = table({ name: 'products', fields });
  assert.equal(record.fields.length, 10);
  assert.equal(new Set(record.fields.map((field) => field.id)).size, 10);
  const plan = generatePlan(record);
  assert.equal(plan.hash, generatePlan(record).hash);
  assert.match(plan.statements[0]!, /CREATE TABLE "public"\."products"/);
  assert.match(plan.statements[0]!, /PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid\(\)/);
  assert.match(plan.statements[0]!, /NOT NULL/);
  assert.match(plan.statements[0]!, /UNIQUE/);
  assert.match(plan.statements[0]!, /E'O''Reilly\\\\books'/);
  assert.match(plan.statements[0]!, /pg_catalog.timestamptz DEFAULT CURRENT_TIMESTAMP/);
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.equal(quoteIdentifier('odd"schema'), '"odd""schema"');
});
test('strict names exclude primary key, system, internal, ambiguous and injected identifiers', () => {
  for (const name of ['id', 'ctid', 'xmin', 'tableoid', 'pg_data', 'internal_data', 'platform_data', 'schema_fields', 'a.b', 'a b', 'A', '1a', 'a__b', 'a_', 'a"b', 'a--b', 'a/*b*/', 'x'.repeat(64), 'select']) {
    assert.throws(() => validateIdentifier(name), { code: 'INVALID_SCHEMA' });
  }
  for (const name of ['products', 'product_items', 'item2']) assert.doesNotThrow(() => validateIdentifier(name));
  for (const name of ['pg_catalog', 'information_schema', 'pg_temp', 'x\0y']) assert.throws(() => validateTargetSchema(name));
});
test('reject invalid types, type options, unsafe expressions, ranges, and invalid default values', () => {
  const cases: unknown[] = [
    { type: 'sql' }, { type: 'varchar' }, { type: 'varchar', options: { length: 0 } },
    { type: 'text', options: { precision: 2 } }, { type: 'decimal', options: { precision: 2, scale: 3 } },
    { type: 'text', default: 'now()' }, { type: 'text', default: { kind: 'sql', value: 'now()' } },
    { type: 'text', default: { kind: 'current_timestamp' } }, { type: 'text', default: { kind: 'literal', value: null } },
    { type: 'integer', default: { kind: 'literal', value: 2147483648 } },
    { type: 'bigint', default: { kind: 'literal', value: '9223372036854775808' } },
    { type: 'bigint', default: { kind: 'literal', value: 12 } },
    { type: 'decimal', options: { precision: 3, scale: 2 }, default: { kind: 'literal', value: '12.00' } },
    { type: 'boolean', default: { kind: 'literal', value: 'false' } },
    { type: 'date', default: { kind: 'literal', value: '2023-02-29' } },
    { type: 'timestamp', default: { kind: 'literal', value: '2024-01-01T12:00:00' } },
    { type: 'uuid', default: { kind: 'literal', value: 'invalid' } },
    { type: 'jsonb', unique: true }, { type: 'jsonb', default: { kind: 'literal', value: '\u0000' } },
    { type: 'text', default: { kind: 'literal', value: 'x', sql: 'DROP TABLE users' } },
  ];
  for (const item of cases) assert.throws(() => normalizeDraft({ name: 'products', fields: [{ name: 'value', ...item as object } as FieldInput] }), { code: 'INVALID_SCHEMA' });
  assert.throws(() => normalizeDraft({ name: 'products', fields: [{ name: 'title', type: 'text' }, { name: 'title', type: 'text' }] }));
  assert.doesNotThrow(() => normalizeDraft({ name: 'products', fields: [{ name: 'payload', type: 'jsonb', default: { kind: 'literal', value: null } }] }));
});
test('draft edits preserve field identities and applied tables allow only nullable additions', () => {
  const record = table({ name: 'products', fields: [{ name: 'title', type: 'text' }] });
  const editable = record.fields.map(({ default: def, ...field }) => ({ ...field, ...(def ? { default: def } : {}) }));
  // API field inputs do not include server-controlled position.
  const inputs = editable.map(({ position: _position, ...field }) => field);
  const edited = normalizeDraft({ name: 'items', fields: inputs }, record.fields);
  assert.equal(edited.fields[0]?.id, record.fields[0]?.id);
  const applied = { ...record, appliedRevision: 1, appliedDefinition: { definition: { schema: 'public', name: record.name, fields: record.fields }, catalog: {} } };
  const additions = normalizeDraft({ name: record.name, fields: [...inputs, { name: 'notes', type: 'text' }] }, record.fields);
  const plan = generatePlan({ ...applied, ...additions, draftRevision: 2 });
  assert.equal(plan.operation, 'add_columns');
  assert.deepEqual(plan.statements, ['ALTER TABLE "public"."products" ADD COLUMN "notes" pg_catalog.text;']);
  const required = { ...applied, fields: record.fields.map((field) => ({ ...field, nullable: false })), draftRevision: 2 };
  assert.equal(generatePlan(required).evolution?.actions[0]?.kind, 'set_not_null');
  assert.throws(() => generateLegacyPlan(required), { code: 'SCHEMA_CONFLICT' });
  for (const changed of [
    { name: 'renamed', fields: record.fields }, { fields: [] },
    { fields: record.fields.map((field) => ({ ...field, name: 'renamed' })) },
    { fields: record.fields.map((field) => ({ ...field, type: 'integer' as const })) },

    { fields: [...record.fields, { ...additions.fields[1]!, nullable: false }] },
    { fields: [...record.fields, { ...additions.fields[1]!, unique: true }] },
    { fields: [...record.fields, { ...additions.fields[1]!, default: { kind: 'literal' as const, value: 'x' } }] },
  ]) assert.throws(() => generatePlan({ ...applied, ...changed }), { code: 'SCHEMA_CONFLICT' });
});
