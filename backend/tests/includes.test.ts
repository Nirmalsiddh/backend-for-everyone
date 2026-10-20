import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInclude } from '../src/runtime/include.js';
import { authorizeRead } from '../src/runtime/authorization.js';
import { validateList } from '../src/runtime/validation.js';
import { selectList, selectByIds } from '../src/runtime/queries.js';
import { RuntimeService } from '../src/runtime/service.js';
import { createRuntimeExecutor } from '../src/database/customer-db/runtime-executor.js';
import { CredentialEncryption } from '../src/security/encryption.js';
import type { AppliedDefinition, Definition } from '../src/modules/schema-builder/types.js';
import type { RuntimePrincipal, RuntimeTarget } from '../src/runtime/types.js';
import type { OperationPolicy } from '../src/modules/endpoints/types.js';
import type { SchemaClient } from '../src/database/customer-db/schema-executor.js';
const config = { host: 'localhost', port: 5432, database: 'fixture', username: 'fixture', password: 'secret', schema: 'public', ssl: false };
const catalog = { relation: [{ relkind: 'r', relispartition: false }], columns: [], constraints: [], indexes: [], triggers: [] };
const uuid = '00000000-0000-4000-8000-000000000001';
const field = (name: string) => ({ id: name, name, position: 0, type: 'uuid' as const, options: {}, nullable: true, unique: false, default: null });
const definition: Definition = { schema: 'public', name: 'customers', fields: [field('owner_id')] };
const applied: AppliedDefinition = { definition, catalog };
const key: RuntimePrincipal = { projectId: 'project', keyId: 'key', scope: 'read' };
const user = (role: 'user' | 'admin'): RuntimePrincipal => ({ kind: 'user', projectId: 'project', userId: uuid, role, sessionId: 'session', tokenHash: 'hash', context: { connection: { id: 'connection' } } } as RuntimePrincipal);
test('strict include grammar rejects every malformed entry instead of dropping it', () => {
  assert.deepEqual(parseInclude({}), []);
  assert.deepEqual(parseInclude({ include: 'customer_id,warehouse_id' }), ['customer_id', 'warehouse_id']);
  for (const include of ['', ' ', '*', 'customer_id,', ',customer_id', 'customer_id,customer_id', 'a,b,c', 'a.b', 'a[b]', 'a, b', ['a', 'b']]) {
    assert.throws(() => parseInclude({ include }), { code: 'INVALID_INCLUDE', statusCode: 400 });
  }
  assert.throws(() => parseInclude({ 'include[]': 'customer_id' }), { code: 'INVALID_INCLUDE' });
});
test('independent read authorization matrix and SQL target owner predicate', () => {
  const policies: OperationPolicy[] = [{ mode: 'key_only' }, { mode: 'authenticated' }, { mode: 'owner', ownerFieldId: 'owner_id', allowAdmin: false }, { mode: 'owner', ownerFieldId: 'owner_id', allowAdmin: true }];
  for (const principal of [key, { ...key, scope: 'read_write' as const }, user('user'), user('admin')]) {
    for (const policy of policies) {
      const result = authorizeRead(definition, policy, principal);
      assert.equal(result.compatible, (policy.mode === 'key_only') === ('keyId' in principal));
      if (result.compatible && policy.mode === 'owner') {
        const bypass = 'role' in principal && principal.role === 'admin' && policy.allowAdmin;
        assert.equal(!!result.ownership, !bypass);
        const query = selectByIds(definition, [uuid], result.ownership);
        assert.match(query.text, /ANY\(\$1::pg_catalog.uuid\[\]\)/);
        assert.equal(query.text.includes('"owner_id" = $2'), !bypass);
        assert.ok(!query.text.includes(uuid));
      }
    }
  }
});
test('configuration compatibility checked before executor, including empty and null data', async () => {
  const target: RuntimeTarget = { endpointId: 'parent', projectId: 'project', enabledOperations: ['get', 'list'], applied: { ...applied, definition: { ...definition, fields: [{ ...field('customer_id'), relationship: { tableId: 'customer', onDelete: 'restrict' } }] } }, connection: { id: 'connection' } as RuntimeTarget['connection'], blocked: false };
  const related: RuntimeTarget = { ...target, endpointId: 'target', applied, enabledOperations: [] };
  target.relatedTargets = { customer: related };
  let executions = 0;
  const service = new RuntimeService({ authenticate: async () => key, resolve: async () => target }, {} as CredentialEncryption, async () => { executions++; return []; });
  for (const operation of ['get', 'list'] as const) {
    await assert.rejects(service.execute(key, 'orders', operation, uuid, undefined, { include: 'customer_id' }), { code: 'INCLUDE_UNAVAILABLE' });
    related.enabledOperations = ['get']; related.policies = { get: { mode: 'authenticated' } };
    await assert.rejects(service.execute(key, 'orders', operation, uuid, undefined, { include: 'customer_id' }), { code: 'INCLUDE_UNAVAILABLE' });
    related.enabledOperations = [];
  }
  assert.equal(executions, 0);
  await assert.rejects(service.execute(key, 'orders', 'get', uuid, undefined, { include: 'owner_id' }), { code: 'INVALID_INCLUDE' });
  for (const op of ['create', 'update', 'delete'] as const) await assert.rejects(service.execute(key, 'orders', op, uuid, undefined, { include: 'customer_id' }), { code: 'INVALID_INCLUDE' });
});
for (const size of [1, 25, 100]) for (const count of [0, 1, 2]) test(`batch bounds: page=${size}, includes=${count}`, async () => {
  const dataQueries: { text: string; values?: unknown[] }[] = [];
  const rows = Array.from({ length: size + 1 }, (_, index) => ({ id: String(index), billing_customer_id: index === size ? 'lookahead' : uuid, shipping_customer_id: null }));
  let ended = false; let fenced = false;
  const client: SchemaClient = { connect: async () => {}, end: async () => { ended = true; }, on() {}, query: async (text, values) => {
    if (text === 'SELECT parent') { dataQueries.push({ text }); return { rows }; }
    if (text.includes('ANY($1')) { dataQueries.push({ text, ...(values ? { values } : {}) }); return { rows: [{ id: uuid, owner_id: uuid, private_extra: 'not projected' }] }; }
    return { rows: text.includes('SELECT c.relkind') ? catalog.relation : [] };
  } };
  const query = selectList(definition, validateList(definition, { 'filter[owner_id][in]': JSON.stringify([uuid]), 'filter[id][neq]': uuid, limit: String(size) }));
  const compiledClient = { ...client, query: (text: string, values?: unknown[]) => client.query(text === query.text ? 'SELECT parent' : text, values) };
  const result = await createRuntimeExecutor(() => compiledClient)(config, applied, query, undefined, count ? {
    includes: ['billing_customer_id', 'shipping_customer_id'].slice(0, count).map((name) => ({ name, applied })), limit: size,
    fence: async () => { fenced = true; },
  } : undefined);
  assert.equal(dataQueries.length, count + 1);
  if (count) {
    assert.deepEqual(dataQueries[1]!.values, [[uuid]]);
    assert.deepEqual(result[0]!._related, { billing_customer_id: { id: uuid, owner_id: uuid }, ...(count === 2 ? { shipping_customer_id: null } : {}) });
    assert.equal(fenced, true);
  } else assert.equal(result[0]!._related, undefined);
  assert.equal(ended, true);
});
test('expanded commit failure is a sanitized read failure and releases connection', async () => {
  const client: SchemaClient = { connect: async () => {}, end: async () => {}, on() {}, query: async (text) => {
    if (text === 'COMMIT') throw new Error('secret');
    return { rows: text.includes('SELECT c.relkind') ? catalog.relation : [] };
  } };
  await assert.rejects(createRuntimeExecutor(() => client)(config, applied, { text: 'SELECT parent', values: [] }, undefined, { includes: [], fence: async () => {} }), { code: 'RUNTIME_UNAVAILABLE' });
});
test('hidden and missing related rows have identical null output, preserving raw FK', async () => {
  async function read(reference: string) {
    const client: SchemaClient = { connect: async () => {}, end: async () => {}, on() {}, query: async (text) => ({ rows: text.includes('SELECT c.relkind') ? catalog.relation : text === 'SELECT parent' ? [{ id: 'parent', customer_id: reference }] : [] }) };
    const rows = await createRuntimeExecutor(() => client)(config, applied, { text: 'SELECT parent', values: [] }, undefined, { includes: [{ name: 'customer_id', applied, ownership: { field: 'owner_id', userId: uuid } }], fence: async () => {} });
    assert.equal(rows[0]!.customer_id, reference);
    return rows[0]!._related;
  }
  assert.deepEqual(await read(uuid), await read('00000000-0000-4000-8000-000000000002'));
  assert.deepEqual(await read(uuid), { customer_id: null });
});
test('complete response counts repeated nested target copies and releases capacity', async () => {
  let ended = 0;
  const client: SchemaClient = { connect: async () => {}, end: async () => { ended++; }, on() {}, query: async (text) => ({ rows: text.includes('SELECT c.relkind') ? catalog.relation : text === 'SELECT parent' ? Array.from({ length: 100 }, () => ({ id: 'parent', customer_id: uuid })) : text.includes('ANY($1') ? [{ id: uuid, owner_id: 'x'.repeat(20000) }] : [] }) };
  const executor = createRuntimeExecutor(() => client, 1);
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(executor(config, applied, { text: 'SELECT parent', values: [] }, undefined, { includes: [{ name: 'customer_id', applied }], limit: 100, fence: async () => { assert.fail('oversized response must fail before fence'); } }), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(ended, 2);
});
test('metadata fence failure discards expanded records and rolls back', async () => {
  const calls: string[] = [];
  const client: SchemaClient = { connect: async () => {}, end: async () => {}, on() {}, query: async (text) => { calls.push(text); return { rows: text.includes('SELECT c.relkind') ? catalog.relation : [] }; } };
  const { metadataChanged } = await import('../src/runtime/include.js');
  await assert.rejects(createRuntimeExecutor(() => client)(config, applied, { text: 'SELECT parent', values: [] }, undefined, { includes: [{ name: 'customer_id', applied }], fence: async () => { throw metadataChanged(); } }), { code: 'RUNTIME_METADATA_CHANGED' });
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.includes('COMMIT'));
  assert.ok(calls.includes('BEGIN ISOLATION LEVEL REPEATABLE READ'));
});
test('platform metadata fence outage returns sanitized metadata change instead of data', async () => {
  const encryption = new CredentialEncryption('11'.repeat(32));
  const connection = { id: 'connection', projectId: 'project', ...encryption.encrypt(config, 'project:connection') } as RuntimeTarget['connection'];
  const target: RuntimeTarget = { endpointId: 'parent', projectId: 'project', fingerprint: 'admitted', enabledOperations: ['get'], connection, blocked: false,
    applied: { ...applied, definition: { ...definition, fields: [{ ...field('customer_id'), relationship: { tableId: 'customer', onDelete: 'restrict' } }] } },
    relatedTargets: { customer: { endpointId: 'target', projectId: 'project', enabledOperations: ['get'], connection, blocked: false, applied } },
  };
  let reads = 0;
  const service = new RuntimeService({ authenticate: async () => key, resolve: async () => {
    if (reads++) throw new Error('private platform connection detail'); return target;
  } }, encryption, async (_config, _applied, _query, _guard, expansion) => { await expansion!.fence(); return [{ id: uuid }]; });
  await assert.rejects(service.execute(key, 'orders', 'get', uuid, undefined, { include: 'customer_id' }), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'RUNTIME_METADATA_CHANGED'); assert.ok(!error.message.includes('private')); return true;
  });
});
test('expanded final fence is bounded by customer operation deadline', async () => {
  const { createTransactionRunner } = await import('../src/database/customer-db/transaction-runner.js');
  let ended = false;
  const client: SchemaClient = { connect: async () => {}, end: async () => { ended = true; }, on() {}, query: async () => ({ rows: [] }) };
  const runner = createTransactionRunner(() => client, 1);
  await assert.rejects(runner(config, async () => new Promise(() => {}), 30, { expandedRead: true }), { code: 'QUERY_TIMEOUT' });
  assert.equal(ended, true);
});
test('include is rejected when no generated read operation exists', async () => {
  const service = new RuntimeService({ authenticate: async () => key, resolve: async () => undefined }, {} as CredentialEncryption, async () => assert.fail('must not execute'));
  await assert.rejects(service.execute(key, 'workflow', 'get', undefined, undefined, { include: 'customer_id' }), { code: 'INVALID_INCLUDE' });
  await assert.rejects(service.execute(key, 'workflow', 'get', undefined, undefined, {}), { code: 'NOT_FOUND' });
});
