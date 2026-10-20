import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyField, toField, toForm } from '../src/lib/schema-form';
const id = '11111111-1111-4111-8111-111111111111';
test('Reference form persists UUID metadata and round trips without defaults or uniqueness', () => {
  const form = {
    ...emptyField(),
    name: 'customer_id',
    type: 'reference' as const,
    targetTableId: id,
    nullable: false,
  };
  const field = toField(form);
  assert.equal(field.type, 'uuid');
  assert.deepEqual(field.relationship, { tableId: id, onDelete: 'restrict' });
  assert.equal(field.nullable, false);
  assert.deepEqual(toForm(field), form);
  assert.throws(() => toField({ ...form, targetTableId: '' }));
  assert.throws(() => toField({ ...form, unique: true }));
  assert.throws(() =>
    toField({ ...form, defaultKind: 'literal', defaultText: id }),
  );
});
test('ordinary ownership UUID remains separate from references', () => {
  const field = toField({
    ...emptyField(),
    name: 'owner_id',
    type: 'uuid',
    nullable: false,
  });
  assert.equal(field.relationship, undefined);
  assert.equal(toForm(field).type, 'uuid');
});

test('management adapter explicitly permits target checks and strips unrelated field secrets', async () => {
  const { managementDto, supported } = await import(
    '../src/lib/server/adapter'
  );
  const path = `projects/${id}/schema/reference-targets`;
  assert.equal(supported(path, 'GET'), true);
  assert.equal(supported(path, 'POST'), false);
  assert.deepEqual(
    managementDto(path, 'GET', {
      targets: [{ id, name: 'customers', secret: 'must-not-pass' }],
      unavailable: false,
      password: 'must-not-pass',
    }),
    { targets: [{ id, name: 'customers' }], unavailable: false },
  );
  const result = managementDto(`projects/${id}/schema/tables/${id}`, 'GET', {
    id,
    fields: [
      {
        name: 'customer_id',
        type: 'uuid',
        relationship: {
          tableId: id,
          onDelete: 'restrict',
          password: 'must-not-pass',
        },
      },
    ],
    appliedDefinition: null,
  });
  assert.ok(!JSON.stringify(result).includes('must-not-pass'));
});
