import { memoryPlatformAuthRepository } from '../platform-auth-helpers.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../../src/app.js';
import { parseDatabaseUrl } from '../../src/config/env.js';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { apiKeys, databaseConnections, endpoints, projects, schemaMigrations, schemaTables, users } from '../../src/database/platform-db/schema.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { PostgresEndpointRepository } from '../../src/modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { PostgresRuntimeRepository } from '../../src/runtime/repository.js';
import { hashKey } from '../../src/modules/api-keys/service.js';
import { quoteIdentifier } from '../../src/modules/schema-builder/plan.js';
import { createRuntimeExecutor } from '../../src/database/customer-db/runtime-executor.js';
import { CredentialEncryption } from '../../src/security/encryption.js';
import type { FieldDefinition } from '../../src/modules/schema-builder/types.js';
import { auth, env } from '../helpers.js';

const toInput = ({ position: _position, default: def, ...field }: FieldDefinition) => ({ ...field, ...(def ? { default: def } : {}) });
test('predefined runtime real PostgreSQL core product flow', async (t) => {
  const platformUrl = parseDatabaseUrl(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
  const customerUrl = new URL(parseDatabaseUrl(process.env.TEST_CUSTOMER_DATABASE_URL, 'TEST_CUSTOMER_DATABASE_URL'));
  if (platformUrl === process.env.PLATFORM_DATABASE_URL || new URL(platformUrl).toString() === customerUrl.toString()) throw new Error('Use separate disposable databases');
  const { db, pool } = createPlatformDatabase(platformUrl);
  const customer = new pg.Client({ connectionString: customerUrl.toString() }); await customer.connect();
  const ownerId = randomUUID(); const otherOwnerId = randomUUID(); const projectIds: string[] = [];
  const schema = `rt_${randomUUID().replaceAll('-', '')}`;
  t.after(async () => {
    try {
      await customer.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      if (projectIds.length) {
        await db.delete(schemaTables).where(inArray(schemaTables.projectId, projectIds));
        await db.delete(apiKeys).where(inArray(apiKeys.projectId, projectIds));
        await db.delete(databaseConnections).where(inArray(databaseConnections.projectId, projectIds));
        await db.delete(projects).where(inArray(projects.id, projectIds));
      }
      await db.delete(users).where(inArray(users.id, [ownerId, otherOwnerId]));
    } finally { await customer.end(); await pool.end(); }
  });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)) });
  await customer.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await db.insert(users).values([ownerId, otherOwnerId].map((id) => ({ id, email: `${id}@example.test` })));
  const projectRepository = new PostgresProjectRepository(db);
  const project = await projectRepository.create(ownerId, { name: 'Runtime', slug: `rt-${randomUUID()}` }); projectIds.push(project.id);
  const otherProject = await projectRepository.create(otherOwnerId, { name: 'Other runtime', slug: `rt-${randomUUID()}` }); projectIds.push(otherProject.id);
  const connectionRepository = new PostgresConnectionRepository(db); const schemaRepository = new PostgresSchemaRepository(db);
  const endpointRepository = new PostgresEndpointRepository(db); const apiKeyRepository = new PostgresApiKeyRepository(db); const runtimeRepository = new PostgresRuntimeRepository(db);
  const dependencies = { projectRepository, connectionRepository, schemaRepository, endpointRepository, apiKeyRepository, runtimeRepository, logger: false as const };
  const app = buildApp({ ...dependencies, platformAuthRepository: memoryPlatformAuthRepository(ownerId), env: { ...env, runtimeAllowedOrigins: ['https://frontend.example'] } });
  const otherApp = buildApp({ ...dependencies, platformAuthRepository: memoryPlatformAuthRepository(otherOwnerId), env });
  t.after(async () => { await app.close(); await otherApp.close(); });
  const management = `/internal/projects/${project.id}`;
  const config = { host: customerUrl.hostname, port: Number(customerUrl.port || 5432), database: decodeURIComponent(customerUrl.pathname.slice(1)),
    username: decodeURIComponent(customerUrl.username), password: decodeURIComponent(customerUrl.password), schema, ssl: false };
  const connected = await app.inject({ method: 'POST', url: `${management}/database-connection`, headers: auth, payload: { ...config, label: 'Runtime fixture' } });
  assert.equal(connected.statusCode, 201, connected.body);
  const fields = [
    { name: 'sku', type: 'text', nullable: false, unique: true },
    { name: 'quantity', type: 'integer', default: { kind: 'literal', value: 7 } },
    { name: 'title', type: 'varchar', options: { length: 200 } },
    { name: 'counter', type: 'bigint' }, { name: 'price', type: 'decimal', options: { precision: 24, scale: 2 } },
    { name: 'active', type: 'boolean' }, { name: 'birthday', type: 'date' },
    { name: 'created_at', type: 'timestamp', default: { kind: 'current_timestamp' } },
    { name: 'payload', type: 'jsonb' }, { name: 'external_id', type: 'uuid' },
  ];
  const draftResponse = await app.inject({ method: 'POST', url: `${management}/schema/tables`, headers: auth, payload: { name: 'products', fields } });
  assert.equal(draftResponse.statusCode, 201, draftResponse.body);
  const tableId: string = draftResponse.json().id; const tablePath = `${management}/schema/tables/${tableId}`;
  const apiPath = `${tablePath}/api`; const keyPath = `${management}/api-keys`; const runtime = `/api/${project.slug}/products`;
  const allOperations = ['list', 'get', 'create', 'update', 'delete'];
  const configure = (enabledOperations: string[], expectedConfigRevision: number, expectedAppliedRevision = 1) => app.inject({ method: 'PUT', url: apiPath, headers: auth, payload: { enabledOperations, expectedConfigRevision, expectedAppliedRevision } });
  let readKey = ''; let writeKey = ''; let readKeyId = ''; let rowId = '';
  const headers = () => ({ authorization: `Bearer ${writeKey}` });
  const safe = (body: string) => {
    for (const secret of [config.password, env.connectionEncryptionKey, 'encryptedConfig', 'keyHash', 'key_hash', 'SQLSTATE', 'postgresql://']) if (secret) assert.ok(!body.includes(secret), 'Sensitive data leaked');
  };
  await t.test('configuration requires applied table; revisions and management ownership are enforced', async () => {
    assert.equal((await configure(allOperations, 0)).statusCode, 409);
    const preview = (await app.inject({ method: 'POST', url: `${tablePath}/preview`, headers: auth })).json();
    const applied = await app.inject({ method: 'POST', url: `${tablePath}/apply`, headers: auth, payload: { expectedDraftRevision: 1, planHash: preview.planHash } });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal((await configure(allOperations, 0, 2)).statusCode, 409);
    const configured = await configure(allOperations, 0); assert.equal(configured.statusCode, 200, configured.body);
    assert.equal(configured.json().resourceName, 'products'); assert.equal(configured.json().revision, 1);
    assert.equal((await configure(allOperations, 0)).statusCode, 409);
    assert.equal((await app.inject({ url: `${management}/endpoints`, headers: auth })).json().length, 1);
    assert.equal((await app.inject({ url: apiPath, headers: auth })).json().tableId, tableId);
    for (const operation of [
      { method: 'GET' as const, url: `${management}/endpoints` }, { method: 'GET' as const, url: apiPath },
      { method: 'PUT' as const, url: apiPath, payload: { enabledOperations: [], expectedConfigRevision: 1, expectedAppliedRevision: 1 } },
      { method: 'POST' as const, url: keyPath, payload: { name: 'Stolen', scope: 'read_write' } }, { method: 'GET' as const, url: keyPath },
    ]) assert.equal((await otherApp.inject({ ...operation, headers: auth })).statusCode, 404);
    const illegal = await app.inject({ method: 'PUT', url: apiPath, headers: auth, payload: { enabledOperations: allOperations, expectedConfigRevision: 1, expectedAppliedRevision: 1, resourceName: 'custom/path' } });
    assert.equal(illegal.statusCode, 400);
    await assert.rejects(db.insert(endpoints).values({ tableId, projectId: otherProject.id, resourceName: 'other', enabledOperations: [], revision: 1 }));
  });
  await t.test('API keys persist hashes, expose secrets once, and enforce project and scope boundaries', async () => {
    const read = await app.inject({ method: 'POST', url: keyPath, headers: auth, payload: { name: 'Browser', scope: 'read' } });
    const write = await app.inject({ method: 'POST', url: keyPath, headers: auth, payload: { name: 'Backend', scope: 'read_write' } });
    assert.equal(read.statusCode, 201, read.body); assert.equal(write.statusCode, 201, write.body);
    readKey = read.json().key; readKeyId = read.json().id; writeKey = write.json().key;
    assert.match(writeKey, /^pk_[A-Za-z0-9_-]{43}$/); safe(write.body);
    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, write.json().id));
    assert.equal(stored?.keyHash, hashKey(writeKey)); assert.ok(!JSON.stringify(stored).includes(writeKey));
    const listed = await app.inject({ url: keyPath, headers: auth });
    assert.equal(listed.statusCode, 200); assert.ok(!listed.body.includes(readKey)); assert.ok(!listed.body.includes(writeKey)); safe(listed.body);
    for (const authorization of [undefined, 'Bearer invalid', auth.authorization]) {
      const response = await app.inject({ url: runtime, headers: authorization ? { authorization } : {} });
      assert.equal(response.statusCode, 401); assert.ok(response.json().requestId); safe(response.body);
    }
    assert.equal((await app.inject({ url: `/api/${otherProject.slug}/products`, headers: headers() })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: runtime, headers: { authorization: `Bearer ${readKey}` }, payload: { sku: 'denied' } })).statusCode, 403);
    assert.equal((await app.inject({ url: runtime, headers: { authorization: `Bearer ${readKey}` } })).statusCode, 200);
    assert.equal((await otherApp.inject({ method: 'DELETE', url: `${keyPath}/${readKeyId}`, headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: `${keyPath}/${readKeyId}`, headers: auth })).statusCode, 204);
    assert.equal((await app.inject({ url: runtime, headers: { authorization: `Bearer ${readKey}` } })).statusCode, 401);
  });
  await t.test('create validates inputs, uses database defaults, and preserves exact scalar and JSONB values', async () => {
    const external = randomUUID(); const injection = "x'); DROP TABLE products; --\\literal";
    const body = { sku: 'first', title: injection, counter: '9223372036854775807', price: '1234567890123456789012.34', active: false,
      birthday: '2024-02-29', created_at: '2026-01-01T05:30:00+05:30', payload: [true, { label: injection }, null], external_id: external };
    const created = await app.inject({ method: 'POST', url: runtime, headers: headers(), payload: body });
    assert.equal(created.statusCode, 201, created.body); safe(created.body); rowId = created.json().id;
    assert.match(rowId, /^[a-f0-9-]{36}$/); assert.equal(created.json().quantity, 7);
    for (const name of ['title', 'counter', 'price', 'active', 'birthday', 'payload', 'external_id']) assert.deepEqual(created.json()[name], body[name as keyof typeof body]);
    assert.equal(created.json().created_at, '2026-01-01T00:00:00.000Z');
    const second = await app.inject({ method: 'POST', url: runtime, headers: headers(), payload: { sku: 'second', active: true, price: '2.00' } });
    assert.equal(second.statusCode, 201, second.body); assert.notEqual(second.json().id, rowId); assert.ok(second.json().created_at);
    assert.equal(second.json().title, null);
    const duplicate = await app.inject({ method: 'POST', url: runtime, headers: headers(), payload: { sku: 'first' } });
    assert.equal(duplicate.statusCode, 409); safe(duplicate.body); assert.ok(duplicate.json().requestId);
    for (const payload of [{}, { sku: null }, { sku: 'x', id: rowId }, { sku: 'x', unknown: 1 }, { sku: 'x', counter: 42 }, { sku: 'x', price: 1.2 }, { sku: 'x', birthday: '2025-02-29' }, []]) {
      const response = await app.inject({ method: 'POST', url: runtime, headers: headers(), payload }); assert.equal(response.statusCode, 400, response.body); safe(response.body);
    }
  });
  await t.test('default-only tables accept empty POST objects and database-generated UUIDs', async () => {
    const created = await app.inject({ method: 'POST', url: `${management}/schema/tables`, headers: auth, payload: { name: 'generated_items', fields: [] } });
    assert.equal(created.statusCode, 201, created.body);
    const path = `${management}/schema/tables/${created.json().id}`;
    const preview = (await app.inject({ method: 'POST', url: `${path}/preview`, headers: auth })).json();
    assert.equal((await app.inject({ method: 'POST', url: `${path}/apply`, headers: auth, payload: { expectedDraftRevision: 1, planHash: preview.planHash } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: `${path}/api`, headers: auth, payload: { enabledOperations: ['create'], expectedAppliedRevision: 1, expectedConfigRevision: 0 } })).statusCode, 200);
    const row = await app.inject({ method: 'POST', url: `/api/${project.slug}/generated_items`, headers: headers(), payload: {} });
    assert.equal(row.statusCode, 201, row.body); assert.match(row.json().id, /^[a-f0-9-]{36}$/);
    assert.deepEqual(Object.keys(row.json()), ['id']);
  });
  await t.test('list, get, equality filters, pagination, sorting, and injection rejection', async () => {
    const get = await app.inject({ url: `${runtime}/${rowId}`, headers: headers() }); assert.equal(get.statusCode, 200, get.body); assert.equal(get.json().id, rowId);
    const list = await app.inject({ url: `${runtime}?limit=1&offset=0&sort=price&direction=desc`, headers: headers() });
    assert.equal(list.statusCode, 200, list.body); assert.equal(list.json().data[0].sku, 'first');
    assert.deepEqual(list.json().pagination, { limit: 1, offset: 0, hasMore: true });
    const page2 = await app.inject({ url: `${runtime}?limit=1&offset=1&sort=price&direction=desc`, headers: headers() });
    assert.equal(page2.json().data[0].sku, 'second'); assert.equal(page2.json().pagination.hasMore, false);
    const filtered = await app.inject({ url: `${runtime}?filter[active]=false&filter[sku]=first`, headers: headers() });
    assert.equal(filtered.statusCode, 200, filtered.body); assert.equal(filtered.json().data.length, 1);
    assert.equal((await app.inject({ url: `${runtime}?filter[sku]=${encodeURIComponent("x' OR true --")}`, headers: headers() })).json().data.length, 0);
    for (const suffix of ['?sort=sku%3BDROP', '?direction=asc%3BSELECT', '?limit=101', '?offset=10001', '?filter[missing]=x', '?filter[payload]=x', '?filter[active]=null', '?limit=1&limit=2']) {
      const response = await app.inject({ url: runtime + suffix, headers: headers() }); assert.equal(response.statusCode, 400, response.body); safe(response.body);
    }
    assert.equal((await app.inject({ url: `${runtime}/${randomUUID()}`, headers: headers() })).statusCode, 404);
    assert.equal((await app.inject({ url: `${runtime}/x%27ORtrue`, headers: headers() })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/${project.slug}/products%3BDROP`, headers: headers() })).statusCode, 404);
  });
  await t.test('PATCH and DELETE affect one UUID-selected row and operations toggle without restart', async () => {
    const patched = await app.inject({ method: 'PATCH', url: `${runtime}/${rowId}`, headers: headers(), payload: { title: null, quantity: 11, payload: { nested: true } } });
    assert.equal(patched.statusCode, 200, patched.body); assert.equal(patched.json().title, null); assert.equal(patched.json().sku, 'first'); assert.equal(patched.json().quantity, 11);
    for (const payload of [{}, { id: randomUUID() }, { unknown: true }, { sku: null }]) assert.equal((await app.inject({ method: 'PATCH', url: `${runtime}/${rowId}`, headers: headers(), payload })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: `${runtime}/${randomUUID()}`, headers: headers(), payload: { title: 'missing' } })).statusCode, 404);
    const temporary = await app.inject({ method: 'POST', url: runtime, headers: headers(), payload: { sku: 'temporary' } });
    const url = `${runtime}/${temporary.json().id}`;
    const deleted = await app.inject({ method: 'DELETE', url, headers: headers() }); assert.equal(deleted.statusCode, 204); assert.equal(deleted.body, '');
    assert.equal((await app.inject({ method: 'DELETE', url, headers: headers() })).statusCode, 404);
    assert.equal((await configure([], 1)).statusCode, 200);
    assert.equal((await app.inject({ url: runtime, headers: headers() })).statusCode, 404);
    assert.equal((await configure(allOperations, 2)).statusCode, 200);
    assert.equal((await app.inject({ url: runtime, headers: headers() })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: `${runtime}/${rowId}`, headers: headers(), payload: {} })).statusCode, 404);
  });
  await t.test('unapplied fields stay inaccessible; applied nullable additions become available', async () => {
    const current = await schemaRepository.get(project.id, ownerId, tableId);
    const updated = await schemaRepository.update(project.id, ownerId, tableId, 1, { name: 'products', fields: [...current.fields.map(toInput), { name: 'notes', type: 'text' }] });
    assert.equal(updated.draftRevision, 2);
    const get = await app.inject({ url: `${runtime}/${rowId}`, headers: headers() }); assert.equal(get.statusCode, 200, get.body); assert.ok(!Object.hasOwn(get.json(), 'notes'));
    assert.equal((await app.inject({ method: 'PATCH', url: `${runtime}/${rowId}`, headers: headers(), payload: { notes: 'draft' } })).statusCode, 400);
    assert.equal((await app.inject({ url: `${runtime}?sort=notes`, headers: headers() })).statusCode, 400);
    const draftFilter = await app.inject({ url: `${runtime}?filter[notes][eq]=draft`, headers: headers() });
    assert.equal(draftFilter.statusCode,400); assert.equal(draftFilter.json().code,'INVALID_FILTER');
    const preview = (await app.inject({ method: 'POST', url: `${tablePath}/preview`, headers: auth })).json();
    const applied = await app.inject({ method: 'POST', url: `${tablePath}/apply`, headers: auth, payload: { expectedDraftRevision: 2, planHash: preview.planHash } });
    assert.equal(applied.statusCode, 200, applied.body);
    const patched = await app.inject({ method: 'PATCH', url: `${runtime}/${rowId}`, headers: headers(), payload: { notes: 'applied' } });
    assert.equal(patched.statusCode, 200, patched.body); assert.equal(patched.json().notes, 'applied');
    const appliedFilter = await app.inject({ url: `${runtime}?filter[notes][in]=${encodeURIComponent(JSON.stringify(['applied']))}`, headers: headers() });
    assert.equal(appliedFilter.statusCode,200,appliedFilter.body); assert.equal(appliedFilter.json().data[0].id,rowId);
  });
  await t.test('runtime blocks unresolved migrations and real lock timeouts are sanitized', async () => {
    const current = await schemaRepository.get(project.id, ownerId, tableId);
    const migrationId = randomUUID();
    await db.insert(schemaMigrations).values({ id: migrationId, projectId: project.id, tableId, draftRevision: 2, planHash: 'a'.repeat(64), definition: current.appliedDefinition!.definition, status: 'outcome_unknown' });
    const blocked = await app.inject({ url: runtime, headers: headers() }); assert.equal(blocked.statusCode, 503, blocked.body); safe(blocked.body);
    await db.delete(schemaMigrations).where(eq(schemaMigrations.id, migrationId));
    await customer.query('BEGIN'); await customer.query(`LOCK TABLE ${quoteIdentifier(schema)}."products" IN ACCESS EXCLUSIVE MODE`);
    try {
      const timeout = await app.inject({ url: runtime, headers: headers() }); assert.equal(timeout.statusCode, 504, timeout.body); safe(timeout.body); assert.ok(timeout.json().requestId);
    } finally { await customer.query('ROLLBACK'); }
    assert.equal((await app.inject({ url: runtime, headers: headers() })).statusCode, 200);
  });
  await t.test('customer statement timeout and cleanup use a real PostgreSQL client', async () => {
    const resolved = (await runtimeRepository.resolve(project.id, 'products'))!;
    const connection = new CredentialEncryption(env.connectionEncryptionKey).decrypt<typeof config>(resolved.connection, `${project.id}:${resolved.connection.id}`);
    const executor = createRuntimeExecutor();
    await assert.rejects(executor(connection, resolved.applied!, { text: 'SELECT pg_catalog.pg_sleep($1)', values: [3] }), { statusCode: 504 });
    const rows = await executor(connection, resolved.applied!, { text: 'SELECT 1 AS healthy', values: [] }); assert.equal(rows[0]?.healthy, 1);
  });
  await t.test('external columns are never exposed and drift rejects all CRUD', async () => {
    await customer.query(`ALTER TABLE ${quoteIdentifier(schema)}."products" ADD COLUMN private_external text DEFAULT 'private-external-secret'`);
    for (const operation of [
      { method: 'GET' as const, url: runtime }, { method: 'GET' as const, url: `${runtime}/${rowId}` },
      { method: 'POST' as const, url: runtime, payload: { sku: 'drift-write' } },
      { method: 'PATCH' as const, url: `${runtime}/${rowId}`, payload: { title: 'drift-write' } }, { method: 'DELETE' as const, url: `${runtime}/${rowId}` },
    ]) { const response = await app.inject({ ...operation, headers: headers() }); assert.equal(response.statusCode, 503, response.body); safe(response.body); assert.ok(!response.body.includes('private_external')); assert.ok(!response.body.includes('private-external-secret')); }
    assert.equal((await customer.query(`SELECT count(*)::integer AS count FROM ${quoteIdentifier(schema)}."products"`)).rows[0].count, 2);
  });
});
