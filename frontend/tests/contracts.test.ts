import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toField, emptyField, toForm } from '../src/lib/schema-form';
import { references, counts } from '../src/lib/workflow';
import type { Definition, Step } from '../src/lib/contracts';
test('schema form preserves exact decimals and bigint and omits unset defaults', () => {
  assert.equal(
    toField({
      ...emptyField(),
      name: 'amount',
      type: 'decimal',
      defaultKind: 'literal',
      defaultText: '12345678901234567890.12',
    }).default?.kind,
    'literal',
  );
  const value = toField({
    ...emptyField(),
    name: 'amount',
    type: 'bigint',
    defaultKind: 'literal',
    defaultText: '9223372036854775807',
  });
  assert.deepEqual(value.default, {
    kind: 'literal',
    value: '9223372036854775807',
  });
  assert.throws(() =>
    toField({
      ...emptyField(),
      name: 'amount',
      type: 'bigint',
      defaultKind: 'literal',
      defaultText: '9223372036854775808',
    }),
  );
  assert.ok(
    !Object.hasOwn(toField({ ...emptyField(), name: 'title' }), 'default'),
  );
  assert.equal(
    toForm({ id: 'kept', name: 'title', type: 'text', default: null }).id,
    'kept',
  );
  assert.throws(() =>
    toField({
      ...emptyField(),
      name: 'created',
      type: 'timestamp',
      defaultKind: 'literal',
      defaultText: '2026-01-01T12:00:00',
    }),
  );
});
test('references contain only declared inputs, authenticated identity and selected prior outputs', () => {
  const def: Definition = {
    input: { order_id: { type: 'uuid' } },
    auth: 'key_only',
    steps: [],
  };
  const prior: Step = {
    id: 'prior',
    name: 'prior',
    type: 'query',
    tableId: 'table',
    access: { mode: 'key_only' },
    select: ['id'],
    idValue: { kind: 'literal', value: '' },
    onMissing: '404',
  };
  const refs = references(def, [prior], []);
  assert.deepEqual(
    refs.map((r) => r.label),
    ['Request: order_id', 'prior: row', 'prior: id'],
  );
  assert.equal(references({ ...def, auth: 'authenticated' }, [], []).length, 3);
  assert.equal(counts([prior]).db, 1);
});

test('workflow reference choices stop at terminal paths and exclude branch-local outputs', () => {
  const def: Definition = { input: {}, auth: 'key_only', steps: [] };
  const prior: Step = {
    id: 'prior',
    name: 'prior',
    type: 'query',
    tableId: 'table',
    access: { mode: 'key_only' },
    select: ['id'],
    idValue: { kind: 'literal', value: '' },
    onMissing: '404',
  };
  const response: Step = {
    id: 'response',
    name: 'respond',
    type: 'response',
    status: 204,
  };
  const condition: Step = {
    id: 'condition',
    name: 'branch',
    type: 'condition',
    operator: 'equals',
    left: { kind: 'literal', value: 1 },
    right: { kind: 'literal', value: 1 },
    then: [prior, response],
    else: [response],
  };
  assert.equal(references(def, [condition, prior], []).length, 0);
  assert.equal(references(def, [response, prior], []).length, 0);
  assert.equal(references(def, [{ ...condition, else: [] }], []).length, 0);
});

test('all schema defaults round-trip without changing their type or absence', () => {
  const cases: import('../src/lib/contracts').Field[] = [
    ...['hello', '123', 123, true, false, null, { a: 'value' }, ['x']].map(
      (value) => ({
        name: 'payload',
        type: 'jsonb' as const,
        default: { kind: 'literal' as const, value },
      }),
    ),
    { name: 'title', type: 'text', default: { kind: 'literal', value: '' } },
    {
      name: 'count',
      type: 'bigint',
      default: { kind: 'literal', value: '9223372036854775807' },
    },
    {
      name: 'price',
      type: 'decimal',
      options: { precision: 12, scale: 2 },
      default: { kind: 'literal', value: '123.40' },
    },
    {
      name: 'day',
      type: 'date',
      default: { kind: 'literal', value: '2026-10-18' },
    },
    {
      name: 'time',
      type: 'timestamp',
      default: { kind: 'literal', value: '2026-10-18T12:00:00+05:30' },
    },
    { name: 'time', type: 'timestamp', default: { kind: 'current_timestamp' } },
    { name: 'optional', type: 'jsonb' },
  ];
  for (const field of cases)
    assert.deepEqual(toField(toForm(field)).default, field.default);
  assert.notDeepEqual(
    toField(toForm(cases[5]!)).default,
    toField(toForm(cases.at(-1)!)).default,
  );
});
