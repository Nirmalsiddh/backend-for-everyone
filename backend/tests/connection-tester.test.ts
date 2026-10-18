import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectionTester, type TestClient } from '../src/database/customer-db/connection-test.js';

const config = { host: 'localhost', port: 5432, database: 'customer', username: 'customer',
  password: 'secret-password', schema: "custom'; DROP SCHEMA public;--", ssl: true };

test('connection diagnostic runs fixed queries with a schema parameter and closes client', async () => {
  let closed = false;
  const calls: { text: string; values: string[] | undefined }[] = [];
  const tester = createConnectionTester((options) => {
    assert.deepEqual(options.ssl, { rejectUnauthorized: true });
    assert.equal(options.password, config.password);
    assert.equal(options.connectionTimeoutMillis, 5000);
    return {
      async connect() {}, on() {}, async end() { closed = true; },
      async query(text, values) { calls.push({ text, values }); return { rows: [{ ok: 1 }] }; },
    };
  });
  await tester(config);
  assert.equal(closed, true);
  assert.equal(calls[0]?.text, 'SELECT 1');
  assert.deepEqual(calls[1]?.values, [config.schema]);
  assert.ok(!calls[1]?.text.includes(config.schema));
});

test('diagnostic sanitizes failures and closes clients on every failure path', async () => {
  for (const [error, expected] of [
    [Object.assign(new Error('password=secret-password'), { code: '28P01' }), 'AUTHENTICATION_FAILED'],
    [Object.assign(new Error('raw timeout secret-password'), { code: 'ETIMEDOUT' }), 'CONNECTION_TIMEOUT'],
    [new Error('Connection terminated due to connection timeout'), 'CONNECTION_TIMEOUT'],
    [Object.assign(new Error('raw database details'), { code: 'ECONNREFUSED' }), 'CONNECTION_FAILED'],
  ] as const) {
    let closed = false;
    const client: TestClient = {
      on() {}, async connect() { throw error; }, async query() { return { rows: [] }; },
      async end() { closed = true; },
    };
    await assert.rejects(createConnectionTester(() => client)(config), (failure: unknown) => {
      assert.ok(failure instanceof Error);
      assert.equal((failure as Error & { code: string }).code, expected);
      assert.ok(!failure.message.includes(config.password));
      return true;
    });
    assert.equal(closed, true);
  }
  let closed = false;
  const missing: TestClient = {
    on() {}, async connect() {}, async query() { return { rows: [] }; }, async end() { closed = true; },
  };
  await assert.rejects(createConnectionTester(() => missing)(config), { code: 'SCHEMA_UNAVAILABLE' });
  assert.equal(closed, true);
});
