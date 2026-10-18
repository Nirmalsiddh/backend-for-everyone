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
import { databaseConnections, projects, schemaFields, schemaMigrations, schemaTables, users } from '../../src/database/platform-db/schema.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { createSchemaExecutor } from '../../src/database/customer-db/schema-executor.js';
import { generatePlan, quoteIdentifier } from '../../src/modules/schema-builder/plan.js';
import { CredentialEncryption } from '../../src/security/encryption.js';
import { SchemaService } from '../../src/modules/schema-builder/service.js';
import { SchemaError } from '../../src/modules/schema-builder/errors.js';
import type { FieldDefinition, FieldInput, SchemaExecutor } from '../../src/modules/schema-builder/types.js';
import { auth, env } from '../helpers.js';

const fieldInput = ({ position: _position, default: def, ...field }: FieldDefinition): FieldInput => ({ ...field, ...(def ? { default: def } : {}) });
test('Schema Builder real PostgreSQL management lifecycle', async (t) => {
  const platformUrl = parseDatabaseUrl(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
  const customerUrl = new URL(parseDatabaseUrl(process.env.TEST_CUSTOMER_DATABASE_URL, 'TEST_CUSTOMER_DATABASE_URL'));
  if (platformUrl === process.env.PLATFORM_DATABASE_URL || new URL(platformUrl).toString() === customerUrl.toString()) throw new Error('Use separate disposable databases');
  const { db, pool } = createPlatformDatabase(platformUrl);
  const customer = new pg.Client({ connectionString: customerUrl.toString() });
  await customer.connect();
  const ownerId = randomUUID(); const otherOwnerId = randomUUID();
  const schema = `sb_${randomUUID().replaceAll('-', '')}`;
  const projectIds: string[] = [];
  t.after(async () => {
    try {
      await customer.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      if (projectIds.length) {
        await db.delete(schemaTables).where(inArray(schemaTables.projectId, projectIds));
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
  const project = await projectRepository.create(ownerId, { name: 'Schema test', slug: `schema-${randomUUID()}` }); projectIds.push(project.id);
  const otherProject = await projectRepository.create(otherOwnerId, { name: 'Other test', slug: `schema-${randomUUID()}` }); projectIds.push(otherProject.id);
  const connectionRepository = new PostgresConnectionRepository(db);
  const repository = new PostgresSchemaRepository(db);
  let pause: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const realExecutor = createSchemaExecutor();
  const executor: SchemaExecutor = async (...args) => { entered?.(); if (pause) await pause; return realExecutor(...args); };
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository(ownerId), env, projectRepository, connectionRepository, schemaRepository: repository, schemaExecutor: executor, logger: false });
  const otherApp = buildApp({ platformAuthRepository: memoryPlatformAuthRepository(otherOwnerId), env, projectRepository, connectionRepository, schemaRepository: repository, logger: false });
  t.after(async () => { await app.close(); await otherApp.close(); });
  const base = `/internal/projects/${project.id}/schema`;
  const connectionPath = `/internal/projects/${project.id}/database-connection`;
  const config = { host: customerUrl.hostname, port: Number(customerUrl.port || 5432), database: decodeURIComponent(customerUrl.pathname.slice(1)),
    username: decodeURIComponent(customerUrl.username), password: decodeURIComponent(customerUrl.password), schema, ssl: false };
  const connected = await app.inject({ method: 'POST', url: connectionPath, headers: auth, payload: { ...config, label: 'Schema fixture' } });
  assert.equal(connected.statusCode, 201, connected.body);
  let tableId = ''; let tablePath = ''; let fields: FieldInput[] = [];
  const sensitiveDefault = "x'); DROP TABLE unrelated; --\\quoted";
  const safe = (body: string) => {
    for (const secret of [config.password, 'encryptedConfig', 'encryptionIv', 'encryptionTag', env.connectionEncryptionKey]) {
      if (secret) assert.ok(!body.includes(secret), 'Secret appeared in response');
    }
  };
  await t.test('create and edit drafts, strict identifiers and request validation', async () => {
    for (const name of ['id', 'pg_users', 'a.b', 'a"b', 'a--b', 'Bad', 'a b', 'x'.repeat(64)]) {
      const response = await app.inject({ method: 'POST', url: `${base}/tables`, headers: auth, payload: { name, fields: [] } });
      assert.equal(response.statusCode, 400, response.body);
    }
    fields = [
      { name: 'sku', type: 'text', nullable: false, unique: true },
      { name: 'title', type: 'varchar', options: { length: 200 }, default: { kind: 'literal', value: sensitiveDefault } },
      { name: 'quantity', type: 'integer', default: { kind: 'literal', value: 3 } },
      { name: 'large_count', type: 'bigint', default: { kind: 'literal', value: '9223372036854775807' } },
      { name: 'price', type: 'decimal', options: { precision: 12, scale: 2 }, default: { kind: 'literal', value: '1234567890.12' } },
      { name: 'active', type: 'boolean', default: { kind: 'literal', value: false } },
      { name: 'external_id', type: 'uuid', default: { kind: 'literal', value: randomUUID() } },
      { name: 'birthday', type: 'date', default: { kind: 'literal', value: '2024-02-29' } },
      { name: 'created_at', type: 'timestamp', default: { kind: 'current_timestamp' } },
      { name: 'settings', type: 'jsonb', default: { kind: 'literal', value: { title: sensitiveDefault } } },
    ];
    const created = await app.inject({ method: 'POST', url: `${base}/tables`, headers: auth, payload: { name: 'draft_products', fields } });
    assert.equal(created.statusCode, 201, created.body); safe(created.body);
    tableId = created.json().id; tablePath = `${base}/tables/${tableId}`;
    fields = created.json().fields.map(fieldInput);
    assert.equal(created.json().draftRevision, 1);
    const updated = await app.inject({ method: 'PUT', url: `${tablePath}/draft`, headers: auth, payload: { name: 'products', fields, expectedDraftRevision: 1 } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().draftRevision, 2);
    assert.equal(updated.json().fields[0].id, fields[0]?.id);
    assert.equal((await app.inject({ method: 'PUT', url: `${tablePath}/draft`, headers: auth, payload: { name: 'products', fields, expectedDraftRevision: 1 } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/tables`, headers: auth, payload: { name: 'products', fields: [] } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/tables`, headers: auth, payload: { name: 'unsafe', fields: [{ name: 'value', type: 'text', default: { kind: 'sql', value: 'now()' } }] } })).statusCode, 400);
    assert.equal((await app.inject({ url: base, headers: auth })).json().length, 1);
    assert.equal((await app.inject({ url: tablePath })).statusCode, 401);
    assert.equal((await app.inject({ method: 'DELETE', url: connectionPath, headers: auth })).statusCode, 409);
    assert.equal((await app.inject({ method: 'PUT', url: connectionPath, headers: auth, payload: { ...config, label: 'Changed' } })).statusCode, 409);
  });
  await t.test('ownership isolation for every management route', async () => {
    const operations = [
      { method: 'GET' as const, url: base }, { method: 'GET' as const, url: tablePath },
      { method: 'POST' as const, url: `${base}/tables`, payload: { name: 'stolen', fields: [] } },
      { method: 'PUT' as const, url: `${tablePath}/draft`, payload: { name: 'products', fields, expectedDraftRevision: 2 } },
      { method: 'DELETE' as const, url: tablePath }, { method: 'POST' as const, url: `${tablePath}/preview` },
      { method: 'POST' as const, url: `${tablePath}/apply`, payload: { expectedDraftRevision: 2, planHash: '0'.repeat(64) } },
    ];
    for (const operation of operations) {
      const response = await otherApp.inject({ ...operation, headers: auth });
      assert.equal(response.statusCode, 404, response.body); safe(response.body);
    }
    const otherPath = `/internal/projects/${otherProject.id}/schema/tables/${tableId}`;
    assert.equal((await otherApp.inject({ url: otherPath, headers: auth })).statusCode, 404);
    await assert.rejects(repository.get(project.id, otherOwnerId, tableId), { statusCode: 404 });
  });
  await t.test('preview is deterministic and read-only; apply checks revision and supplied SQL is rejected', async () => {
    const preview = await app.inject({ method: 'POST', url: `${tablePath}/preview`, headers: auth });
    assert.equal(preview.statusCode, 200, preview.body); safe(preview.body);
    assert.match(preview.json().sql, new RegExp(`CREATE TABLE "${schema}"\\."products"`));
    assert.deepEqual(preview.json(), (await app.inject({ method: 'POST', url: `${tablePath}/preview`, headers: auth })).json());
    assert.equal((await customer.query('SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname=$1 AND tablename=$2', [schema, 'products'])).rowCount, 0);
    assert.equal((await db.select().from(schemaMigrations).where(eq(schemaMigrations.tableId, tableId))).length, 0);
    for (const payload of [{ expectedDraftRevision: 1, planHash: preview.json().planHash }, { expectedDraftRevision: 2, planHash: '0'.repeat(64) }]) {
      assert.equal((await app.inject({ method: 'POST', url: `${tablePath}/apply`, headers: auth, payload })).statusCode, 409);
    }
    assert.equal((await app.inject({ method: 'POST', url: `${tablePath}/apply`, headers: auth, payload: { expectedDraftRevision: 2, planHash: preview.json().planHash, sql: 'DROP TABLE users' } })).statusCode, 400);
    let release!: () => void;
    pause = new Promise<void>((resolve) => { release = resolve; });
    const arrived = new Promise<void>((resolve) => { entered = resolve; });
    const pending = app.inject({ method: 'POST', url: `${tablePath}/apply`, headers: auth, payload: { expectedDraftRevision: 2, planHash: preview.json().planHash } });
    const responsePromise = pending.then((response) => response);
    await arrived;
    try {
      assert.equal((await app.inject({ method: 'POST', url: `${tablePath}/apply`, headers: auth, payload: { expectedDraftRevision: 2, planHash: preview.json().planHash } })).statusCode, 409);
      assert.equal((await app.inject({ method: 'PUT', url: `${tablePath}/draft`, headers: auth, payload: { name: 'products', fields, expectedDraftRevision: 2 } })).statusCode, 409);
    } finally { pause = undefined; entered = undefined; release(); }
    const response = await responsePromise;
    assert.equal(response.statusCode, 200, response.body); safe(response.body);
    assert.equal(response.json().table.appliedRevision, 2);
    assert.equal((await db.select().from(schemaMigrations).where(eq(schemaMigrations.tableId, tableId)))[0]?.status, 'applied');
  });
  await t.test('real UUID primary key, types, safe defaults, NOT NULL and UNIQUE constraints', async () => {
    const target = `${quoteIdentifier(schema)}."products"`;
    await assert.rejects(customer.query(`INSERT INTO ${target} DEFAULT VALUES`), { code: '23502' });
    const { rows: [row] } = await customer.query(`INSERT INTO ${target} (sku) VALUES ($1) RETURNING *`, ['first']);
    assert.match(row.id, /^[a-f0-9-]{36}$/); assert.equal(row.title, sensitiveDefault);
    assert.equal(row.quantity, 3); assert.equal(row.large_count, '9223372036854775807'); assert.equal(row.price, '1234567890.12');
    assert.equal(row.active, false); assert.deepEqual(row.settings, { title: sensitiveDefault }); assert.ok(row.created_at instanceof Date);
    await assert.rejects(customer.query(`INSERT INTO ${target} (sku) VALUES ($1)`, ['first']), { code: '23505' });
    const { rows: [second] } = await customer.query(`INSERT INTO ${target} (sku) VALUES ($1) RETURNING id`, ['second']);
    assert.notEqual(second.id, row.id);
    await assert.rejects(customer.query(`INSERT INTO ${target} (id, sku) VALUES ($1, $2)`, [row.id, 'third']), { code: '23505' });
    assert.equal((await app.inject({ method: 'DELETE', url: tablePath, headers: auth })).statusCode, 409);
  });
  await t.test('destructive edits rejected; nullable addition preserves rows', async () => {
    const badFields = [fields.slice(1), fields.map((field, index) => index ? field : { ...field, name: 'renamed' }),
      fields.map((field, index) => index ? field : { ...field, type: 'integer' }),
      fields.map((field, index) => index ? field : { ...field, nullable: true }),
      [...fields, { name: 'notes', type: 'text', nullable: false }], [...fields, { name: 'notes', type: 'text', unique: true }],
      [...fields, { name: 'notes', type: 'text', default: { kind: 'literal', value: 'x' } }]];
    for (const candidate of badFields) assert.equal((await app.inject({ method: 'PUT', url: `${tablePath}/draft`, headers: auth, payload: { name: 'products', fields: candidate, expectedDraftRevision: 2 } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'PUT', url: `${tablePath}/draft`, headers: auth, payload: { name: 'renamed', fields, expectedDraftRevision: 2 } })).statusCode, 409);
    const updated = await app.inject({ method: 'PUT', url: `${tablePath}/draft`, headers: auth, payload: { name: 'products', fields: [...fields, { name: 'notes', type: 'text' }], expectedDraftRevision: 2 } });
    assert.equal(updated.statusCode, 200, updated.body);
    const preview = (await app.inject({ method: 'POST', url: `${tablePath}/preview`, headers: auth })).json();
    assert.match(preview.sql, /ADD COLUMN "notes" pg_catalog.text/);
    const applied = await app.inject({ method: 'POST', url: `${tablePath}/apply`, headers: auth, payload: { expectedDraftRevision: 3, planHash: preview.planHash } });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.deepEqual((await customer.query(`SELECT notes FROM ${quoteIdentifier(schema)}."products"`)).rows, [{ notes: null }, { notes: null }]);
    assert.equal((await app.inject({ method: 'POST', url: `${tablePath}/apply`, headers: auth, payload: { expectedDraftRevision: 3, planHash: preview.planHash } })).statusCode, 409);
  });
  await t.test('customer rollback leaves metadata unapplied and records a sanitized failure', async () => {
    const draft = await repository.create(project.id, ownerId, { name: 'rollback_items', fields: [] }, {
      connectionId: connected.json().id, encryptedConfig: (await connectionRepository.findOwned(project.id, ownerId))!.encryptedConfig, schemaName: schema,
    });
    const failingExecutor = createSchemaExecutor((options) => {
      const client = new pg.Client(options);
      return { connect: () => client.connect(), end: () => client.end(), on: (_event, listener) => client.on('error', listener),
        query: async (sql, values) => client.query(sql.includes('SELECT c.relkind') ? 'SELECT 1 / 0' : sql, values) };
    });
    const service = new SchemaService(repository, connectionRepository, new CredentialEncryption(env.connectionEncryptionKey), failingExecutor);
    const plan = generatePlan(draft);
    await assert.rejects(service.apply(project.id, ownerId, draft.id, 1, plan.hash), { code: 'SCHEMA_APPLY_FAILED' });
    assert.equal((await customer.query('SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname=$1 AND tablename=$2', [schema, 'rollback_items'])).rowCount, 0);
    assert.equal((await repository.get(project.id, ownerId, draft.id)).appliedRevision, null);
    const [migration] = await db.select().from(schemaMigrations).where(eq(schemaMigrations.tableId, draft.id));
    assert.equal(migration?.status, 'failed'); assert.equal(migration?.errorCode, 'SCHEMA_APPLY_FAILED');
    const publicState=await service.get(project.id,ownerId,draft.id);
    assert.equal(publicState.applyStatus?.status,'failed');
    assert.equal(publicState.applyStatus?.errorCode,'SCHEMA_APPLY_FAILED');
    assert.ok(!JSON.stringify(publicState).includes('catalog')); 
    await repository.delete(project.id, ownerId, draft.id);
  });
  await t.test('drift and existing tables block apply without adoption', async () => {
    await customer.query(`ALTER TABLE ${quoteIdentifier(schema)}."products" ADD COLUMN external_change text`);
    const current = await repository.get(project.id, ownerId, tableId);
    await repository.update(project.id, ownerId, tableId, 3, { name: 'products', fields: [...current.fields.map(fieldInput), { name: 'extra_notes', type: 'text' }] });
    const preview = (await app.inject({ method: 'POST', url: `${tablePath}/preview`, headers: auth })).json();
    const response = await app.inject({ method: 'POST', url: `${tablePath}/apply`, headers: auth, payload: { expectedDraftRevision: 4, planHash: preview.planHash } });
    assert.equal(response.statusCode, 409, response.body); safe(response.body);
    assert.equal((await repository.get(project.id, ownerId, tableId)).appliedRevision, 3);
    const created = (await app.inject({ method: 'POST', url: `${base}/tables`, headers: auth, payload: { name: 'existing_items', fields: [] } })).json();
    await customer.query(`CREATE TABLE ${quoteIdentifier(schema)}."existing_items" (untouched integer)`);
    const path = `${base}/tables/${created.id}`;
    const plan = (await app.inject({ method: 'POST', url: `${path}/preview`, headers: auth })).json();
    assert.equal((await app.inject({ method: 'POST', url: `${path}/apply`, headers: auth, payload: { expectedDraftRevision: 1, planHash: plan.planHash } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'DELETE', url: path, headers: auth })).statusCode, 204);
    assert.equal((await customer.query(`SELECT * FROM ${quoteIdentifier(schema)}."existing_items"`)).rowCount, 0);
  });
  await t.test('uncertain commit blocks mutation and does not advance applied metadata', async () => {
    const created = (await app.inject({ method: 'POST', url: `${base}/tables`, headers: auth, payload: { name: 'uncertain_items', fields: [] } })).json();
    const service = new SchemaService(repository, connectionRepository, new CredentialEncryption(env.connectionEncryptionKey), async () => { throw new SchemaError(503, 'SCHEMA_OUTCOME_UNKNOWN', 'Commit outcome unknown'); });
    const plan = generatePlan(await repository.get(project.id, ownerId, created.id));
    await assert.rejects(service.apply(project.id, ownerId, created.id, 1, plan.hash), { code: 'SCHEMA_OUTCOME_UNKNOWN' });
    assert.equal((await repository.get(project.id, ownerId, created.id)).appliedRevision, null);
    assert.equal((await db.select().from(schemaMigrations).where(eq(schemaMigrations.tableId, created.id)))[0]?.status, 'outcome_unknown');
    await assert.rejects(repository.delete(project.id, ownerId, created.id), { code: 'SCHEMA_CONFLICT' });
  });
  await t.test('platform metadata uniqueness and foreign key constraints', async () => {
    const fields = await db.select().from(schemaFields).where(eq(schemaFields.tableId, tableId));
    await assert.rejects(db.insert(schemaFields).values({ ...fields[0]!, id: randomUUID() }));
    await assert.rejects(db.delete(databaseConnections).where(eq(databaseConnections.projectId, project.id)));
  });
});
