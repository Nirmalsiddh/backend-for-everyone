import { PostgresDocsRepository } from '../../src/modules/api-docs/repository.js';
import { Validator } from '@seriousme/openapi-schema-validator';
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
import { apiKeys, databaseConnections, endpoints, projectAuthConfigs, projects, schemaTables, users } from '../../src/database/platform-db/schema.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { PostgresEndpointRepository } from '../../src/modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { PostgresRuntimeRepository } from '../../src/runtime/repository.js';
import { PostgresAuthRepository } from '../../src/modules/project-auth/repository.js';
import { AuthRateLimiter } from '../../src/modules/project-auth/rate-limit.js';
import { tokenHash } from '../../src/modules/project-auth/service.js';
import { quoteIdentifier as q } from '../../src/modules/schema-builder/plan.js';
import type { Operation, OperationPolicy } from '../../src/modules/endpoints/types.js';
import { auth, env } from '../helpers.js';
test('customer-owned authentication and ownership authorization real PostgreSQL', async (t) => {
  const platformUrl = parseDatabaseUrl(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
  const customerUrl = new URL(parseDatabaseUrl(process.env.TEST_CUSTOMER_DATABASE_URL, 'TEST_CUSTOMER_DATABASE_URL'));
  if (platformUrl === process.env.PLATFORM_DATABASE_URL || new URL(platformUrl).toString() === customerUrl.toString()) throw new Error('Use separate disposable databases');
  const { db, pool } = createPlatformDatabase(platformUrl); const customer = new pg.Client({ connectionString: customerUrl.toString() }); await customer.connect();
  const ownerId = randomUUID(); const otherOwnerId = randomUUID(); const ids: string[] = []; const schema = `au_${randomUUID().replaceAll('-', '')}`;
  t.after(async () => {
    try {
      await customer.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
      if (ids.length) {
        await db.delete(projectAuthConfigs).where(inArray(projectAuthConfigs.projectId, ids));
        await db.delete(schemaTables).where(inArray(schemaTables.projectId, ids));
        await db.delete(apiKeys).where(inArray(apiKeys.projectId, ids));
        await db.delete(databaseConnections).where(inArray(databaseConnections.projectId, ids));
        await db.delete(projects).where(inArray(projects.id, ids));
      }
      await db.delete(users).where(inArray(users.id, [ownerId, otherOwnerId]));
    } finally { await customer.end(); await pool.end(); }
  });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)) }); await customer.query(`CREATE SCHEMA ${q(schema)}`);
  await db.insert(users).values([ownerId, otherOwnerId].map((id) => ({ id, email: `${id}@example.test` })));
  const projectRepository = new PostgresProjectRepository(db); const schemaRepository = new PostgresSchemaRepository(db);
  const project = await projectRepository.create(ownerId, { name: 'Auth', slug: `auth-${randomUUID()}` }); ids.push(project.id);
  const other = await projectRepository.create(otherOwnerId, { name: 'Other auth', slug: `auth-${randomUUID()}` }); ids.push(other.id);
  const dependencies = { docsRepository: new PostgresDocsRepository(db), projectRepository, schemaRepository, connectionRepository: new PostgresConnectionRepository(db), endpointRepository: new PostgresEndpointRepository(db),
    apiKeyRepository: new PostgresApiKeyRepository(db), runtimeRepository: new PostgresRuntimeRepository(db), authRepository: new PostgresAuthRepository(db), logger: false as const };
  const app = buildApp({ ...dependencies, platformAuthRepository: memoryPlatformAuthRepository(ownerId), env, authRateLimiter: new AuthRateLimiter(60000, 1000, 1000) });
  const otherApp = buildApp({ ...dependencies, platformAuthRepository: memoryPlatformAuthRepository(otherOwnerId), env, authRateLimiter: new AuthRateLimiter(60000, 1000, 1000) });
  t.after(async () => { await app.close(); await otherApp.close(); });
  const management = `/internal/projects/${project.id}`; const otherManagement = `/internal/projects/${other.id}`; const base = `/api/${project.slug}`;
  const config = { host: customerUrl.hostname, port: Number(customerUrl.port || 5432), database: decodeURIComponent(customerUrl.pathname.slice(1)),
    username: decodeURIComponent(customerUrl.username), password: decodeURIComponent(customerUrl.password), schema, ssl: false, label: 'Auth fixture' };
  for (const [instance, path] of [[app, management], [otherApp, otherManagement]] as const) assert.equal((await instance.inject({ method: 'POST', url: `${path}/database-connection`, headers: auth, payload: config })).statusCode, 201);
  const provisionTable = async (name: string, fields: unknown[]) => {
    const created = await app.inject({ method: 'POST', url: `${management}/schema/tables`, headers: auth, payload: { name, fields } }); assert.equal(created.statusCode, 201, created.body);
    const path = `${management}/schema/tables/${created.json().id}`;
    const preview = (await app.inject({ method: 'POST', url: `${path}/preview`, headers: auth })).json();
    const applied = await app.inject({ method: 'POST', url: `${path}/apply`, headers: auth, payload: { expectedDraftRevision: 1, planHash: preview.planHash } }); assert.equal(applied.statusCode, 200, applied.body);
    return { table: created.json(), path };
  };
  let usersName = ''; let sessionsName = ''; let aliceToken = ''; let bobToken = ''; let aliceId = ''; let bobId = ''; let aliceOrder = ''; let bobOrder = ''; let key = '';
  let ordersPath = ''; let ownerFieldId = ''; let endpointRevision = 0;
  const password = 'Case sensitive test passphrase';
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const operations: Operation[] = ['list', 'get', 'create', 'update', 'delete'];
  const savePolicies = async (allowAdmin: boolean, overrides: Partial<Record<Operation, OperationPolicy>> = {}) => {
    const policies = Object.fromEntries(operations.map((op) => [op, { mode: 'owner', ownerFieldId, allowAdmin }]));
    const response = await app.inject({ method: 'PUT', url: `${ordersPath}/api`, headers: auth, payload: { enabledOperations: operations, expectedAppliedRevision: 1, expectedConfigRevision: endpointRevision, policies: { ...policies, ...overrides } } });
    assert.equal(response.statusCode, 200, response.body); endpointRevision = response.json().revision;
  };
  const sensitive = (body: string) => {
    for (const secret of [password, config.password, aliceToken, bobToken, 'password_hash', 'passwordHash', 'token_hash', 'tokenHash', '$argon2', 'postgresql://']) if (secret) assert.ok(!body.includes(secret), 'Sensitive authentication data leaked');
  };
  await t.test('auth configuration is owner-scoped and refuses conflicting runtime resources', async () => {
    const legacy = await provisionTable('auth', []);
    const existing = await app.inject({ method: 'PUT', url: `${legacy.path}/api`, headers: auth, payload: { enabledOperations: ['list'], expectedAppliedRevision: 1, expectedConfigRevision: 0 } }); assert.equal(existing.statusCode, 200, existing.body);
    const conflict = await app.inject({ method: 'PUT', url: `${management}/auth`, headers: auth, payload: { enabled: true, signupEnabled: true, expectedRevision: 0 } }); assert.equal(conflict.statusCode, 409);
    await db.delete(endpoints).where(eq(endpoints.tableId, legacy.table.id));
    const configured = await app.inject({ method: 'PUT', url: `${management}/auth`, headers: auth, payload: { enabled: true, signupEnabled: true, expectedRevision: 0 } });
    assert.equal(configured.statusCode, 200, configured.body); assert.equal(configured.json().sessionLifetimeSeconds, 86400); assert.equal(configured.json().provisioningStatus, 'unprovisioned');
    usersName = configured.json().authUsersTableName; sessionsName = configured.json().authSessionsTableName;
    assert.equal((await otherApp.inject({ url: `${management}/auth`, headers: auth })).statusCode, 404);
    assert.equal((await otherApp.inject({ method: 'POST', url: `${management}/auth/provision`, headers: auth, payload: { expectedRevision: 1 } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PUT', url: `${management}/auth`, headers: auth, payload: { enabled: true, signupEnabled: true, expectedRevision: 0 } })).statusCode, 409);
    const provisioned = await app.inject({ method: 'POST', url: `${management}/auth/provision`, headers: auth, payload: { expectedRevision: 1 } });
    assert.equal(provisioned.statusCode, 200, provisioned.body); assert.equal(provisioned.json().provisioningStatus, 'ready'); assert.equal(provisioned.json().revision, 3); sensitive(provisioned.body);
    assert.equal((await app.inject({ method: 'PUT', url: `${legacy.path}/api`, headers: auth, payload: { enabledOperations: ['list'], expectedAppliedRevision: 1, expectedConfigRevision: 0 } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `${management}/auth/provision`, headers: auth, payload: { expectedRevision: 3 } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'DELETE', url: `${management}/database-connection`, headers: auth })).statusCode, 409);
  });
  await t.test('conflicting customer tables fail provisioning transactionally without adoption', async () => {
    const configured = await otherApp.inject({ method: 'PUT', url: `${otherManagement}/auth`, headers: auth, payload: { enabled: true, signupEnabled: true, expectedRevision: 0 } }); assert.equal(configured.statusCode, 200, configured.body);
    const name = configured.json().authUsersTableName; const session = configured.json().authSessionsTableName;
    await customer.query(`CREATE TABLE ${q(schema)}.${q(session)} (untouched text)`);
    const failed = await otherApp.inject({ method: 'POST', url: `${otherManagement}/auth/provision`, headers: auth, payload: { expectedRevision: 1 } }); assert.equal(failed.statusCode, 422, failed.body); sensitive(failed.body);
    assert.equal((await customer.query('SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname=$1 AND tablename=$2', [schema, name])).rowCount, 0);
    const metadata = (await otherApp.inject({ url: `${otherManagement}/auth`, headers: auth })).json(); assert.equal(metadata.provisioningStatus, 'failed');
    await customer.query(`DROP TABLE ${q(schema)}.${q(session)}`);
    const retried = await otherApp.inject({ method: 'POST', url: `${otherManagement}/auth/provision`, headers: auth, payload: { expectedRevision: metadata.revision } }); assert.equal(retried.statusCode, 200, retried.body);
  });
  await t.test('signup normalizes identifiers, salts passwords, and rejects privileged fields', async () => {
    const signup = async (email: string) => app.inject({ method: 'POST', url: `${base}/auth/signup`, payload: { email, password } });
    const alice = await signup(' Alice@Example.Test '); const bob = await signup('bob@example.test');
    assert.equal(alice.statusCode, 201, alice.body); assert.equal(bob.statusCode, 201, bob.body);
    aliceId = alice.json().id; bobId = bob.json().id; assert.equal(alice.json().email, 'alice@example.test'); assert.equal(alice.json().role, 'user'); sensitive(alice.body);
    const hashes = (await customer.query(`SELECT password_hash FROM ${q(schema)}.${q(usersName)} ORDER BY email`)).rows;
    assert.equal(hashes.length, 2); assert.notEqual(hashes[0].password_hash, hashes[1].password_hash); assert.ok(hashes.every((row) => row.password_hash.startsWith('$argon2id$')));
    const duplicate = await signup('ALICE@example.test'); assert.equal(duplicate.statusCode, 409); sensitive(duplicate.body);
    for (const extra of [{ role: 'admin' }, { status: 'active' }, { id: randomUUID() }]) assert.equal((await app.inject({ method: 'POST', url: `${base}/auth/signup`, payload: { email: 'injected@example.test', password, ...extra } })).statusCode, 400);
    const configured = await app.inject({ method: 'PUT', url: `${management}/auth`, headers: auth, payload: { enabled: true, signupEnabled: false, expectedRevision: 3 } }); assert.equal(configured.statusCode, 200);
    assert.equal((await signup('disabled-signup@example.test')).statusCode, 403);
    assert.equal((await app.inject({ method: 'PUT', url: `${management}/auth`, headers: auth, payload: { enabled: true, signupEnabled: true, expectedRevision: 4 } })).statusCode, 200);
  });
  await t.test('login issues hashed expiring sessions and generic credential errors', async () => {
    const login = async (email: string, value = password) => app.inject({ method: 'POST', url: `${base}/auth/login`, payload: { email, password: value } });
    const wrong = await login('alice@example.test', 'wrong'); const unknown = await login('unknown@example.test', 'wrong');
    assert.equal(wrong.statusCode, 401); assert.equal(unknown.statusCode, 401); assert.equal(wrong.json().message, unknown.json().message); sensitive(wrong.body); sensitive(unknown.body);
    const alice = await login('ALICE@example.test'); const bob = await login('bob@example.test');
    assert.equal(alice.statusCode, 200, alice.body); assert.equal(bob.statusCode, 200, bob.body); aliceToken = alice.json().token; bobToken = bob.json().token;
    assert.match(aliceToken, /^us_[A-Za-z0-9_-]{43}$/); assert.equal(alice.json().expiresIn, 86400);
    const rows = (await customer.query(`SELECT token_hash, expires_at, created_at FROM ${q(schema)}.${q(sessionsName)}`)).rows;
    assert.ok(rows.some((row) => row.token_hash === tokenHash(aliceToken))); assert.ok(!JSON.stringify(rows).includes(aliceToken));
    assert.ok(rows.every((row) => row.expires_at.getTime() - row.created_at.getTime() === 86400000));
    const me = await app.inject({ url: `${base}/auth/me`, headers: bearer(aliceToken) }); assert.deepEqual(me.json(), { id: aliceId, email: 'alice@example.test', role: 'user' }); sensitive(me.body);
    assert.equal((await app.inject({ url: `/api/${other.slug}/auth/me`, headers: bearer(aliceToken) })).statusCode, 401);
    assert.equal((await app.inject({ url: `${management}/auth`, headers: bearer(aliceToken) })).statusCode, 401);
    await customer.query(`UPDATE ${q(schema)}.${q(usersName)} SET status='disabled' WHERE id=$1`, [aliceId]);
    const disabled = await login('alice@example.test'); assert.equal(disabled.statusCode, 401); assert.equal(disabled.json().message, wrong.json().message);
    assert.equal((await app.inject({ url: `${base}/auth/me`, headers: bearer(aliceToken) })).statusCode, 401);
    await customer.query(`UPDATE ${q(schema)}.${q(usersName)} SET status='active' WHERE id=$1`, [aliceId]);
  });
  await t.test('existing key_only behavior survives and policies only accept applied UUID fields', async () => {
    const orders = await provisionTable('orders', [{ name: 'owner_id', type: 'uuid', nullable: false }, { name: 'title', type: 'text', nullable: false }]);
    ordersPath = orders.path; ownerFieldId = orders.table.fields[0].id;
    const keyed = await app.inject({ method: 'PUT', url: `${ordersPath}/api`, headers: auth, payload: { enabledOperations: operations, expectedAppliedRevision: 1, expectedConfigRevision: 0 } }); assert.equal(keyed.statusCode, 200, keyed.body); endpointRevision = 1;
    key = (await app.inject({ method: 'POST', url: `${management}/api-keys`, headers: auth, payload: { name: 'Server', scope: 'read_write' } })).json().key;
    assert.equal((await app.inject({ url: `${base}/orders`, headers: bearer(key) })).statusCode, 200);
    assert.equal((await app.inject({ url: `${base}/orders`, headers: bearer(aliceToken) })).statusCode, 401);
    for (const ownerId of [randomUUID(), orders.table.fields[1].id]) {
      const invalid = await app.inject({ method: 'PUT', url: `${ordersPath}/api`, headers: auth, payload: { enabledOperations: operations, expectedAppliedRevision: 1, expectedConfigRevision: 1, policies: { get: { mode: 'owner', ownerFieldId: ownerId, allowAdmin: false } } } }); assert.equal(invalid.statusCode, 400, invalid.body);
    }
    await savePolicies(false);
    assert.equal((await app.inject({ url: `${base}/orders`, headers: bearer(key) })).statusCode, 401);
    for (const operation of [{ method: 'POST' as const, url: `${base}/orders`, payload: { title: 'key-bypass' } },
      { method: 'PATCH' as const, url: `${base}/orders/${randomUUID()}`, payload: { title: 'key-bypass' } },
      { method: 'DELETE' as const, url: `${base}/orders/${randomUUID()}` }]) assert.equal((await app.inject({ ...operation, headers: bearer(key) })).statusCode, 401);
  });
  await t.test('downloaded contract examples exercise application signup/login and owner CRUD', async () => {
    const downloaded = await app.inject({ url: `${management}/openapi`, headers: auth });
    assert.equal(downloaded.statusCode, 200, downloaded.body);
    const doc = downloaded.json(); assert.equal((await new Validator().validate(doc)).valid, true);
    assert.equal((await otherApp.inject({ url: `${management}/openapi`, headers: auth })).statusCode, 404);
    const example = (path: string, method: string) => doc.paths[path][method].requestBody.content['application/json'].example;
    const signupBody = { ...example('/auth/signup', 'post'), email: 'documented@example.test' };
    const signup = await app.inject({ method: 'POST', url: `${base}/auth/signup`, payload: signupBody });
    assert.equal(signup.statusCode, 201, signup.body); assert.ok(doc.paths['/auth/signup'].post.responses[signup.statusCode]);
    const login = await app.inject({ method: 'POST', url: `${base}/auth/login`, payload: signupBody });
    assert.equal(login.statusCode, 200, login.body); assert.equal(typeof login.json().token, 'string');
    const headers = bearer(login.json().token);
    const created = await app.inject({ method: 'POST', url: `${base}/orders`, headers, payload: example('/orders', 'post') });
    assert.equal(created.statusCode, 201, created.body); assert.equal(created.json().owner_id, signup.json().id);
    const rowUrl = `${base}/orders/${created.json().id}`;
    for (const url of [`${base}/orders`, rowUrl]) assert.equal((await app.inject({ url, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: rowUrl, headers, payload: example('/orders/{id}', 'patch') })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: rowUrl, headers })).statusCode, 204);
    assert.ok(!doc.paths['/orders'].post.requestBody.content['application/json'].schema.properties.owner_id);
    assert.ok(!doc.paths['/orders/{id}'].patch.requestBody.content['application/json'].schema.properties.owner_id);
  });
  await t.test('Alice and Bob can create owned orders but cannot read, transfer, patch, or delete each other’s rows', async () => {
    const create = async (token: string, title: string) => app.inject({ method: 'POST', url: `${base}/orders`, headers: bearer(token), payload: { title } });
    const alice = await create(aliceToken, 'Alice order'); const bob = await create(bobToken, 'Bob order');
    assert.equal(alice.statusCode, 201, alice.body); assert.equal(bob.statusCode, 201, bob.body);
    aliceOrder = alice.json().id; bobOrder = bob.json().id; assert.equal(alice.json().owner_id, aliceId); assert.equal(bob.json().owner_id, bobId);
    const list = await app.inject({ url: `${base}/orders?limit=1&sort=title&direction=asc&filter[title]=Alice%20order`, headers: bearer(aliceToken) });
    assert.equal(list.statusCode, 200, list.body); assert.equal(list.json().data.length, 1); assert.equal(list.json().data[0].id, aliceOrder);
    assert.equal((await app.inject({ url: `${base}/orders?offset=1&limit=1`, headers: bearer(aliceToken) })).json().data.length, 0);
    assert.equal((await app.inject({ url: `${base}/orders?filter[owner_id]=${bobId}`, headers: bearer(aliceToken) })).json().data.length, 0);
    for (const operation of [{ method: 'GET' as const }, { method: 'PATCH' as const, payload: { title: 'stolen' } }, { method: 'DELETE' as const }]) {
      const foreign = await app.inject({ ...operation, url: `${base}/orders/${bobOrder}`, headers: bearer(aliceToken) });
      const missing = await app.inject({ ...operation, url: `${base}/orders/${randomUUID()}`, headers: bearer(aliceToken) });
      assert.equal(foreign.statusCode, 404, foreign.body); assert.equal(missing.statusCode, 404); assert.equal(foreign.json().message, missing.json().message); sensitive(foreign.body);
    }
    assert.equal((await app.inject({ method: 'POST', url: `${base}/orders`, headers: bearer(aliceToken), payload: { title: 'injected', owner_id: bobId } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: `${base}/orders/${aliceOrder}`, headers: bearer(aliceToken), payload: { owner_id: bobId } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: `${base}/orders/${aliceOrder}`, headers: bearer(aliceToken), payload: { title: 'Alice edited' } })).statusCode, 200);
    const temp = await create(aliceToken, 'delete-me'); assert.equal((await app.inject({ method: 'DELETE', url: `${base}/orders/${temp.json().id}`, headers: bearer(aliceToken) })).statusCode, 204);
    const filtered = await app.inject({ url: `${base}/orders?filter[title]=${encodeURIComponent("x' OR true --")}`, headers: bearer(aliceToken) }); assert.equal(filtered.json().data.length, 0);
  });
  await t.test('role promotion/demotion is management-only and admin bypass is explicit', async () => {
    const rolePath = `${management}/auth/users/${aliceId}/role`;
    assert.equal((await app.inject({ method: 'PATCH', url: rolePath, headers: bearer(aliceToken), payload: { role: 'admin' } })).statusCode, 401);
    assert.equal((await otherApp.inject({ method: 'PATCH', url: rolePath, headers: auth, payload: { role: 'admin' } })).statusCode, 404);
    const promoted = await app.inject({ method: 'PATCH', url: rolePath, headers: auth, payload: { role: 'admin' } }); assert.equal(promoted.statusCode, 200, promoted.body); sensitive(promoted.body);
    assert.equal((await app.inject({ url: `${base}/auth/me`, headers: bearer(aliceToken) })).json().role, 'admin');
    assert.equal((await app.inject({ url: `${base}/orders/${bobOrder}`, headers: bearer(aliceToken) })).statusCode, 404);
    await savePolicies(true);
    const disabled = await app.inject({ method: 'PUT', url: `${ordersPath}/api`, headers: auth, payload: {
      enabledOperations: operations.filter((op) => op !== 'get'), expectedAppliedRevision: 1, expectedConfigRevision: endpointRevision,
    } }); assert.equal(disabled.statusCode, 200, disabled.body); endpointRevision = disabled.json().revision;
    assert.equal((await app.inject({ url: `${base}/orders/${bobOrder}`, headers: bearer(aliceToken) })).statusCode, 404);
    await savePolicies(true);
    assert.equal((await app.inject({ url: `${base}/orders`, headers: bearer(aliceToken) })).json().data.length, 2);
    assert.equal((await app.inject({ url: `${base}/orders/${bobOrder}`, headers: bearer(aliceToken) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: `${base}/orders/${bobOrder}`, headers: bearer(aliceToken), payload: { title: 'Admin edited' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: `${base}/orders/${bobOrder}`, headers: bearer(aliceToken), payload: { owner_id: aliceId } })).statusCode, 400);
    const created = await app.inject({ method: 'POST', url: `${base}/orders`, headers: bearer(aliceToken), payload: { title: 'Admin own' } }); assert.equal(created.json().owner_id, aliceId);
    const temporary = await app.inject({ method: 'POST', url: `${base}/orders`, headers: bearer(bobToken), payload: { title: 'Admin deletes Bob temp' } });
    assert.equal((await app.inject({ method: 'DELETE', url: `${base}/orders/${temporary.json().id}`, headers: bearer(aliceToken) })).statusCode, 204);
    assert.equal((await app.inject({ method: 'PATCH', url: rolePath, headers: auth, payload: { role: 'user' } })).statusCode, 200);
    assert.equal((await app.inject({ url: `${base}/orders/${bobOrder}`, headers: bearer(aliceToken) })).statusCode, 404);
    await savePolicies(false, { get: { mode: 'authenticated' }, update: { mode: 'authenticated' } });
    assert.equal((await app.inject({ method: 'PATCH', url: `${base}/orders/${bobOrder}`, headers: bearer(aliceToken), payload: { owner_id: aliceId } })).statusCode, 400);
    assert.equal((await app.inject({ url: `${base}/orders/${bobOrder}`, headers: bearer(aliceToken) })).statusCode, 200);
    assert.equal((await app.inject({ url: `${base}/orders/${bobOrder}`, headers: bearer(key) })).statusCode, 401);
    await savePolicies(false);
  });
  await t.test('auth internal tables remain inaccessible through generic CRUD, schema editing, and filters', async () => {
    const listed = (await app.inject({ url: `${management}/schema`, headers: auth })).json(); assert.ok(!JSON.stringify(listed).includes(usersName));
    for (const name of [usersName, sessionsName]) {
      assert.equal((await app.inject({ method: 'POST', url: `${management}/schema/tables`, headers: auth, payload: { name, fields: [] } })).statusCode, 400);
      for (const token of [key, aliceToken]) {
        const response = await app.inject({ url: `${base}/${name}`, headers: bearer(token) }); assert.equal(response.statusCode, 404, response.body); sensitive(response.body);
      }
      assert.equal((await app.inject({ url: `${base}/orders?sort=${name}`, headers: bearer(aliceToken) })).statusCode, 400);
    }
  });
  await t.test('sessions expire, logout is repeatable, and revoked sessions cannot access rows', async () => {
    const login = await app.inject({ method: 'POST', url: `${base}/auth/login`, payload: { email: 'alice@example.test', password } }); const expired = login.json().token;
    await customer.query(`UPDATE ${q(schema)}.${q(sessionsName)} SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE token_hash=$1`, [tokenHash(expired)]);
    assert.equal((await app.inject({ url: `${base}/auth/me`, headers: bearer(expired) })).statusCode, 401);
    assert.equal((await app.inject({ url: `${base}/orders`, headers: bearer(expired) })).statusCode, 401);
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await app.inject({ method: 'POST', url: `${base}/auth/logout`, headers: bearer(aliceToken) })).statusCode, 204);
    assert.equal((await app.inject({ url: `${base}/auth/me`, headers: bearer(aliceToken) })).statusCode, 401);
    assert.equal((await app.inject({ url: `${base}/orders`, headers: bearer(aliceToken) })).statusCode, 401);
    assert.equal((await customer.query(`SELECT 1 FROM ${q(schema)}.${q(usersName)} WHERE id=$1`, [aliceId])).rowCount, 1);
  });
  await t.test('session revocation between authentication and mutation is rechecked in the CRUD transaction', async () => {
    const raceApp = buildApp({ ...dependencies, platformAuthRepository: memoryPlatformAuthRepository(ownerId), env, runtimeRepository: {
      authenticate: (slug, hash) => dependencies.runtimeRepository.authenticate(slug, hash),
      resolve: async (projectId, resource) => {
        const target = await dependencies.runtimeRepository.resolve(projectId, resource);
        await customer.query(`UPDATE ${q(schema)}.${q(sessionsName)} SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=$1`, [tokenHash(bobToken)]);
        return target;
      },
    } });
    try {
      const response = await raceApp.inject({ method: 'PATCH', url: `${base}/orders/${bobOrder}`, headers: bearer(bobToken), payload: { title: 'revoked-write' } });
      assert.equal(response.statusCode, 401, response.body);
      assert.notEqual((await customer.query(`SELECT title FROM ${q(schema)}.orders WHERE id=$1`, [bobOrder])).rows[0].title, 'revoked-write');
    } finally { await raceApp.close(); }
  });

});
