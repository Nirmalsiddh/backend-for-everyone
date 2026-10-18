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
import { apiKeys, databaseConnections, projectAuthConfigs, projects, schemaTables, users, workflowEndpoints, workflowVersions } from '../../src/database/platform-db/schema.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { PostgresEndpointRepository } from '../../src/modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { PostgresRuntimeRepository } from '../../src/runtime/repository.js';
import { PostgresAuthRepository } from '../../src/modules/project-auth/repository.js';
import { PostgresWorkflowRepository } from '../../src/modules/workflows/repository.js';
import { createTransactionRunner } from '../../src/database/customer-db/transaction-runner.js';
import { CredentialEncryption } from '../../src/security/encryption.js';
import { quoteIdentifier as q } from '../../src/modules/schema-builder/plan.js';
import type { FieldDefinition } from '../../src/modules/schema-builder/types.js';
import type { Step, Value, WorkflowDefinition } from '../../src/modules/workflows/types.js';
import { auth, env } from '../helpers.js';
const lit = (value: unknown): Value => ({ kind: 'literal', value });
const ref = (stepId: string, ...path: string[]): Value => ({ kind: 'reference', source: 'step', stepId, path });
const req = (name: string): Value => ({ kind: 'reference', source: 'request', path: ['body', name] });
const response = (name: string, status: 200 | 201 | 204 | 404 | 409, body?: Value): Step => ({ id: randomUUID(), name, type: 'response', status, ...(body ? { body } : {}) });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
test('custom workflows real PostgreSQL transactions, authorization and concurrent order acceptance', async (t) => {
  const platformUrl = parseDatabaseUrl(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
  const customerUrl = new URL(parseDatabaseUrl(process.env.TEST_CUSTOMER_DATABASE_URL, 'TEST_CUSTOMER_DATABASE_URL'));
  if (platformUrl === process.env.PLATFORM_DATABASE_URL || new URL(platformUrl).toString() === customerUrl.toString()) throw new Error('Use separate disposable databases');
  const { db, pool } = createPlatformDatabase(platformUrl); const customer = new pg.Client({ connectionString: customerUrl.toString() }); await customer.connect();
  const ownerId = randomUUID(); const otherOwnerId = randomUUID(); const projectIds: string[] = []; const schema = `wf_${randomUUID().replaceAll('-', '')}`;
  t.after(async () => {
    try {
      await customer.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
      if (projectIds.length) {
        await db.delete(workflowEndpoints).where(inArray(workflowEndpoints.projectId, projectIds));
        await db.delete(projectAuthConfigs).where(inArray(projectAuthConfigs.projectId, projectIds));
        await db.delete(schemaTables).where(inArray(schemaTables.projectId, projectIds)); await db.delete(apiKeys).where(inArray(apiKeys.projectId, projectIds));
        await db.delete(databaseConnections).where(inArray(databaseConnections.projectId, projectIds)); await db.delete(projects).where(inArray(projects.id, projectIds));
      }
      await db.delete(users).where(inArray(users.id, [ownerId, otherOwnerId]));
    } finally { await customer.end(); await pool.end(); }
  });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)) }); await customer.query(`CREATE SCHEMA ${q(schema)}`);
  await db.insert(users).values([ownerId, otherOwnerId].map((id) => ({ id, email: `${id}@example.test` })));
  const projectRepository = new PostgresProjectRepository(db); const schemaRepository = new PostgresSchemaRepository(db); const workflowRepository = new PostgresWorkflowRepository(db);
  const project = await projectRepository.create(ownerId, { name: 'Workflow', slug: `wf-${randomUUID()}` }); projectIds.push(project.id);
  const deps = { projectRepository, schemaRepository, workflowRepository, connectionRepository: new PostgresConnectionRepository(db), endpointRepository: new PostgresEndpointRepository(db),
    apiKeyRepository: new PostgresApiKeyRepository(db), runtimeRepository: new PostgresRuntimeRepository(db), authRepository: new PostgresAuthRepository(db), logger: false as const };
  const app = buildApp({ ...deps, env: { ...env, managementUserId: ownerId } }); const otherApp = buildApp({ ...deps, env: { ...env, managementUserId: otherOwnerId } });
  t.after(async () => { await app.close(); await otherApp.close(); });
  const management = `/internal/projects/${project.id}`; const base = `/api/${project.slug}`;
  const config = { host: customerUrl.hostname, port: Number(customerUrl.port || 5432), database: decodeURIComponent(customerUrl.pathname.slice(1)), username: decodeURIComponent(customerUrl.username), password: decodeURIComponent(customerUrl.password), schema, ssl: false, label: 'Workflow fixture' };
  const connected = await app.inject({ method: 'POST', url: `${management}/database-connection`, headers: auth, payload: config }); assert.equal(connected.statusCode, 201, connected.body);
  const connectionId = connected.json().id;
  const applyTable = async (name: string, fields: unknown[]) => {
    const created = await app.inject({ method: 'POST', url: `${management}/schema/tables`, headers: auth, payload: { name, fields } }); assert.equal(created.statusCode, 201, created.body);
    const table = created.json() as { id: string; fields: FieldDefinition[] }; const path = `${management}/schema/tables/${table.id}`;
    const preview = (await app.inject({ method: 'POST', url: `${path}/preview`, headers: auth })).json();
    const applied = await app.inject({ method: 'POST', url: `${path}/apply`, headers: auth, payload: { expectedDraftRevision: 1, planHash: preview.planHash } }); assert.equal(applied.statusCode, 200, applied.body); return { ...table, path };
  };
  const products = await applyTable('products', [{ name: 'stock', type: 'integer', nullable: false }]);
  const orders = await applyTable('orders', [{ name: 'owner_id', type: 'uuid', nullable: false }, { name: 'product_id', type: 'uuid', nullable: false }, { name: 'quantity', type: 'integer', nullable: false }]);
  const stock = products.fields[0]!.id; const owner = orders.fields[0]!.id; const productField = orders.fields[1]!.id; const quantity = orders.fields[2]!.id;
  const productId = randomUUID(); await customer.query(`INSERT INTO ${q(schema)}.products (id, stock) VALUES ($1, 5)`, [productId]);
  const key = (await app.inject({ method: 'POST', url: `${management}/api-keys`, headers: auth, payload: { name: 'Server', scope: 'read_write' } })).json().key as string;
  const readKey = (await app.inject({ method: 'POST', url: `${management}/api-keys`, headers: auth, payload: { name: 'Read', scope: 'read' } })).json().key as string;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  assert.equal((await app.inject({ method: 'PUT', url: `${management}/auth`, headers: auth, payload: { enabled: true, signupEnabled: true, expectedRevision: 0 } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `${management}/auth/provision`, headers: auth, payload: { expectedRevision: 1 } })).statusCode, 200);
  const tokens: string[] = []; const userIds: string[] = [];
  for (const email of ['alice@workflow.test', 'bob@workflow.test']) {
    const payload = { email, password: 'Workflow private test passphrase' };
    const signup = await app.inject({ method: 'POST', url: `${base}/auth/signup`, payload }); assert.equal(signup.statusCode, 201, signup.body); userIds.push(signup.json().id);
    const login = await app.inject({ method: 'POST', url: `${base}/auth/login`, payload }); assert.equal(login.statusCode, 200, login.body); tokens.push(login.json().token);
  }
  const getId = randomUUID(); const insertId = randomUUID(); const updateId = randomUUID();
  const access = { mode: 'authenticated' as const }; const owned = { mode: 'owner' as const, ownerFieldId: owner, allowAdmin: false };
  const definition: WorkflowDefinition = { input: { product_id: { type: 'uuid', required: true }, quantity: { type: 'integer', required: true, min: 1 } }, auth: 'authenticated', steps: [
    { id: getId, name: 'get_product', type: 'query', tableId: products.id, access, select: ['id', stock], idValue: req('product_id'), forUpdate: true, onMissing: 'null' },
    { id: randomUUID(), name: 'missing', type: 'condition', operator: 'is_null', left: ref(getId, 'row'), then: [response('not_found', 404, lit({ error: 'Product unavailable' }))], else: [] },
    { id: randomUUID(), name: 'stock_check', type: 'condition', operator: 'greater_or_equal', left: ref(getId, 'row', stock), right: req('quantity'), then: [
      { id: insertId, name: 'create_order', type: 'insert', tableId: orders.id, access: owned, values: { [productField]: req('product_id'), [quantity]: req('quantity') }, select: ['id', owner, productField, quantity] },
      { id: updateId, name: 'decrement_stock', type: 'update', tableId: products.id, access, idValue: req('product_id'), assignments: [{ operation: 'decrement', fieldId: stock, value: req('quantity'), guard: 'gte_value' }], select: [stock], onNoMatch: 409 },
      response('created', 201, { kind: 'object', fields: { id: ref(insertId, 'row', 'id'), owner_id: ref(insertId, 'row', owner), product_id: ref(insertId, 'row', productField), quantity: ref(insertId, 'row', quantity) } }),
    ], else: [response('insufficient', 409, lit({ error: 'Insufficient stock' }))] },
  ] };
  const create = async (path: string, value: WorkflowDefinition) => {
    const result = await app.inject({ method: 'POST', url: `${management}/workflows`, headers: auth, payload: { path, definition: value } }); assert.equal(result.statusCode, 201, result.body); return result.json() as { id: string; draftRevision: number };
  };
  const publish = async (id: string, revision = 1) => {
    const path = `${management}/workflows/${id}`; const preview = await app.inject({ method: 'POST', url: `${path}/preview`, headers: auth }); assert.equal(preview.statusCode, 200, preview.body);
    const result = await app.inject({ method: 'POST', url: `${path}/publish`, headers: auth, payload: { expectedDraftRevision: revision, definitionHash: preview.json().definitionHash } }); assert.equal(result.statusCode, 200, result.body);
    assert.equal((await app.inject({ method: 'PATCH', url: path, headers: auth, payload: { expectedDraftRevision: revision, enabled: true } })).statusCode, 200); return result.json();
  };
  const workflow = await create('place-order', definition); const workflowPath = `${management}/workflows/${workflow.id}`;
  await t.test('management ownership, static preview, publication, immutable snapshots, and disabled behavior', async () => {
    assert.equal((await otherApp.inject({ url: workflowPath, headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/place-order`, headers: bearer(tokens[0]!), payload: { product_id: productId, quantity: 1 } })).statusCode, 404);
    const preview = await app.inject({ method: 'POST', url: `${workflowPath}/preview`, headers: auth }); assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().databaseStepCount, 3); assert.equal(preview.json().requiredScope, 'read_write');
    assert.equal((await customer.query(`SELECT count(*)::integer AS n FROM ${q(schema)}.orders`)).rows[0].n, 0);
    assert.equal((await app.inject({ method: 'POST', url: `${workflowPath}/publish`, headers: auth, payload: { expectedDraftRevision: 2, definitionHash: preview.json().definitionHash } })).statusCode, 409);
    const version = await publish(workflow.id); assert.equal(version.version, 1);
    assert.deepEqual((await app.inject({ url: workflowPath, headers: auth })).json().publishedDefinition, definition);
    const changed = clone(definition); changed.input.quantity!.min = 2;
    const edited = await app.inject({ method: 'PUT', url: `${workflowPath}/draft`, headers: auth, payload: { expectedDraftRevision: 1, definition: changed } }); assert.equal(edited.statusCode, 200, edited.body);
    const fetched = (await app.inject({ url: workflowPath, headers: auth })).json();
    assert.deepEqual(fetched.publishedDefinition, definition);
    assert.deepEqual(fetched.draftDefinition, changed);
    assert.equal((await app.inject({ method: 'PUT', url: `${workflowPath}/draft`, headers: auth, payload: { expectedDraftRevision: 1, definition: changed } })).statusCode, 409);
    assert.deepEqual((await db.select().from(workflowVersions).where(eq(workflowVersions.id, version.id)))[0]?.definition, definition);
    assert.equal((await app.inject({ method: 'POST', url: `${workflowPath}/publish`, headers: auth, payload: { expectedDraftRevision: 2, definitionHash: 'a'.repeat(64) } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/place-order`, headers: bearer(tokens[0]!), payload: { product_id: randomUUID(), quantity: 1 } })).statusCode, 404);
  });
  await t.test('MANDATORY concurrent place-order: only one commits; no oversell or orphan order', async () => {
    const results = await Promise.all(tokens.map((token) => app.inject({ method: 'POST', url: `${base}/place-order`, headers: bearer(token), payload: { product_id: productId, quantity: 4 } })));
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409], results.map((result) => result.body).join('\n'));
    const rows = (await customer.query(`SELECT owner_id, quantity FROM ${q(schema)}.orders WHERE product_id=$1`, [productId])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].quantity, 4); assert.ok(userIds.includes(rows[0].owner_id));
    assert.equal((await customer.query(`SELECT stock FROM ${q(schema)}.products WHERE id=$1`, [productId])).rows[0].stock, 1);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/products`, headers: bearer(tokens[0]!), payload: { stock: 100 } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/place-order`, headers: bearer(key), payload: { product_id: productId, quantity: 1 } })).statusCode, 401);
  });
  await t.test('rollback after writes, business response, unique conflict, missing references and invalid comparisons', async () => {
    const newProduct = randomUUID(); const insertion: Step = { id: randomUUID(), name: 'insert', type: 'insert', tableId: products.id, access: { mode: 'key_only' }, values: { [stock]: lit(9) }, select: ['id'] };
    const cases: [string, Step[], number][] = [
      ['business-rollback', [insertion, response('reject', 409, lit({ rejected: true }))], 409],
      ['missing-rollback', [insertion, { id: randomUUID(), name: 'delete', type: 'delete', tableId: products.id, access: { mode: 'key_only' }, idValue: lit(newProduct) }, response('ok', 200, lit(true))], 404],
      ['reference-rollback', [insertion, response('bad_reference', 200, { kind: 'reference', source: 'request', path: ['body', 'optional'] })], 500],
      ['type-rollback', [insertion, { id: randomUUID(), name: 'bad_comparison', type: 'condition', operator: 'greater_than', left: lit('9223372036854775807'), right: lit(1), then: [response('yes', 200, lit(true))], else: [response('no', 200, lit(false))] }], 500],
    ];
    for (const [path, steps, status] of cases) {
      const wf = await create(path, { input: { optional: { type: 'string' } }, auth: 'key_only', steps }); await publish(wf.id);
      const before = (await customer.query(`SELECT count(*)::integer AS n FROM ${q(schema)}.products`)).rows[0].n;
      const result = await app.inject({ method: 'POST', url: `${base}/${path}`, headers: bearer(key), payload: {} }); assert.equal(result.statusCode, status, result.body);
      assert.equal((await customer.query(`SELECT count(*)::integer AS n FROM ${q(schema)}.products`)).rows[0].n, before);
      assert.ok(!result.body.includes('SELECT')); assert.ok(!result.body.includes(config.password));
    }
    const unique = await applyTable('unique_items', [{ name: 'code', type: 'text', nullable: false, unique: true }]); const code = unique.fields[0]!.id;
    const first: Step = { id: randomUUID(), name: 'first_insert', type: 'insert', tableId: unique.id, access: { mode: 'key_only' }, values: { [code]: lit('duplicate') }, select: ['id'] };
    const wf = await create('unique-rollback', { input: {}, auth: 'key_only', steps: [first, { ...first, id: randomUUID(), name: 'second_insert' }, response('done', 200, lit(true))] }); await publish(wf.id);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/unique-rollback`, headers: bearer(key), payload: {} })).statusCode, 409);
    assert.equal((await customer.query(`SELECT count(*)::integer AS n FROM ${q(schema)}.unique_items`)).rows[0].n, 0);
  });
  await t.test('owner query/update/delete predicates, auth references, API-key scope, and guard failure rollback', async () => {
    const queryId = randomUUID(); const ownerLookup: Step = { id: queryId, name: 'owned_order', type: 'query', tableId: orders.id, access: owned, idValue: req('id'), select: ['id', owner], onMissing: '404' };
    const row = (await customer.query(`SELECT id, owner_id FROM ${q(schema)}.orders LIMIT 1`)).rows[0]; const ownIndex = userIds.indexOf(row.owner_id); const foreignIndex = ownIndex ? 0 : 1;
    const wf = await create('own-order', { auth: 'authenticated', input: { id: { type: 'uuid', required: true } }, steps: [ownerLookup, response('owned', 200, { kind: 'object', fields: { id: ref(queryId, 'row', 'id'), user: { kind: 'reference', source: 'auth', path: ['user', 'id'] } } })] }); await publish(wf.id);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/own-order`, headers: bearer(tokens[foreignIndex]!), payload: { id: row.id } })).statusCode, 404);
    const own = await app.inject({ method: 'POST', url: `${base}/own-order`, headers: bearer(tokens[ownIndex]!), payload: { id: row.id } }); assert.equal(own.statusCode, 200, own.body); assert.equal(own.json().user, row.owner_id);
    const mutator = await create('own-change', { auth: 'authenticated', input: { id: { type: 'uuid', required: true } }, steps: [
      { id: randomUUID(), name: 'change', type: 'update', tableId: orders.id, access: owned, idValue: req('id'), assignments: [{ operation: 'set', fieldId: quantity, value: lit(4) }], select: ['id'], onNoMatch: 404 },
      { id: randomUUID(), name: 'delete', type: 'delete', tableId: orders.id, access: owned, idValue: req('id') }, response('deleted', 204),
    ] }); await publish(mutator.id);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/own-change`, headers: bearer(tokens[foreignIndex]!), payload: { id: row.id } })).statusCode, 404);
    // Preserve the acceptance order; a separate row exercises successful owner update/delete.
    const temp = randomUUID(); await customer.query(`INSERT INTO ${q(schema)}.orders (id,owner_id,product_id,quantity) VALUES ($1,$2,$3,1)`, [temp, row.owner_id, productId]);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/own-change`, headers: bearer(tokens[ownIndex]!), payload: { id: temp } })).statusCode, 204);
    const guarded = await create('guard-rollback', { input: {}, auth: 'key_only', steps: [
      { id: randomUUID(), name: 'insert', type: 'insert', tableId: products.id, access: { mode: 'key_only' }, values: { [stock]: lit(1) }, select: ['id'] },
      { id: randomUUID(), name: 'guard', type: 'update', tableId: products.id, access: { mode: 'key_only' }, idValue: lit(productId), assignments: [{ operation: 'decrement', fieldId: stock, value: lit(5), guard: 'gte_value' }], select: [stock], onNoMatch: 422 }, response('ok', 200, lit(true)),
    ] }); await publish(guarded.id);
    const before = (await customer.query(`SELECT count(*)::integer AS n FROM ${q(schema)}.products`)).rows[0].n;
    assert.equal((await app.inject({ method: 'POST', url: `${base}/guard-rollback`, headers: bearer(readKey), payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/guard-rollback`, headers: bearer(key), payload: {} })).statusCode, 422);
    assert.equal((await customer.query(`SELECT count(*)::integer AS n FROM ${q(schema)}.products`)).rows[0].n, before);
  });
  await t.test('shared resource reservation serializes concurrent workflow and CRUD claims', async () => {
    const table = await applyTable('claimed', []);
    const constant: WorkflowDefinition = { auth: 'key_only', input: {}, steps: [response('ok', 200, lit(true))] };
    const results = await Promise.all([
      app.inject({ method: 'POST', url: `${management}/workflows`, headers: auth, payload: { path: 'claimed', definition: constant } }),
      app.inject({ method: 'PUT', url: `${table.path}/api`, headers: auth, payload: { enabledOperations: ['create'], expectedAppliedRevision: 1, expectedConfigRevision: 0 } }),
    ]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), results[0]!.statusCode === 201 ? [201, 409] : [200, 409]);
    assert.equal((await app.inject({ method: 'POST', url: `${management}/workflows`, headers: auth, payload: { path: 'auth', definition: constant } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `${management}/workflows`, headers: auth, payload: { path: 'place-order', definition: constant } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'PATCH', url: workflowPath, headers: auth, payload: { expectedDraftRevision: 2, enabled: false } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/place-order`, headers: bearer(tokens[0]!), payload: { product_id: productId, quantity: 1 } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PATCH', url: workflowPath, headers: auth, payload: { expectedDraftRevision: 2, enabled: true } })).statusCode, 200);
  });
  await t.test('lock timeout rolls back; real total deadline destroys work and clients recover', async () => {
    await customer.query('BEGIN'); await customer.query(`SELECT id FROM ${q(schema)}.products WHERE id=$1 FOR UPDATE`, [productId]);
    try { const result = await app.inject({ method: 'POST', url: `${base}/place-order`, headers: bearer(tokens[0]!), payload: { product_id: productId, quantity: 1 } }); assert.equal(result.statusCode, 504, result.body); }
    finally { await customer.query('ROLLBACK'); }
    const record = (await deps.connectionRepository.findOwned(project.id, ownerId))!;
    const customerConfig = new CredentialEncryption(env.connectionEncryptionKey).decrypt<import('../../src/modules/database-connections/types.js').ConnectionConfig>(record, `${project.id}:${connectionId}`);
    const runner = createTransactionRunner();
    await assert.rejects(runner(customerConfig, (client) => client.query('SELECT pg_catalog.pg_sleep($1)', [3]), 100), { statusCode: 504 });
    assert.equal(await runner(customerConfig, async (client) => (await client.query('SELECT 1 AS healthy')).rows[0]?.healthy), 1);
  });
  await t.test('schema dependencies require republish and external drift is never adopted', async () => {
    const current = await schemaRepository.get(project.id, ownerId, products.id);
    const fields = current.fields.map(({ position: _position, default: def, ...field }) => ({ ...field, ...(def ? { default: def } : {}) }));
    await schemaRepository.update(project.id, ownerId, products.id, 1, { name: 'products', fields: [...fields, { name: 'notes', type: 'text' }] });
    const preview = (await app.inject({ method: 'POST', url: `${products.path}/preview`, headers: auth })).json();
    assert.equal((await app.inject({ method: 'POST', url: `${products.path}/apply`, headers: auth, payload: { expectedDraftRevision: 2, planHash: preview.planHash } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/place-order`, headers: bearer(tokens[0]!), payload: { product_id: productId, quantity: 1 } })).statusCode, 503);
    await publish(workflow.id, 2);
    await customer.query(`ALTER TABLE ${q(schema)}.products ADD COLUMN external_secret text`);
    const result = await app.inject({ method: 'POST', url: `${base}/place-order`, headers: bearer(tokens[0]!), payload: { product_id: productId, quantity: 2 } }); assert.equal(result.statusCode, 503, result.body); assert.ok(!result.body.includes('external_secret'));
  });
});
