import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import { validateList } from '../src/runtime/validation.js';
import { selectList } from '../src/runtime/queries.js';
import type { FieldInput } from '../src/modules/schema-builder/types.js';
const uuid = '00000000-0000-4000-8000-000000000001';
const cases = [
  ['text', 'ACME, Inc.', ['eq', 'neq', 'in']],
  ['varchar', 'A&B', ['eq', 'neq', 'in']],
  ['integer', '2147483647', ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']],
  ['bigint', '9223372036854775807', ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']],
  ['decimal', '123456789012345678.90', ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']],
  ['date', '2024-02-29', ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']],
  ['timestamp', '2026-01-01T00:00:00.123456+05:30', ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']],
  ['boolean', 'false', ['eq', 'neq']],
  ['uuid', uuid, ['eq', 'neq', 'in']],
  ['jsonb', '{}', []],
] as const;
const definition = { schema: 'public', ...normalizeDraft({ name: 'products', fields: cases.map(([type]) => ({ name: 'value_' + type, type, nullable: true, ...(type === 'varchar' ? { options: { length: 100 } } : {}), ...(type === 'decimal' ? { options: { precision: 20, scale: 2 } } : {}) })) as FieldInput[] }) };
for (const [type, value, supported] of cases) for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'wat']) {
  test(`operator matrix ${type}/${op}`, () => {
    const key = `filter[value_${type}][${op}]`;
    const input = op === 'in' ? JSON.stringify([value]) : op === 'is_null' ? 'true' : value;
    if ((supported as readonly string[]).includes(op) || (op === 'is_null' && type !== 'jsonb')) {
      const options = validateList(definition, { [key]: input });
      const compiled = selectList(definition, options);
      if (op === 'is_null') assert.match(compiled.text, /IS NULL/);
      else assert.ok(compiled.values.includes(type === 'integer' ? Number(value) : type === 'boolean' ? false : value));
      assert.ok(!compiled.text.includes(value));
    } else assert.throws(() => validateList(definition, { [key]: input }), { code: 'INVALID_FILTER' });
  });
}
test('primary key, relationship UUID and required NULL matrix', () => {
  for (const op of ['eq', 'neq', 'in']) assert.equal(validateList(definition, { [`filter[id][${op}]`]: op === 'in' ? JSON.stringify([uuid]) : uuid }).filters.length, 1);
  for (const op of ['gt', 'gte', 'lt', 'lte', 'is_null']) assert.throws(() => validateList(definition, { [`filter[id][${op}]`]: 'true' }), { code: 'INVALID_FILTER' });
  const field = definition.fields.find((field) => field.type === 'uuid')!;
  const reference = { ...definition, fields: [{ ...field, relationship: { tableId: uuid, onDelete: 'restrict' as const } }] };
  for (const op of ['eq', 'neq', 'in', 'is_null']) validateList(reference, { [`filter[${field.name}][${op}]`]: op === 'in' ? JSON.stringify([uuid]) : op === 'is_null' ? 'false' : uuid });
  assert.throws(() => validateList({ ...definition, fields: [{ ...field, nullable: false }] }, { [`filter[${field.name}][is_null]`]: 'true' }), { code: 'INVALID_FILTER' });
});
test('strict grammar, duplicate aliases and clause bounds preserve legacy errors', () => {
  for (const key of ['filter[value_text][eq][x]', 'filter[value_text][0]', 'filter[field.name]', 'filter[customer.name]', 'filter[][eq]', 'filter[*]', 'filter[value_text][EQ]', 'filter[unknown][eq]', 'filter[draft_field][eq]'])
    assert.throws(() => validateList(definition, { [key]: 'x' }), { statusCode: 400 });
  assert.throws(() => validateList(definition, { 'filter[value_text]': 'x', 'filter[value_text][eq]': 'x' }), { code: 'INVALID_FILTER' });
  assert.throws(() => validateList(definition, { 'filter[value_text][eq]': ['x', 'x'] }), { code: 'INVALID_FILTER' });
  assert.throws(() => validateList(definition, { 'filter[value_text]': ['x', 'x'] }), { code: 'INVALID_REQUEST' });
  const five = Object.fromEntries(['eq', 'neq', 'gt', 'gte', 'lt'].map((op) => [`filter[value_integer][${op}]`, '1']));
  assert.equal(validateList(definition, five).filters.length, 5);
  assert.throws(() => validateList(definition, { ...five, 'filter[value_integer][lte]': '2' }), { code: 'QUERY_TOO_COMPLEX' });
  assert.throws(() => validateList(definition, { sort: 'payload', 'filter[id][eq]': uuid }), { code: 'INVALID_SORT' });
});
test('membership JSON is unambiguous, bounded before deduplication and strictly scalar', () => {
  for (const values of [[''], ['ACME, Inc.', 'A&B', '雪', '"', '+', 'null'], Array(25).fill(uuid)]) {
    const field = values.length === 25 ? 'value_uuid' : 'value_text';
    assert.equal(validateList(definition, { [`filter[${field}][in]`]: JSON.stringify(values) }).filters[0]!.kind, 'membership');
  }
  for (const input of ['[]', '[1]', '[null]', '[{}]', '[[]]', '{}', 'null', 'a,b', '["x",]'])
    assert.throws(() => validateList(definition, { 'filter[value_text][in]': input }), { code: 'INVALID_FILTER' });
  assert.throws(() => validateList(definition, { 'filter[value_text][in]': JSON.stringify(Array(26).fill('same')) }), { code: 'QUERY_TOO_COMPLEX' });
});
test('strict scalar boundaries and exact parameter values', () => {
  const invalid: Record<string, string[]> = {
    integer: ['2147483648', '-2147483649', '1.0', '1e2', ' 1'], bigint: ['9223372036854775808', '-9223372036854775809', '1.2'],
    decimal: ['1234567890123456789.00', '1.001', '1e2', 'NaN'], boolean: ['TRUE', '1', '0', 'yes', 'no', 'null'],
    uuid: ['x', '00000000'], date: ['2025-02-29', '0000-01-01'], timestamp: ['2026-01-01T00:00:00', '2025-02-29T00:00:00Z'],
  };
  for (const [type, inputs] of Object.entries(invalid)) for (const value of inputs) assert.throws(() => validateList(definition, { [`filter[value_${type}][eq]`]: value }), { code: 'INVALID_FILTER' });
  for (const value of ['TRUE', '0', 'yes', '']) assert.throws(() => validateList(definition, { 'filter[value_text][is_null]': value }), { code: 'INVALID_FILTER' });
  for (const [type, value] of [['bigint', '9007199254740993'], ['decimal', '123456789012345678.90'], ['timestamp', '2026-01-01T00:00:00.123456Z']]) {
    const compiled = selectList(definition, validateList(definition, { [`filter[value_${type}][gte]`]: value! }));
    assert.equal(compiled.values[0], value);
  }
  const hostile = "x'); DROP TABLE products; --";
  const compiled = selectList(definition, validateList(definition, { 'filter[value_text][in]': JSON.stringify([hostile]) }));
  assert.ok(!compiled.text.includes(hostile)); assert.equal(compiled.values[0], hostile);
  const owner = { field: 'value_uuid', userId: uuid };
  const narrowed = selectList(definition, validateList(definition, { 'filter[value_uuid][neq]': uuid }), owner);
  assert.match(narrowed.text, /"value_uuid" <> \$1.* AND "value_uuid" = \$2/);
  assert.deepEqual(narrowed.values.slice(0, 2), [uuid, uuid]);
});

for (const [type, , supported] of cases) if (type !== 'jsonb') test(`all ${type} operators reject malformed scalars and nullable tests have explicit SQL`, () => {
  const invalid = { text: '\0', varchar: '\0', integer: '2147483648', bigint: '9223372036854775808', decimal: '1.001', date: '2025-02-29', timestamp: '2026-01-01T00:00:00', boolean: '1', uuid: 'not-a-uuid' }[type];
  for (const operator of supported) assert.throws(() => validateList(definition, { [`filter[value_${type}][${operator}]`]: operator === 'in' ? JSON.stringify([invalid]) : invalid }), { code: 'INVALID_FILTER' });
  for (const value of ['true','false']) {
    const query = selectList(definition,validateList(definition,{ [`filter[value_${type}][is_null]`]: value }));
    assert.match(query.text,value === 'true' ? /IS NULL/ : /IS NOT NULL/);
    assert.ok(!query.text.includes('= NULL')); assert.deepEqual(query.values,[26,0]);
  }
});
