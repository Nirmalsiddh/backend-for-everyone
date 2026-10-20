import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { normalizeIndexes, indexName } from '../src/modules/schema-builder/indexes.js';
import { generatePlan, generateLegacyPlan } from '../src/modules/schema-builder/plan.js';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import type { FieldDefinition, TableRecord, IndexInput } from '../src/modules/schema-builder/types.js';
const draft = normalizeDraft({ name: 'products', fields: ['uuid', 'integer', 'bigint', 'boolean', 'decimal', 'timestamp'].map((type, i) => ({ name: `value${i}`, type: type as FieldDefinition['type'], ...(type === 'decimal' ? { options: { precision: 38, scale: 2 } } : {}) })) });
const fields = draft.fields;
const input = (unique = false, ids = [fields[0]!.id]): IndexInput => ({ fieldIds: ids, unique });
const table = (): TableRecord => ({ id: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', connectionId: '33333333-3333-4333-8333-333333333333', schemaName: 'public', ...draft, draftRevision: 2, appliedRevision: 1, appliedPhysicalRevision: 1, appliedDefinition: { definition: { schema: 'public', ...draft }, catalog: {} }, createdAt: new Date(0), updatedAt: new Date(0) });
test('index bounds, types, ownership of fields, duplicates and deterministic safe names', () => {
  for (const field of fields) assert.equal(normalizeIndexes([input(false, [field.id])], fields).length, 1);
  for (const count of [1, 2, 3, 4]) assert.deepEqual(normalizeIndexes([input(false, fields.slice(0, count).map((f) => f.id))], fields)[0]!.fieldIds, fields.slice(0, count).map((f) => f.id));
  for (const ids of [[], [fields[0]!.id, fields[0]!.id], fields.slice(0, 5).map((f) => f.id), ['id'], [randomUUID()]]) assert.throws(() => normalizeIndexes([input(false, ids)], fields));
  assert.throws(() => normalizeIndexes(Array.from({ length: 9 }, () => input()), fields));
  for (const type of ['text', 'varchar', 'jsonb', 'date'] as const) assert.throws(() => normalizeIndexes([input()], [{ ...fields[0]!, type }]));
  assert.throws(() => normalizeIndexes([input(), input()], fields));
  const pair = fields.slice(0, 2).map((f) => f.id);
  assert.equal(normalizeIndexes([input(false, pair), input(false, [...pair].reverse())], fields).length, 2);
  assert.throws(() => normalizeIndexes([input(true, pair), input(true, [...pair].reverse())], fields));
  assert.throws(() => normalizeIndexes([input()], [{ ...fields[0]!, unique: true }]));
  const reference = [{ ...fields[0]!, relationship: { tableId: randomUUID(), onDelete: 'restrict' as const } }];
  assert.throws(() => normalizeIndexes([input()], reference));
  assert.throws(() => normalizeIndexes([input(true)], reference));
  const id = randomUUID(); assert.equal(indexName(id), indexName(id)); assert.ok(Buffer.byteLength(indexName(id)) <= 63); assert.throws(() => indexName('x;DROP'));
});
test('applied index immutability and draft-only removal', () => {
  const index = normalizeIndexes([input()], fields)[0]!;
  assert.deepEqual(normalizeIndexes([], fields, [index]), []);
  for (const candidate of [[], [{ id: index.id, unique: true, fieldIds: index.fieldIds }], [{ id: index.id, unique: false, fieldIds: [fields[1]!.id] }]]) assert.throws(() => normalizeIndexes(candidate, fields, [index], [index]));
});
test('v3 plans bind physical state, ordered indexes, prior catalog and classify contract changes', () => {
  for (const unique of [false, true]) {
    const record = table(); record.indexes = normalizeIndexes([input(unique, fields.slice(0, 2).map((f) => f.id))], fields);
    const plan = generatePlan(record);
    assert.equal(plan.version, 3); assert.equal(plan.evolution?.contractChange, unique); assert.equal(plan.hash, generatePlan(record).hash);
    assert.notEqual(plan.hash, generatePlan({ ...record, appliedPhysicalRevision: 2 }).hash);
    assert.notEqual(plan.hash, generatePlan({ ...record, appliedDefinition: { ...record.appliedDefinition!, catalog: { modified: true } } }).hash);
    assert.match(plan.statements[0]!, unique ? /CREATE UNIQUE INDEX/ : /CREATE INDEX/);
  }
  const record = table(); record.fields = fields.map((field, i) => i ? field : { ...field, nullable: false });
  assert.equal(generatePlan(record).evolution?.contractChange, true);
  assert.throws(() => generatePlan({ ...record, fields: record.fields.map((field) => ({ ...field, nullable: false })) }));
  assert.throws(() => generatePlan({ ...record, fields: record.fields.map((field, i) => i ? field : { ...field, name: 'renamed' }) }));
  record.indexes = normalizeIndexes([input()], fields); assert.throws(() => generatePlan(record));
});
test('legacy plan output excludes physical/index properties and retains historical requiredness restrictions', () => {
  const record = table(); record.appliedDefinition = null; record.appliedRevision = null; record.draftRevision = 1;
  const legacy = generateLegacyPlan(record);
  assert.equal(legacy.hash, generateLegacyPlan({ ...record, appliedPhysicalRevision: 100, indexes: [] }).hash);
  assert.ok(!Object.hasOwn(legacy.definition, 'indexes'));
  assert.equal(generatePlan(record).hash, legacy.hash);
});
