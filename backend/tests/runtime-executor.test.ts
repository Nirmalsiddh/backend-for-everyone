import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntimeExecutor } from '../src/database/customer-db/runtime-executor.js';
import type { SchemaClient } from '../src/database/customer-db/schema-executor.js';
import type { AppliedDefinition } from '../src/modules/schema-builder/types.js';
const config = { host: 'localhost', port: 5432, database: 'fixture', username: 'fixture', password: 'private-password', schema: 'public', ssl: false };
const snapshot = { relation: [{ relkind: 'r', relispartition: false }], columns: [], constraints: [], indexes: [], triggers: [] };
const applied: AppliedDefinition = { definition: { schema: 'public', name: 'products', fields: [] }, catalog: snapshot };
function fixture(failure: string, code = '57014') {
  const calls: string[] = []; let ended = false;
  const client: SchemaClient = { async connect() {}, on() {}, async end() { ended = true; }, async query(sql) {
    calls.push(sql);
    if (sql === failure) throw Object.assign(new Error('private-password SQL driver detail'), { code });
    return { rows: sql.includes('SELECT c.relkind') ? snapshot.relation : sql === 'SELECT rows' ? [{ id: 'fixture' }] : [] };
  } };
  return { client, calls, ended: () => ended };
}
test('runtime timeout rolls back, sanitizes errors, closes client, and releases capacity', async () => {
  const fake = fixture('SELECT rows'); const executor = createRuntimeExecutor(() => fake.client, 1);
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(executor(config, applied, { text: 'SELECT rows', values: [] }), (error: Error & { statusCode?: number }) => {
    assert.equal(error.statusCode, 504); assert.ok(!error.message.includes('private-password')); return true;
  });
  assert.ok(fake.calls.includes('ROLLBACK')); assert.ok(fake.ended());
});
test('drift blocks customer CRUD and clients close on connection failures', async () => {
  const fake = fixture('never');
  await assert.rejects(createRuntimeExecutor(() => fake.client)(config, { ...applied, catalog: {} }, { text: 'SELECT rows', values: [] }), { statusCode: 503 });
  assert.ok(!fake.calls.includes('SELECT rows')); assert.ok(fake.ended());
  fake.client.connect = async () => { throw new Error('password'); };
  await assert.rejects(createRuntimeExecutor(() => fake.client)(config, applied, { text: 'SELECT rows', values: [] }), { statusCode: 503 });
  assert.ok(fake.ended());
});
test('capacity is bounded without opening additional customer clients', async () => {
  const fake = fixture('never'); let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  fake.client.connect = () => barrier;
  let created = 0;
  const executor = createRuntimeExecutor(() => { created++; return fake.client; }, 1);
  const first = executor(config, applied, { text: 'SELECT rows', values: [] });
  await assert.rejects(executor(config, applied, { text: 'SELECT rows', values: [] }), { code: 'RUNTIME_CAPACITY_EXHAUSTED' });
  assert.equal(created, 1); release(); await first; assert.ok(fake.ended());
});
test('a lost commit response is not retried or reported as rollback', async () => {
  const fake = fixture('COMMIT', 'ECONNRESET');
  await assert.rejects(createRuntimeExecutor(() => fake.client)(config, applied, { text: 'SELECT rows', values: [] }), { code: 'WRITE_OUTCOME_UNKNOWN' });
  assert.ok(!fake.calls.includes('ROLLBACK')); assert.ok(fake.ended());
});
