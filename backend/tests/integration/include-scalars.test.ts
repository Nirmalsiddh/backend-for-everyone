import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { catalog } from '../../src/database/customer-db/catalog.js';
import { createRuntimeExecutor } from '../../src/database/customer-db/runtime-executor.js';
import { quoteIdentifier as q } from '../../src/modules/schema-builder/plan.js';
import { normalizeDraft } from '../../src/modules/schema-builder/validation.js';
import { selectById, selectList } from '../../src/runtime/queries.js';
import type { AppliedDefinition } from '../../src/modules/schema-builder/types.js';
test('expanded scalar projection uses the ordinary serializer and complete byte limit on PostgreSQL', async (t) => {
  const url = new URL(process.env.TEST_CUSTOMER_DATABASE_URL!);
  const schema = 'inc_' + randomUUID().replaceAll('-', '');
  const customer = new pg.Client({ connectionString: url.toString() }); await customer.connect();
  t.after(async () => { await customer.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`); await customer.end(); });
  await customer.query(`CREATE SCHEMA ${q(schema)}`);
  await customer.query(`CREATE TABLE ${q(schema)}.targets (id uuid PRIMARY KEY, amount numeric(20,2), counter bigint, created_at timestamptz, payload jsonb, label text)`);
  await customer.query(`CREATE TABLE ${q(schema)}.parents (id uuid PRIMARY KEY, target_id uuid)`);
  const definition = { schema, ...normalizeDraft({ name: 'targets', fields: [
    { name: 'amount', type: 'decimal', options: { precision: 20, scale: 2 } },
    { name: 'counter', type: 'bigint' }, { name: 'created_at', type: 'timestamp' },
    { name: 'payload', type: 'jsonb' }, { name: 'label', type: 'text' },
  ] }) };
  const parentDefinition = { schema, ...normalizeDraft({ name: 'parents', fields: [{ name: 'target_id', type: 'uuid' }] }) };
  const applied: AppliedDefinition = { definition: parentDefinition, catalog: await catalog(customer, schema, 'parents') };
  const target: AppliedDefinition = { definition, catalog: await catalog(customer, schema, 'targets') };
  const targetId = randomUUID(), parentId = randomUUID();
  await customer.query(`INSERT INTO ${q(schema)}.targets VALUES ($1,$2,$3,$4,$5,$6)`, [targetId, '123456789012345678.90', '9223372036854775807', '2026-01-01T00:00:00.123Z', { nested: [true, null, 'x'] }, 'Example']);
  await customer.query(`INSERT INTO ${q(schema)}.parents VALUES ($1,$2)`, [parentId, targetId]);
  const config = { host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema, ssl: false };
  const execute = createRuntimeExecutor();
  const expansion = { includes: [{ name: 'target_id', applied: target }], fence: async () => {} };
  const rows = await execute(config, applied, selectById(parentDefinition, parentId), undefined, expansion);
  assert.deepEqual(rows[0]!._related, { target_id: { id: targetId, amount: '123456789012345678.90', counter: '9223372036854775807', created_at: '2026-01-01T00:00:00.123Z', payload: { nested: [true, null, 'x'] }, label: 'Example' } });
  await customer.query(`UPDATE ${q(schema)}.targets SET label=$1 WHERE id=$2`, ['x'.repeat(15000), targetId]);
  await customer.query(`INSERT INTO ${q(schema)}.parents SELECT gen_random_uuid(),$1::uuid FROM generate_series(1,100)`, [targetId]);
  await assert.rejects(execute(config, applied, selectList(parentDefinition, { limit: 100, offset: 0, sort: 'id', direction: 'ASC', filters: [] }), undefined, { ...expansion, limit: 100 }), { code: 'RESPONSE_TOO_LARGE' });
  const again = await execute(config, applied, selectById(parentDefinition, parentId), undefined, expansion);
  assert.equal((again[0]!._related as { target_id: { id: string } }).target_id.id, targetId);
});
