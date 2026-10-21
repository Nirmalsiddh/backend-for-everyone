import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyField, toField, toForm, validateEvolutionStrategies, applyConfirmation } from '../src/lib/schema-form';
test('fill/default form reload preserves exact and falsy values independently', () => {
  for (const [type, text, value] of [['text', '', ''], ['boolean', 'false', false], ['integer', '0', 0], ['bigint', '9007199254740993', '9007199254740993'], ['decimal', '9007199254740993.123456', '9007199254740993.123456']] as const) {
    const form = { ...emptyField(), name: 'status', type, precision: '38', scale: '6', nullable: false, defaultKind: 'literal' as const, defaultText: text, fillEnabled: true, fillText: text };
    const field = toField(form);
    assert.deepEqual(field.backfillIntent, { kind: 'literal', value });
    const restored = toForm(field);
    assert.equal(restored.fillEnabled, true); assert.equal(restored.fillText, text);
    assert.deepEqual(toField(restored), field);
    const removed = toField({ ...restored, defaultKind: 'none' });
    assert.equal(removed.default, undefined); assert.deepEqual(removed.backfillIntent, field.backfillIntent);
  }
});
test('nullable and JSONB fills are rejected', () => {
  assert.throws(() => toField({ ...emptyField(), name: 'status', fillEnabled: true }));
  assert.throws(() => toField({ ...emptyField(), name: 'status', type: 'jsonb', nullable: false, fillEnabled: true }));
});

test('required additions need an explicit strategy; exact decimal and varchar bounds are enforced', () => {
  const field = { name: 'added', type: 'text' as const, nullable: false };
  assert.throws(() => validateEvolutionStrategies([field], []));
  validateEvolutionStrategies([{ ...field, default: { kind: 'literal', value: '' } }], []);
  validateEvolutionStrategies([{ ...field, backfillIntent: { kind: 'literal', value: '' } }], []);
  assert.throws(() => toField({ ...emptyField(), name: 'added', type: 'decimal', precision: '3', scale: '2', defaultKind: 'literal', defaultText: '12.34' }));
  assert.throws(() => toField({ ...emptyField(), name: 'added', type: 'varchar', length: '1', defaultKind: 'literal', defaultText: 'ab' }));
});

test('v4 confirmation states actual fill/default/required effects without legacy no-fill wording', () => {
  const message = applyConfirmation({ version: 4, actions: [
    { kind: 'fill_nulls', description: 'Existing NULL values in status will be replaced.' },
    { kind: 'set_default', description: 'Future inserts that omit status will use the configured default.' },
    { kind: 'set_not_null', description: 'status will become required.' },
  ] });
  assert.match(message, /Existing NULL values/); assert.match(message, /Future inserts/); assert.match(message, /will become required/);
  assert.ok(!message.includes('must already have a value'));
  assert.match(applyConfirmation({ actions: [{ kind: 'set_not_null' }] }), /must already have a value/);
});
