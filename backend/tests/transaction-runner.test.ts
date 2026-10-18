import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTransactionRunner, TransactionAbort } from '../src/database/customer-db/transaction-runner.js';
import type { SchemaClient } from '../src/database/customer-db/schema-executor.js';
const config = { host: 'localhost', port: 5432, database: 'test', username: 'test', password: 'private', schema: 'public', ssl: false };
test('business response rolls back before return while successful work commits before return', async () => {
  const calls: string[] = []; const client: SchemaClient = { async connect() {}, on() {}, async end() { calls.push('END'); }, async query(text) { calls.push(text); return { rows: [] }; } };
  const runner = createTransactionRunner(() => client);
  const result = await runner<{ status: number }>(config, async (tx) => { await tx.query('INSERT fixture'); throw new TransactionAbort({ status: 409 }); });
  assert.equal(result.status, 409); assert.ok(calls.indexOf('ROLLBACK') < calls.indexOf('END')); assert.ok(!calls.includes('COMMIT'));
  calls.length = 0; assert.equal(await runner(config, async () => 7), 7); assert.ok(calls.indexOf('COMMIT') < calls.indexOf('END'));
});
test('a deadline closes the active client and releases capacity rather than leaving work running', async () => {
  let rejectQuery: (error: Error) => void = () => {}; let closed = 0;
  const client: SchemaClient = { async connect() {}, on() {}, async end() { closed++; rejectQuery(new Error('Connection terminated')); },
    async query(text) { if (text === 'BLOCK') return new Promise((_resolve, reject) => { rejectQuery = reject; }); return { rows: [] }; } };
  const runner = createTransactionRunner(() => client, 1);
  await assert.rejects(runner(config, (tx) => tx.query('BLOCK'), 30), { statusCode: 504 }); assert.equal(closed, 1);
  await assert.doesNotReject(runner(config, async () => 1));
});
