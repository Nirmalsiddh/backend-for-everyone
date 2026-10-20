import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../../src/app.js';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { users, projects, databaseConnections, schemaTables, apiKeys, workflowEndpoints } from '../../src/database/platform-db/schema.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { PostgresEndpointRepository } from '../../src/modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { PostgresRuntimeRepository } from '../../src/runtime/repository.js';
import { PostgresWorkflowRepository } from '../../src/modules/workflows/repository.js';
import { PostgresDocsRepository } from '../../src/modules/api-docs/repository.js';
import { SchemaService } from '../../src/modules/schema-builder/service.js';
import { createSchemaExecutor } from '../../src/database/customer-db/schema-executor.js';
import { customerAdmission, boundedClient } from '../../src/database/customer-db/admission.js';
import { CredentialEncryption } from '../../src/security/encryption.js';
import { generatePlan, quoteIdentifier as q } from '../../src/modules/schema-builder/plan.js';
import { indexName } from '../../src/modules/schema-builder/indexes.js';
import { reconcile } from '../../src/operations/reconciliation.js';
import type { FieldInput, TableRecord, IndexInput } from '../../src/modules/schema-builder/types.js';
import type { WorkflowDefinition } from '../../src/modules/workflows/types.js';
import { memoryPlatformAuthRepository } from '../platform-auth-helpers.js';
import { auth, env } from '../helpers.js';
const inputFields = (table: TableRecord): FieldInput[] => table.fields.map(({ position: _, default: value, ...field }) => ({ ...field, ...(value ? { default: value } : {}) }));
const inputIndexes = (table: TableRecord): IndexInput[] => (table.indexes ?? []).map(({ specificationVersion: _, ...index }) => index);
test('managed indexes and requiredness: PostgreSQL contracts, locks, workflow revisions, drift and recovery', async (t) => {
  const { db, pool } = createPlatformDatabase(process.env.TEST_DATABASE_URL!);
  const url = new URL(process.env.TEST_CUSTOMER_DATABASE_URL!);
  assert.notEqual(new URL(process.env.TEST_DATABASE_URL!).toString(), url.toString());
  const customer = new pg.Client({ connectionString: url.toString() }); await customer.connect();
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)) });
  const owner = randomUUID(), schema = 'ix_' + randomUUID().replaceAll('-', '');
  await customer.query(`CREATE SCHEMA ${q(schema)}`);
  await db.insert(users).values({ id: owner, email: owner + '@example.test' });
  const projectRepository = new PostgresProjectRepository(db);
  const project = await projectRepository.create(owner, { name: 'Managed indexes', slug: 'ix-' + randomUUID() });
  const repository = new PostgresSchemaRepository(db);
  const encryption = new CredentialEncryption(env.connectionEncryptionKey);
  const connectionRepository = new PostgresConnectionRepository(db);
  const deps = { projectRepository, schemaRepository: repository, connectionRepository,
    endpointRepository: new PostgresEndpointRepository(db), apiKeyRepository: new PostgresApiKeyRepository(db),
    runtimeRepository: new PostgresRuntimeRepository(db), workflowRepository: new PostgresWorkflowRepository(db),
    docsRepository: new PostgresDocsRepository(db), platformAuthRepository: memoryPlatformAuthRepository(owner), env, logger: false as const };
  const app = buildApp(deps);
  t.after(async () => {
    await app.close(); await customer.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await db.delete(workflowEndpoints).where(eq(workflowEndpoints.projectId, project.id));
    await db.delete(schemaTables).where(eq(schemaTables.projectId, project.id));
    await db.delete(apiKeys).where(eq(apiKeys.projectId, project.id));
    await db.delete(databaseConnections).where(eq(databaseConnections.projectId, project.id));
    await db.delete(projects).where(eq(projects.id, project.id)); await db.delete(users).where(eq(users.id, owner));
    await customer.end(); await pool.end();
  });
  const base = '/internal/projects/' + project.id;
  const config = { host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema, ssl: false };
  const connected = await app.inject({ method: 'POST', url: base + '/database-connection', headers: auth, payload: { ...config, label: 'Disposable' } }); assert.equal(connected.statusCode, 201, connected.body);
  const bearer = { authorization: 'Bearer ' + (await app.inject({ method: 'POST', url: base + '/api-keys', headers: auth, payload: { name: 'Tests', scope: 'read_write' } })).json().key };
  const path = (table: TableRecord) => `${base}/schema/tables/${table.id}`;
  const runtime = (method: 'GET' | 'POST' | 'PATCH', resource: string, payload?: object) => app.inject({ method, url: `/api/${project.slug}/${resource}`, headers: bearer, ...(payload ? { payload } : {}) });
  async function draft(name: string, fields: FieldInput[]) {
    const response = await app.inject({ method: 'POST', url: base + '/schema/tables', headers: auth, payload: { name, fields } }); assert.equal(response.statusCode, 201, response.body);
    return repository.get(project.id, owner, response.json().id);
  }
  async function edit(table: TableRecord, fields = inputFields(table), indexes = inputIndexes(table)) {
    return repository.update(project.id, owner, table.id, table.draftRevision, { name: table.name, fields, indexes });
  }
  async function apply(table: TableRecord, status = 200) {
    const preview = await app.inject({ method: 'POST', url: path(table) + '/preview', headers: auth }); assert.equal(preview.statusCode, 200, preview.body);
    const response = await app.inject({ method: 'POST', url: path(table) + '/apply', headers: auth, payload: { expectedDraftRevision: table.draftRevision, planHash: preview.json().planHash } });
    assert.equal(response.statusCode, status, response.body); return repository.get(project.id, owner, table.id);
  }
  async function enable(table: TableRecord) {
    const response = await app.inject({ method: 'PUT', url: path(table) + '/api', headers: auth, payload: { enabledOperations: ['get', 'list', 'create', 'update', 'delete'], expectedAppliedRevision: table.appliedRevision, expectedConfigRevision: 0 } }); assert.equal(response.statusCode, 200, response.body);
  }
  async function publish(table: TableRecord, recordId: string, resource: string) {
    const definition: WorkflowDefinition = { auth: 'key_only', input: {}, steps: [
      { id: randomUUID(), name: 'read', type: 'query', tableId: table.id, access: { mode: 'key_only' }, select: ['id'], idValue: { kind: 'literal', value: recordId }, onMissing: '404' },
      { id: randomUUID(), name: 'done', type: 'response', status: 204 },
    ] };
    const created = await app.inject({ method: 'POST', url: base + '/workflows', headers: auth, payload: { path: resource, definition } }); assert.equal(created.statusCode, 201, created.body);
    const flowPath = base + '/workflows/' + created.json().id;
    const preview = await app.inject({ method: 'POST', url: flowPath + '/preview', headers: auth }); assert.equal(preview.statusCode, 200, preview.body);
    const response = await app.inject({ method: 'POST', url: flowPath + '/publish', headers: auth, payload: { expectedDraftRevision: 1, definitionHash: preview.json().definitionHash } }); assert.equal(response.statusCode, 200, response.body);
    const enabled = await app.inject({ method: 'PATCH', url: flowPath, headers: auth, payload: { expectedDraftRevision: 1, enabled: true } }); assert.equal(enabled.statusCode, 200, enabled.body);
  }
  let products = await apply(await draft('products', [{ name: 'category', type: 'integer' }, { name: 'sku', type: 'uuid' }, { name: 'title', type: 'text' }]));
  await enable(products);
  const sku = randomUUID();
  const created = await runtime('POST', 'products', { category: 1, sku, title: null }); assert.equal(created.statusCode, 201, created.body);
  const recordId = created.json().id;
  const category = products.fields.find((field) => field.name === 'category')!.id;
  const skuId = products.fields.find((field) => field.name === 'sku')!.id;
  const titleId = products.fields.find((field) => field.name === 'title')!.id;
  await t.test('normal index changes physical state only, preserves Docs, CRUD, list and workflow', async () => {
    const drafted = await edit(products, inputFields(products), [{ fieldIds: [category], unique: false }]);
    products = await edit(drafted, inputFields(drafted), []);
    assert.equal(products.indexes!.length, 0); assert.equal(products.appliedRevision, 1);
    await publish(products, recordId, 'read-products');
    const docsBefore = (await app.inject({ url: base + '/openapi', headers: auth })).json();
    const before = await runtime('GET', 'products?filter[category]=1&sort=category&limit=1');
    const logical = products.appliedRevision;
    products = await edit(products, inputFields(products), [{ fieldIds: [category, skuId], unique: false }]);
    assert.equal((await runtime('GET', 'products/' + recordId)).statusCode, 200);
    products = await apply(products);
    assert.equal(products.appliedRevision, logical); assert.equal(products.appliedPhysicalRevision, products.draftRevision);
    assert.equal((products.appliedDefinition!.catalog as { version: number }).version, 3);
    assert.deepEqual((await runtime('GET', 'products?filter[category]=1&sort=category&limit=1')).json(), before.json());
    assert.deepEqual((await app.inject({ url: base + '/openapi', headers: auth })).json(), docsBefore);
    assert.equal((await runtime('POST', 'read-products', {})).statusCode, 204);
    const reloaded = await new PostgresSchemaRepository(db).get(project.id, owner, products.id);
    assert.deepEqual(reloaded.indexes, products.indexes);
  });
  await t.test('unique index advances both revisions, stales workflow, maps conflicts safely and permits NULL keys', async () => {
    products = await edit(products, inputFields(products), [...inputIndexes(products), { fieldIds: [skuId], unique: true }]); products = await apply(products);
    assert.equal(products.appliedRevision, products.draftRevision); assert.equal(products.appliedPhysicalRevision, products.draftRevision);
    assert.equal((await runtime('POST', 'read-products', {})).statusCode, 503);
    const [oldFlow] = await db.select().from(workflowEndpoints).where(eq(workflowEndpoints.path, 'read-products'));
    await db.update(workflowEndpoints).set({ enabled: false }).where(eq(workflowEndpoints.id, oldFlow!.id));
    const duplicate = await runtime('POST', 'products', { sku }); assert.equal(duplicate.statusCode, 409, duplicate.body); assert.equal(duplicate.json().code, 'VALUE_CONFLICT');
    assert.ok(!duplicate.body.includes(sku)); assert.ok(!duplicate.body.includes('ix_usr_'));
    for (let i = 0; i < 2; i++) assert.equal((await runtime('POST', 'products', { sku: null })).statusCode, 201);
  });
  await t.test('duplicate existing data blocks composite unique before DDL and preserves applied state/workflow', async () => {
    const item = await apply(await draft('duplicates', [{ name: 'left_key', type: 'integer' }, { name: 'right_key', type: 'integer' }])); await enable(item);
    await runtime('POST', 'duplicates', { left_key: 1, right_key: 2 }); await runtime('POST', 'duplicates', { left_key: 1, right_key: 2 });
    const first = (await runtime('GET', 'duplicates')).json().data[0].id; await publish(item, first, 'read-duplicates');
    const candidate = await edit(item, inputFields(item), [{ fieldIds: item.fields.map((field) => field.id), unique: true }]);
    const failed = await apply(candidate, 422); assert.equal(failed.appliedRevision, item.appliedRevision); assert.equal(failed.appliedPhysicalRevision, item.appliedPhysicalRevision);
    assert.equal((await runtime('POST', 'read-duplicates', {})).statusCode, 204);
    assert.equal((await customer.query('SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2', [schema, indexName(candidate.indexes![0]!.id)])).rowCount, 0);
    assert.equal((await runtime('POST', 'duplicates', { left_key: 1, right_key: 2 })).statusCode, 201);
  });
  await t.test('requiredness is draft-isolated; NULL failure preserves contract; successful Apply updates Docs and stales workflow', async () => {
    await publish(products, recordId, 'read-before-required');
    const before = (await app.inject({ url: base + '/openapi', headers: auth })).json();
    products = await edit(products, inputFields(products).map((field) => field.id === titleId ? { ...field, nullable: false } : field));
    assert.deepEqual((await app.inject({ url: base + '/openapi', headers: auth })).json(), before);
    const oldLogical = products.appliedRevision; products = await apply(products, 422); assert.equal(products.appliedRevision, oldLogical);
    assert.equal((await runtime('POST', 'read-before-required', {})).statusCode, 204);
    await customer.query(`UPDATE ${q(schema)}.products SET title=$1 WHERE title IS NULL`, ['Filled']);
    products = await apply(products); assert.equal(products.appliedRevision, products.draftRevision);
    assert.equal((await runtime('POST', 'products', {})).statusCode, 400);
    assert.equal((await runtime('POST', 'products', { title: null })).statusCode, 400);
    assert.equal((await runtime('PATCH', 'products/' + recordId, { category: 7 })).statusCode, 200);
    assert.equal((await runtime('PATCH', 'products/' + recordId, { title: null })).statusCode, 400);
    assert.equal((await runtime('POST', 'read-before-required', {})).statusCode, 503);
    const [oldRequiredFlow] = await db.select().from(workflowEndpoints).where(eq(workflowEndpoints.path, 'read-before-required'));
    await db.update(workflowEndpoints).set({ enabled: false }).where(eq(workflowEndpoints.id, oldRequiredFlow!.id));
    const docs = (await app.inject({ url: base + '/openapi', headers: auth })).json();
    assert.ok(docs.paths['/products'].post.requestBody.content['application/json'].schema.required.includes('title'));
  });
  await t.test('cold-process restart reloads applied indexes, revisions, constraints and runtime', async () => {
    const processResult = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/inspect-managed-restart.ts'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, RESTART_PROJECT: project.id, RESTART_OWNER: owner, RESTART_TABLE: products.id, RESTART_SLUG: project.slug, RESTART_KEY: bearer.authorization.slice('Bearer '.length) },
    });
    assert.equal(processResult.status, 0, processResult.stderr);
    assert.deepEqual(JSON.parse(processResult.stdout), { status: 200, indexCount: 2, appliedRevision: products.appliedRevision, appliedPhysicalRevision: products.appliedPhysicalRevision, titleNullable: false });
  });
  await t.test('initial normal/composite unique indexes and distinct-null semantics', async () => {
    let item = await draft('initial_indexes', [{ name: 'a_key', type: 'integer' }, { name: 'b_key', type: 'integer' }, { name: 'counter', type: 'bigint' }]);
    item = await edit(item, inputFields(item), [{ fieldIds: [item.fields[0]!.id, item.fields[1]!.id], unique: true }, { fieldIds: [item.fields[2]!.id], unique: false }]);
    item = await apply(item); await enable(item);
    for (const payload of [{ a_key: null, b_key: 1 }, { a_key: null, b_key: 1 }, { a_key: 1, b_key: null }, { a_key: 1, b_key: null }, { a_key: 1, b_key: 2 }]) assert.equal((await runtime('POST', 'initial_indexes', payload)).statusCode, 201);
    assert.equal((await runtime('POST', 'initial_indexes', { a_key: 1, b_key: 2 })).statusCode, 409);
    assert.equal(item.appliedRevision, item.appliedPhysicalRevision);
  });
  await t.test('legacy relationship sources resolve v3 targets and retain expansion after their own v3 Apply', async () => {
    let source = await apply(await draft('mixed_relationships', [
      { name: 'product_id', type: 'uuid', relationship: { tableId: products.id, onDelete: 'restrict' } },
      { name: 'active', type: 'boolean' },
    ]));
    assert.equal((source.appliedDefinition!.catalog as { version: number }).version, 2);
    await enable(source);
    const row = await runtime('POST', source.name, { product_id: recordId, active: true });
    assert.equal(row.statusCode, 201, row.body);
    const expanded = await runtime('GET', `${source.name}/${row.json().id}?include=product_id`);
    assert.equal(expanded.statusCode, 200, expanded.body);
    assert.equal(expanded.json()._related.product_id.id, recordId);
    const logical = source.appliedRevision;
    source = await apply(await edit(source, inputFields(source), [{ fieldIds: [source.fields.find((field) => field.name === 'active')!.id], unique: false }]));
    assert.equal(source.appliedRevision, logical);
    assert.equal((source.appliedDefinition!.catalog as { version: number }).version, 3);
    const after = await runtime('GET', `${source.name}/${row.json().id}?include=product_id`);
    assert.equal(after.statusCode, 200, after.body);
    assert.deepEqual(after.json(), expanded.json());
  });
  await t.test('changed/missing/user/external index and removed NOT NULL fail closed', async () => {
    const index = products.indexes!.find((index) => !index.unique)!; const name = indexName(index.id);
    const assertUnavailable = async () => { const response = await runtime('GET', 'products'); assert.equal(response.statusCode, 503, response.body); assert.equal(response.json().code, 'RUNTIME_UNAVAILABLE'); };
    await customer.query(`DROP INDEX ${q(schema)}.${q(name)}`); await assertUnavailable();
    await customer.query(`CREATE INDEX ${q(name)} ON ${q(schema)}.products (sku,category)`); await assertUnavailable();
    await customer.query(`DROP INDEX ${q(schema)}.${q(name)}`);
    await customer.query(`CREATE INDEX ${q(name)} ON ${q(schema)}.products (category,sku)`);
    await customer.query(`ALTER TABLE ${q(schema)}.products ALTER COLUMN title DROP NOT NULL`); await assertUnavailable();
    await customer.query(`ALTER TABLE ${q(schema)}.products ALTER COLUMN title SET NOT NULL`);
    await customer.query(`CREATE INDEX unexpected_index ON ${q(schema)}.products (category)`); await assertUnavailable();
    await customer.query(`DROP INDEX ${q(schema)}.unexpected_index`);
    for (const statement of [
      `CREATE UNIQUE INDEX ${q(name)} ON ${q(schema)}.products (category,sku)`,
      `CREATE INDEX ${q(name)} ON ${q(schema)}.products USING hash (category)`,
      `CREATE INDEX ${q(name)} ON ${q(schema)}.products (category DESC,sku)`,
      `CREATE INDEX ${q(name)} ON ${q(schema)}.products ((category+0),sku)`,
      `CREATE INDEX ${q(name)} ON ${q(schema)}.products (category,sku) WHERE category IS NOT NULL`,
      `CREATE INDEX ${q(name)} ON ${q(schema)}.products (category,sku) INCLUDE (title)`,
    ]) {
      await customer.query(`DROP INDEX ${q(schema)}.${q(name)}`); await customer.query(statement); await assertUnavailable();
      await customer.query(`DROP INDEX ${q(schema)}.${q(name)}`); await customer.query(`CREATE INDEX ${q(name)} ON ${q(schema)}.products (category,sku)`);
    }
    for (const flag of ['indisvalid', 'indisready']) {
      try { await customer.query(`UPDATE pg_catalog.pg_index SET ${flag}=false WHERE indexrelid=$1::regclass`, [`${q(schema)}.${q(name)}`]); await assertUnavailable(); }
      finally { await customer.query(`UPDATE pg_catalog.pg_index SET ${flag}=true WHERE indexrelid=$1::regclass`, [`${q(schema)}.${q(name)}`]); }
    }
    assert.equal((await runtime('GET', 'products')).statusCode, 200);
  });
  await t.test('index and requiredness PRE/POST/DIVERGED reconciliation never replays uncertain DDL', async () => {
    for (const kind of ['normal', 'unique', 'required'] as const) for (const outcome of ['PRE_STATE', 'POST_STATE', 'DIVERGED'] as const) {
      let item = await apply(await draft(`recover_${kind}_${outcome.toLowerCase()}`, [{ name: 'value_key', type: 'integer' }]));
      item = await edit(item, kind === 'required' ? inputFields(item).map((field) => ({ ...field, nullable: false })) : inputFields(item), kind !== 'required' ? [{ fieldIds: [item.fields[0]!.id], unique: kind === 'unique' }] : []);
      const plan = generatePlan(item, await repository.list(project.id, owner)); const operationId = await repository.begin(project.id, owner, item.id, plan);
      if (outcome !== 'PRE_STATE') await createSchemaExecutor(undefined, encryption)(config, { ...plan, receipt: { projectId: project.id, operationId } }, item.appliedDefinition);
      if (outcome === 'DIVERGED') await customer.query(`ALTER TABLE ${q(schema)}.${q(item.name)} ADD COLUMN unrelated text`);
      assert.equal((await reconcile(db, encryption, project.id, operationId, 'schema')).classification, outcome);
      await reconcile(db, encryption, project.id, operationId, 'schema', true);
      if (outcome === 'DIVERGED') {
        await customer.query(`ALTER TABLE ${q(schema)}.${q(item.name)} DROP COLUMN unrelated`);
        await reconcile(db, encryption, project.id, operationId, 'schema', true);
      }
      const after = await repository.get(project.id, owner, item.id);
      if (outcome !== 'PRE_STATE') { assert.equal(after.appliedPhysicalRevision, item.draftRevision); assert.equal(after.appliedRevision, kind === 'normal' ? item.appliedRevision : item.draftRevision); }
    }
  });
  await t.test('exclusive locking prevents concurrent duplicate and NULL writes between precheck and DDL', async () => {
    for (const kind of ['unique', 'required'] as const) {
      let item = await apply(await draft('race_' + kind, [{ name: 'value_key', type: 'integer' }]));
      await customer.query(`INSERT INTO ${q(schema)}.${q(item.name)} (value_key) VALUES ($1)`, [1]);
      item = await edit(item, kind === 'required' ? inputFields(item).map((field) => ({ ...field, nullable: false })) : inputFields(item), kind === 'unique' ? [{ fieldIds: [item.fields[0]!.id], unique: true }] : []);
      let entered!: () => void; let release!: () => void;
      const reached = new Promise<void>((resolve) => { entered = resolve; }); const barrier = new Promise<void>((resolve) => { release = resolve; });
      const calls: string[] = [];
      const executor = createSchemaExecutor((options) => {
        const raw = boundedClient(options, 'schema'); return { ...raw, connect: () => raw.connect(), end: () => raw.end(), on: (event, listener) => raw.on(event, listener), query: async (sql, values) => {
          calls.push(sql); const result = await raw.query(sql, values);
          if (sql.startsWith('SELECT 1 FROM ONLY')) { entered(); await barrier; } return result;
        } };
      }, encryption);
      const service = new SchemaService(repository, connectionRepository, encryption, executor);
      const plan = generatePlan(item, await repository.list(project.id, owner));
      const pending = service.apply(project.id, owner, item.id, item.draftRevision, plan.hash); await reached;
      const writer = new pg.Client({ connectionString: url.toString() }); await writer.connect();
      try {
        await writer.query("SET lock_timeout='200ms'");
        await assert.rejects(writer.query(`INSERT INTO ${q(schema)}.${q(item.name)} (value_key) VALUES ($1)`, [kind === 'unique' ? 1 : null]), { code: '55P03' });
        assert.ok(!calls.some((sql) => /^(CREATE (UNIQUE )?INDEX|ALTER TABLE)/.test(sql)));
      } finally { release(); await pending; await writer.end(); }
      await assert.rejects(customer.query(`INSERT INTO ${q(schema)}.${q(item.name)} (value_key) VALUES ($1)`, [kind === 'unique' ? 1 : null]), { code: kind === 'unique' ? '23505' : '23502' });
      assert.ok(!calls.some((sql) => /^(INSERT|UPDATE|DELETE) /.test(sql)));
    }
  });
  await t.test('lost commit acknowledgements for index and NOT NULL reconcile authenticated POST without replay', async () => {
    for (const kind of ['index', 'required'] as const) {
      let item = await apply(await draft('uncertain_' + kind, [{ name: 'value_key', type: 'integer' }]));
      item = await edit(item, kind === 'required' ? inputFields(item).map((field) => ({ ...field, nullable: false })) : inputFields(item), kind === 'index' ? [{ fieldIds: [item.fields[0]!.id], unique: false }] : []);
      const executor = createSchemaExecutor((options) => {
        const raw = boundedClient(options, 'schema'); return { ...raw, connect: () => raw.connect(), end: () => raw.end(), on: (event, listener) => raw.on(event, listener), query: async (sql, values) => {
          const result = await raw.query(sql, values); if (sql === 'COMMIT') throw new Error('lost commit response'); return result;
        } };
      }, encryption);
      const service = new SchemaService(repository, connectionRepository, encryption, executor);
      const plan = generatePlan(item, await repository.list(project.id, owner));
      await assert.rejects(service.apply(project.id, owner, item.id, item.draftRevision, plan.hash), { code: 'SCHEMA_OUTCOME_UNKNOWN' });
      const uncertain = await repository.get(project.id, owner, item.id);
      assert.equal(uncertain.appliedPhysicalRevision, item.appliedPhysicalRevision);
      const operationId = uncertain.applyStatus!.migrationId;
      assert.equal((await reconcile(db, encryption, project.id, operationId, 'schema', true)).classification, 'POST_STATE');
    }
  });
  await t.test('DDL rollback and real lock timeout preserve both revisions and release admission', async () => {
    let item = await apply(await draft('rollback_index', [{ name: 'value_key', type: 'integer' }]));
    item = await edit(item, inputFields(item), [{ fieldIds: [item.fields[0]!.id], unique: false }]);
    const executor = createSchemaExecutor((options) => {
      const raw = boundedClient(options, 'schema'); return { ...raw, connect: () => raw.connect(), end: () => raw.end(), on: (event, listener) => raw.on(event, listener), query: async (sql, values) => {
        const result = await raw.query(sql, values); if (sql.startsWith('CREATE INDEX')) throw new Error('injected failure after DDL'); return result;
      } };
    }, encryption);
    const service = new SchemaService(repository, connectionRepository, encryption, executor);
    const plan = generatePlan(item, await repository.list(project.id, owner));
    await assert.rejects(service.apply(project.id, owner, item.id, item.draftRevision, plan.hash), { code: 'SCHEMA_APPLY_FAILED' });
    assert.equal((await customer.query('SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2', [schema, indexName(item.indexes![0]!.id)])).rowCount, 0);
    const old = await repository.get(project.id, owner, item.id); assert.equal(old.appliedPhysicalRevision, item.appliedPhysicalRevision);
    await customer.query('BEGIN'); await customer.query(`LOCK TABLE ${q(schema)}.${q(item.name)} IN ACCESS EXCLUSIVE MODE`);
    try { await apply(old, 504); } finally { await customer.query('ROLLBACK'); }
    assert.equal(customerAdmission.snapshot().total, 0);
  });
  await t.test('initial managed-index creation recovery distinguishes absent, authenticated complete and partial states', async () => {
    for (const state of ['PRE_STATE', 'POST_STATE', 'DIVERGED'] as const) {
      let item = await draft('initial_recovery_' + state.toLowerCase(), [{ name: 'value_key', type: 'integer' }]);
      item = await edit(item, inputFields(item), [{ fieldIds: [item.fields[0]!.id], unique: false }]);
      const plan = generatePlan(item, await repository.list(project.id, owner));
      const operationId = await repository.begin(project.id, owner, item.id, plan);
      if (state !== 'PRE_STATE') await createSchemaExecutor(undefined, encryption)(config, { ...plan, receipt: { projectId: project.id, operationId } }, null);
      if (state === 'DIVERGED') await customer.query(`DROP INDEX ${q(schema)}.${q(indexName(item.indexes![0]!.id))}`);
      assert.equal((await reconcile(db, encryption, project.id, operationId, 'schema')).classification, state);
      if (state === 'DIVERGED') await customer.query(`CREATE INDEX ${q(indexName(item.indexes![0]!.id))} ON ${q(schema)}.${q(item.name)} (value_key)`);
      await reconcile(db, encryption, project.id, operationId, 'schema', true);
      await customer.query(`DROP TABLE IF EXISTS ${q(schema)}.${q(item.name)}`);
      await db.delete(schemaTables).where(eq(schemaTables.id, item.id));
    }
  });
  await t.test('bounded local Apply measurements and data preservation at 0/1k/10k/100k rows', async () => {
    for (const rows of [0, 1000, 10000, 100000]) for (const operation of ['normal', 'unique', 'required'] as const) {
      let item = await apply(await draft(`bench_${operation}_${rows}`, [{ name: 'value_key', type: 'integer' }]));
      if (rows) await customer.query(`INSERT INTO ${q(schema)}.${q(item.name)} (value_key) SELECT value FROM generate_series(1,$1) value`, [rows]);
      item = await edit(item, operation === 'required' ? inputFields(item).map((field) => ({ ...field, nullable: false })) : inputFields(item), operation !== 'required' ? [{ fieldIds: [item.fields[0]!.id], unique: operation === 'unique' }] : []);
      let validationMs = 0, ddlMs = 0, lockMs = 0;
      const executor = createSchemaExecutor((options) => {
        const raw = boundedClient(options, 'schema'); return { ...raw, connect: () => raw.connect(), end: () => raw.end(), on: (event, listener) => raw.on(event, listener), query: async (sql, values) => {
          const begin = performance.now(); const result = await raw.query(sql, values); const duration = performance.now() - begin;
          if (sql.startsWith('SELECT 1 FROM ONLY')) validationMs += duration;
          if (/^(CREATE (UNIQUE )?INDEX|ALTER TABLE)/.test(sql)) ddlMs += duration;
          if (sql.startsWith('LOCK TABLE')) lockMs += duration;
          return result;
        } };
      }, encryption);
      const service = new SchemaService(repository, connectionRepository, encryption, executor);
      const plan = generatePlan(item, await repository.list(project.id, owner)); const started = performance.now();
      await service.apply(project.id, owner, item.id, item.draftRevision, plan.hash);
      const totalMs = performance.now() - started;
      const indexBytes = operation === 'required' ? null : (await customer.query('SELECT pg_relation_size($1::regclass)::text AS bytes', [`${q(schema)}.${q(indexName(item.indexes![0]!.id))}`])).rows[0].bytes;
      assert.equal(Number((await customer.query(`SELECT count(*) AS count FROM ${q(schema)}.${q(item.name)}`)).rows[0].count), rows);
      assert.equal(customerAdmission.snapshot().total, 0);
      console.log(JSON.stringify({ benchmark: 'managed-schema', rows, operation, validationMs, ddlMs, lockMs, totalMs, indexBytes, admissionAfter: customerAdmission.snapshot().total }));
      await customer.query(`DROP TABLE ${q(schema)}.${q(item.name)}`);
      await db.delete(schemaTables).where(eq(schemaTables.id, item.id));
    }
  });
  assert.equal(customerAdmission.snapshot().total, 0);
});
