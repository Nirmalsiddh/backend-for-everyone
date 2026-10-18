import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSchemaExecutor, type SchemaClient } from '../src/database/customer-db/schema-executor.js';
import { generatePlan } from '../src/modules/schema-builder/plan.js';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import type { Plan } from '../src/modules/schema-builder/types.js';

const config = { host: 'localhost', port: 5432, database: 'test', username: 'test', password: 'secret', schema: 'public', ssl: false };
const plan: Plan = generatePlan({ id: '11111111-1111-4111-8111-111111111111', projectId: 'p', connectionId: 'c', schemaName: 'public',
  ...normalizeDraft({ name: 'products', fields: [] }), draftRevision: 1, appliedRevision: null, appliedDefinition: null, createdAt: new Date(), updatedAt: new Date() });
function client(fail: string) {
  const calls: string[] = [];
  let closed = false;
  const value: SchemaClient = {
    async connect() {}, on() {}, async end() { closed = true; },
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith(fail)) throw Object.assign(new Error('sensitive driver error secret'), { code: '42501' });
      return { rows: sql.includes('SELECT c.relkind') ? [{ relkind: 'r', relispartition: false }] : [] };
    },
  };
  return { value, calls, closed: () => closed };
}
test('executor rolls back statement failure, sanitizes errors, and closes client', async () => {
  const fake = client('CREATE TABLE');
  await assert.rejects(createSchemaExecutor(() => fake.value)(config, plan, null), (error: Error) => {
    assert.ok(!error.message.includes('secret')); return true;
  });
  assert.ok(fake.calls.includes('ROLLBACK'));
  assert.ok(!fake.calls.includes('COMMIT'));
  assert.ok(fake.closed());
});
test('a lost commit response is uncertain and is never reported as rollback', async () => {
  const fake = client('COMMIT');
  await assert.rejects(createSchemaExecutor(() => fake.value)(config, plan, null), { code: 'SCHEMA_OUTCOME_UNKNOWN' });
  assert.ok(!fake.calls.includes('ROLLBACK'));
  assert.ok(fake.closed());
});
test('executor detects drift before issuing ALTER statements', async () => {
  const fake = client('NEVER');
  await assert.rejects(createSchemaExecutor(() => fake.value)(config, plan, { definition: plan.definition, catalog: { changed: true } }), { code: 'SCHEMA_CONFLICT' });
  assert.ok(!fake.calls.some((sql) => sql.startsWith('CREATE TABLE')));
  assert.ok(fake.calls.includes('ROLLBACK'));
});
