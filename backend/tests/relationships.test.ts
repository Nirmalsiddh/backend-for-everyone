import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { generatePlan } from '../src/modules/schema-builder/plan.js';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import { validatePolicies } from '../src/runtime/authorization.js';
import type {
  FieldInput,
  TableRecord,
} from '../src/modules/schema-builder/types.js';
function table(name: string, fields: FieldInput[] = []): TableRecord {
  return {
    id: randomUUID(),
    projectId: 'project',
    connectionId: 'connection',
    schemaName: 'public',
    ...normalizeDraft({ name, fields }),
    draftRevision: 1,
    appliedRevision: null,
    appliedDefinition: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
function apply(t: TableRecord) {
  t.appliedRevision = t.draftRevision;
  t.appliedDefinition = {
    definition: { schema: t.schemaName, name: t.name, fields: t.fields },
    catalog: { existing: true },
  };
  return t;
}
const ref = (id: string): FieldInput => ({
  name: 'customer_id',
  type: 'uuid',
  nullable: false,
  relationship: { tableId: id, onDelete: 'restrict' },
});
test('reference validation is narrow and ordinary UUIDs retain historical shape', () => {
  const ordinary = normalizeDraft({
    name: 'tasks',
    fields: [{ name: 'owner_id', type: 'uuid' }],
  });
  assert.equal(Object.hasOwn(ordinary.fields[0]!, 'relationship'), false);
  for (const change of [
    { type: 'text' },
    { unique: true },
    { default: { kind: 'literal', value: randomUUID() } },
    { relationship: { tableId: randomUUID(), onDelete: 'cascade' } },
    { relationship: null },
  ]) {
    assert.throws(() =>
      normalizeDraft({
        name: 'orders',
        fields: [{ ...ref(randomUUID()), ...change } as FieldInput],
      }),
    );
  }
});
test('plans bind applied target revisions and deterministic FK/index DDL', () => {
  const parent = apply(table('customers'));
  const child = table('orders', [ref(parent.id)]);
  const plan = generatePlan(child, [parent]);
  assert.equal(plan.version, 2);
  assert.match(
    plan.statements.join('\n'),
    /ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE/,
  );
  assert.match(plan.statements.join('\n'), /CREATE INDEX "ix_fk_[a-f0-9]{32}"/);
  assert.match(plan.statements[0]!, /"customer_id" pg_catalog.uuid NOT NULL/);
  const hash = plan.hash;
  parent.draftRevision++; // Unapplied draft is irrelevant.
  assert.equal(generatePlan(child, [parent]).hash, hash);
  parent.appliedRevision!++;
  assert.notEqual(generatePlan(child, [parent]).hash, hash);
  assert.equal(generatePlan(child, [], plan.dependencies).hash, hash);
});
test('unavailable, draft-only, wrong-project/connection, internal, self and cyclic targets reject', () => {
  const parent = apply(table('customers'));
  const child = table('orders', [ref(parent.id)]);
  for (const targets of [
    [],
    [table('draft')],
    [{ ...parent, appliedDefinition: null }],
    [{ ...parent, projectId: 'other' }],
    [{ ...parent, connectionId: 'other' }],
    [
      {
        ...parent,
        applyStatus: {
          status: 'outcome_unknown' as const,
          migrationId: randomUUID(),
          errorCode: null,
          completedAt: null,
        },
      },
    ],
  ])
    assert.throws(() => generatePlan(child, targets));
  const self = table('categories');
  self.fields = normalizeDraft({
    name: self.name,
    fields: [ref(self.id)],
  }).fields;
  assert.throws(() => generatePlan(self, [self]));
  apply(child);
  const cycle = {
    ...parent,
    fields: normalizeDraft({
      name: parent.name,
      fields: [{ ...ref(child.id), nullable: true }],
    }).fields,
    draftRevision: 2,
  };
  assert.throws(
    () => generatePlan(cycle, [parent, child]),
    /circular table dependency/,
  );
});
test('nullable additions work; applied relationships cannot be retargeted or used for ownership', () => {
  const parent = apply(table('customers'));
  const child = apply(table('orders'));
  const addition = normalizeDraft({
    name: 'orders',
    fields: [{ ...ref(parent.id), nullable: true }],
  });
  const candidate = { ...child, fields: addition.fields, draftRevision: 2 };
  const plan = generatePlan(candidate, [parent, child]);
  assert.equal(plan.operation, 'add_columns');
  assert.match(plan.statements[0]!, /ADD COLUMN/);
  assert.throws(() =>
    generatePlan(
      { ...candidate, fields: [{ ...candidate.fields[0]!, nullable: false }] },
      [parent, child],
    ),
  );
  apply(candidate);
  assert.throws(() =>
    generatePlan(
      {
        ...candidate,
        fields: [
          {
            ...candidate.fields[0]!,
            relationship: { tableId: randomUUID(), onDelete: 'restrict' },
          },
        ],
      },
      [parent],
    ),
  );
  assert.throws(() =>
    validatePolicies(
      {
        create: {
          mode: 'owner',
          ownerFieldId: candidate.fields[0]!.id,
          allowAdmin: false,
        },
      },
      candidate.appliedDefinition!.definition,
    ),
  );
});
