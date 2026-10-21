import { WorkflowService } from '../../src/modules/workflows/service.js';
import { PostgresWorkflowRepository } from '../../src/modules/workflows/repository.js';
import type { WorkflowDefinition } from '../../src/modules/workflows/types.js';
import { PostgresEndpointRepository } from '../../src/modules/endpoints/repository.js';
import { PostgresDocsRepository } from '../../src/modules/api-docs/repository.js';
import { TypeScriptClientService } from '../../src/modules/typescript-client/service.js';
import { generate as openapi } from '../../src/modules/api-docs/service.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { users, projects, databaseConnections, schemaTables, workflowEndpoints } from '../../src/database/platform-db/schema.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { SchemaService } from '../../src/modules/schema-builder/service.js';
import { createSchemaExecutor } from '../../src/database/customer-db/schema-executor.js';
import { CredentialEncryption } from '../../src/security/encryption.js';
import { generateEvolutionPlan } from '../../src/modules/schema-builder/evolution.js';
import { generatePlan } from '../../src/modules/schema-builder/plan.js';
import { customerAdmission, boundedClient } from '../../src/database/customer-db/admission.js';
import { reconcile } from '../../src/operations/reconciliation.js';
import type { FieldInput, SchemaExecutor } from '../../src/modules/schema-builder/types.js';

// Real service/repository/transaction/receipt/finalization path. Values are synthetic fixtures.
test('v4 atomic fills, managed defaults, rollback and lost COMMIT acknowledgement without replay', async (t) => {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_CUSTOMER_DATABASE_URL) throw new Error('Explicit disposable databases required');
  const { db, pool } = createPlatformDatabase(process.env.TEST_DATABASE_URL);
  const url = new URL(process.env.TEST_CUSTOMER_DATABASE_URL);
  const customer = new pg.Client({ connectionString: url.toString() }); await customer.connect();
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)) });
  const owner = randomUUID(), schema = 'v12_' + randomUUID().replaceAll('-', '');
  const encryption = new CredentialEncryption('12'.repeat(32));
  await db.insert(users).values({ id: owner, email: owner + '@example.test' });
  const project = await new PostgresProjectRepository(db).create(owner, { name: 'Evolution', slug: 'v12-' + randomUUID() });
  t.after(async () => {
    await customer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.delete(workflowEndpoints).where(eq(workflowEndpoints.projectId, project.id));
    await db.delete(schemaTables).where(eq(schemaTables.projectId, project.id));
    await db.delete(databaseConnections).where(eq(databaseConnections.projectId, project.id));
    await db.delete(projects).where(eq(projects.id, project.id));
    await db.delete(users).where(eq(users.id, owner)); await customer.end(); await pool.end();
  });
  await customer.query(`CREATE SCHEMA "${schema}"`);
  const config = { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema, ssl: false };
  const connections = new PostgresConnectionRepository(db);
  // Connection repository accepts the same encrypted envelope used by management setup.
  const connectionId = randomUUID();
  await db.insert(databaseConnections).values({ id: connectionId, projectId: project.id, label: 'Disposable v12 fixture', lastTestStatus: 'success', lastTestedAt: new Date(), ...encryption.encrypt(config, `${project.id}:${connectionId}`) });
  const repository = new PostgresSchemaRepository(db);
  let loseAck = false;
  let failAt = '';
  let measurements: Record<string, number> | undefined;
  let pauseBeforeRequired: (() => Promise<void>) | undefined;
  const executor: SchemaExecutor = createSchemaExecutor((options) => {
    const raw = boundedClient(options, 'schema', 10000);
    let transactionStarted = 0;
    let requiredApplied = false;
    return { connect: () => raw.connect(), end: () => raw.end(), on: (event, listener) => raw.on(event, listener),
      async query(text, values) {
        if (pauseBeforeRequired && text.endsWith('SET NOT NULL')) await pauseBeforeRequired();
        if (failAt === 'NOT_NULL' && text.endsWith('SET NOT NULL')) { failAt = ''; throw new Error('synthetic constraint fault'); }
        if (failAt && text.startsWith(failAt)) { failAt = ''; throw new Error('synthetic executor fault'); }
        const start = performance.now();
        if (text === 'BEGIN') transactionStarted = start;
        const result = await raw.query(text, values).catch((error: unknown) => {
          if (measurements) {
            const category = text.startsWith('UPDATE ONLY') ? 'fillMs' : text.startsWith('LOCK ') ? 'lockWaitMs' : /^(ALTER |CREATE )/.test(text) ? 'ddlMs' : 'catalogReceiptMs';
            measurements[category] = (measurements[category] ?? 0) + performance.now() - start;
          }
          throw error;
        });
        if (text.endsWith('SET NOT NULL')) requiredApplied = true;
        if (failAt === 'POST_VERIFY' && requiredApplied && text.includes('SELECT a.attname, a.attnum')) { failAt = ''; for (const row of result.rows) if (row.attname === 'value_key') row.attnotnull = false; }
        if (measurements) {
          if (text === 'COMMIT' || text === 'ROLLBACK') measurements.customerTransactionMs = performance.now() - transactionStarted;
          const category = text.startsWith('LOCK ') ? 'lockWaitMs' : text.startsWith('UPDATE ONLY') ? 'fillMs' : /^(ALTER |CREATE )/.test(text) ? 'ddlMs' : text === 'ROLLBACK' ? 'rollbackMs' : 'catalogReceiptMs';
          measurements[category] = (measurements[category] ?? 0) + performance.now() - start;
          if (text.startsWith('UPDATE ONLY')) measurements.rowsAffected = (measurements.rowsAffected ?? 0) + (result.rowCount ?? 0);
        }
 if (loseAck && text === 'COMMIT') { loseAck = false; throw new Error('synthetic lost acknowledgement'); } return result; } };
  }, encryption);
  const service = new SchemaService(repository, connections, encryption, executor);
  const apply = async (id: string) => { const preview = await service.preview(project.id, owner, id); return service.apply(project.id, owner, id, preview.draftRevision, preview.planHash); };
  const update = async (id: string, fields: FieldInput[]) => { const table = await repository.get(project.id, owner, id); return service.update(project.id, owner, id, table.draftRevision, { name: table.name, fields, indexes: (table.indexes ?? []).map(({ specificationVersion: _, ...index }) => index) }); };
  const inputs = async (id: string): Promise<FieldInput[]> => (await repository.get(project.id, owner, id)).fields.map(({ position: _, default: def, ...field }) => ({ ...field, ...(def ? { default: def } : {}) }));
  let table = await service.create(project.id, owner, { name: 'records', fields: [{ name: 'status', type: 'text' }] }); await apply(table.id);
  const target = `"${schema}"."records"`;
  await new PostgresEndpointRepository(db).save(project.id, owner, table.id, { enabledOperations: ['create', 'get', 'list'], expectedAppliedRevision: 1, expectedConfigRevision: 0 });
  const docs = new PostgresDocsRepository(db);
  const sdk = new TypeScriptClientService(docs);
  const baselineSdk = await sdk.get(project.id, owner);

  await customer.query(`INSERT INTO ${target} (status) VALUES (NULL),('kept')`);
  await t.test('NULL without fill fails and publishes nothing; reviewed fill changes only NULL', async () => {
    let fields = await inputs(table.id); fields[0] = { ...fields[0]!, nullable: false };
    await update(table.id, fields); assert.equal((await sdk.get(project.id, owner)).source, baselineSdk.source); const revision = (await repository.get(project.id, owner, table.id)).appliedRevision;
    await assert.rejects(apply(table.id), { code: 'SCHEMA_DATA_INVALID' });
    assert.equal((await repository.get(project.id, owner, table.id)).appliedRevision, revision);
    assert.equal((await sdk.get(project.id, owner)).source, baselineSdk.source);
    fields[0] = { ...fields[0]!, backfillIntent: { kind: 'literal', value: 'legacy' } };
    await update(table.id, fields);
    assert.equal((await repository.get(project.id, owner, table.id)).fields[0]!.backfillIntent?.value, 'legacy');
    const preview = await service.preview(project.id, owner, table.id); assert.equal(preview.sql, ''); assert.ok(!JSON.stringify(preview).includes('legacy'));
    await apply(table.id);
    assert.deepEqual((await customer.query(`SELECT status FROM ${target} ORDER BY status`)).rows, [{ status: 'kept' }, { status: 'legacy' }]);
    assert.equal((await repository.get(project.id, owner, table.id)).fields[0]!.backfillIntent, undefined);
    await assert.rejects(customer.query(`INSERT INTO ${target} (status) VALUES (NULL)`), { code: '23502' });
  });
  await t.test('default add, literal change and removal affect only omitted future values', async () => {
    let previousHash = '';
    for (const value of ['future', 'changed', undefined]) {
      const fields = await inputs(table.id); const { default: _, ...field } = fields[0]!;
      fields[0] = { ...field, ...(value !== undefined ? { default: { kind: 'literal', value } as const } : {}) };
      const before = await sdk.get(project.id, owner);
      await update(table.id, fields); assert.equal((await sdk.get(project.id, owner)).source, before.source); await apply(table.id);
      const after = await sdk.get(project.id, owner);
      if (value === 'changed') { assert.equal(after.contractHash, previousHash); assert.notEqual(after.source, before.source); }
      previousHash = after.contractHash;
      const snapshot = await docs.snapshot(project.id, owner); assert.ok(snapshot);
      const document = openapi(snapshot, 'http://example.test');
      const request = document.paths['/records']!.post!.requestBody!;
      assert.equal(request.content['application/json']!.schema.required?.includes('status') ?? false, value === undefined);
      assert.ok(!after.source.includes('"legacy"'));
      if (value === undefined) await assert.rejects(customer.query(`INSERT INTO ${target} DEFAULT VALUES`), { code: '23502' });
      else assert.equal((await customer.query(`INSERT INTO ${target} DEFAULT VALUES RETURNING status`)).rows[0]!.status, value);
    }
    assert.equal((await customer.query(`SELECT 1 FROM ${target} WHERE status='legacy'`)).rows.length, 1);
  });
  await t.test('required additions: default only, fill only, different historical/future values', async () => {
    for (const [name, fill, def] of [['default_only', undefined, 'future'], ['fill_only', 'history', undefined], ['both_values', 'past', 'next']] as const) {
      const fields = await inputs(table.id);
      fields.push({ name, type: 'text', nullable: false, ...(fill !== undefined ? { backfillIntent: { kind: 'literal', value: fill } as const } : {}), ...(def !== undefined ? { default: { kind: 'literal', value: def } as const } : {}) });
      await update(table.id, fields); await apply(table.id);
      assert.ok((await customer.query(`SELECT "${name}" AS value FROM ${target}`)).rows.every((row) => row.value === (fill ?? def)));
    }
    await assert.rejects(customer.query(`INSERT INTO ${target} (status) VALUES ('new')`), { code: '23502' });
    const row = (await customer.query(`INSERT INTO ${target} (status,fill_only) VALUES ('new','provided') RETURNING *`)).rows[0]!;
    assert.equal(row.default_only, 'future'); assert.equal(row.both_values, 'next');
  });
  await t.test('authenticated uncertain POST finalizes without replaying changed data', async () => {
    const fields = await inputs(table.id); fields.push({ name: 'uncertain_value', type: 'text', nullable: false, backfillIntent: { kind: 'literal', value: 'initial' } });
    await update(table.id, fields); loseAck = true;
    await assert.rejects(apply(table.id), { code: 'SCHEMA_OUTCOME_UNKNOWN' });
    const pending = await repository.get(project.id, owner, table.id);
    assert.ok(!pending.appliedDefinition!.definition.fields.some((field) => field.name === 'uncertain_value'));
    await customer.query(`UPDATE ${target} SET uncertain_value='later' WHERE status='kept'`);
    const result = await reconcile(db, encryption, project.id, pending.applyStatus!.migrationId, 'schema', true);
    assert.equal(result.classification, 'POST_STATE');
    assert.equal((await customer.query(`SELECT uncertain_value FROM ${target} WHERE status='kept'`)).rows[0]!.uncertain_value, 'later');
    assert.equal((await repository.get(project.id, owner, table.id)).fields.at(-1)!.backfillIntent, undefined);
    assert.ok(!(await sdk.get(project.id, owner)).source.includes('initial'));
  });
  await t.test('real PostgreSQL structured default matrix, drift, precision and falsy values', async () => {
    for (const [type, value, options] of [['text', "a'b\\c", undefined], ['varchar', '', { length: 10 }], ['integer', 0, undefined], ['bigint', '9223372036854775807', undefined], ['decimal', '-9007199254740993.123456', { precision: 38, scale: 6 }], ['boolean', false, undefined]] as const) {
      const name = 'proof_' + type;
      const proof = await service.create(project.id, owner, { name, fields: [{ name: 'scalar_value', type, ...(options ? { options } : {}) }] }); await apply(proof.id);
      const fields = await inputs(proof.id); fields[0] = { ...fields[0]!, default: { kind: 'literal', value } };
      await update(proof.id, fields); await apply(proof.id);
      const row = (await customer.query(`INSERT INTO "${schema}"."${name}" DEFAULT VALUES RETURNING scalar_value`)).rows[0]!;
      assert.equal(row.scalar_value, value);
      await customer.query(`INSERT INTO "${schema}"."${name}" (scalar_value) VALUES (NULL)`);
      const required = await inputs(proof.id); required[0] = { ...required[0]!, nullable: false, backfillIntent: { kind: 'literal', value } };
      await update(proof.id, required); await apply(proof.id);
      assert.equal((await customer.query(`SELECT 1 FROM "${schema}"."${name}" WHERE scalar_value IS NULL`)).rows.length, 0);
      await customer.query(`ALTER TABLE "${schema}"."${name}" ALTER COLUMN scalar_value DROP DEFAULT`);
      const next = await inputs(proof.id); const { default: _, ...withoutDefault } = next[0]!; next[0] = withoutDefault;
      await update(proof.id, next); await assert.rejects(apply(proof.id), { code: 'SCHEMA_CONFLICT' });
    }
  });
  await t.test('frozen pending v3 receipt reconciles, followed by a new v4 history', async () => {
    const pending = await service.create(project.id, owner, { name: 'pending_v3', fields: [{ name: 'value_key', type: 'integer' }] }); await apply(pending.id);
    const fields = await inputs(pending.id); fields[0] = { ...fields[0]!, nullable: false };
    await update(pending.id, fields);
    const record = await repository.get(project.id, owner, pending.id);
    const plan = generateEvolutionPlan(record, await repository.list(project.id, owner));
    assert.equal(plan.version, 3); const hash = plan.hash;
    const operationId = await repository.begin(project.id, owner, pending.id, plan);
    await executor(config, { ...plan, receipt: { projectId: project.id, operationId } }, record.appliedDefinition);
    assert.equal((await reconcile(db, encryption, project.id, operationId, 'schema', true)).classification, 'POST_STATE');
    const next = await inputs(pending.id); next[0] = { ...next[0]!, default: { kind: 'literal', value: 0 } };
    await update(pending.id, next); assert.equal(generatePlan(await repository.get(project.id, owner, pending.id)).version, 4); await apply(pending.id);
    assert.equal(hash, plan.hash);
  });
  await t.test('unique and FK fill conflicts roll back data, defaults and requiredness', async () => {
    for (const composite of [false, true]) {
      const record = await service.create(project.id, owner, { name: composite ? 'unique_pair' : 'unique_single', fields: [{ name: 'value_key', type: 'integer', unique: !composite }, ...(composite ? [{ name: 'group_key', type: 'integer' as const }] : [])] }); await apply(record.id);
      const target = `"${schema}"."${record.name}"`;
      if (composite) {
        const current = await repository.get(project.id, owner, record.id);
        await service.update(project.id, owner, record.id, current.draftRevision, { name: current.name, fields: await inputs(record.id), indexes: [{ fieldIds: current.fields.map((field) => field.id), unique: true }] }); await apply(record.id);
        await customer.query(`INSERT INTO ${target} (value_key,group_key) VALUES (NULL,1),(NULL,1)`);
      } else await customer.query(`INSERT INTO ${target} (value_key) VALUES (NULL),(NULL)`);
      const fields = await inputs(record.id); fields[0] = { ...fields[0]!, nullable: false, backfillIntent: { kind: 'literal', value: 7 }, default: { kind: 'literal', value: 8 } };
      await update(record.id, fields); await assert.rejects(apply(record.id), { code: 'SCHEMA_DATA_INVALID' });
      assert.equal((await customer.query(`SELECT 1 FROM ${target} WHERE value_key IS NULL`)).rows.length, 2);
      assert.equal((await repository.get(project.id, owner, record.id)).appliedDefinition!.definition.fields[0]!.nullable, true);
      await customer.query(`DELETE FROM ${target}`);
      await customer.query(`INSERT INTO ${target} (value_key${composite ? ',group_key' : ''}) VALUES (NULL${composite ? ',1' : ''}),(9${composite ? ',1' : ''})`);
      await apply(record.id);
    }
    const parent = await service.create(project.id, owner, { name: 'fill_parent', fields: [] }); await apply(parent.id);
    const child = await service.create(project.id, owner, { name: 'fill_child', fields: [{ name: 'parent_id', type: 'uuid', relationship: { tableId: parent.id, onDelete: 'restrict' } }] }); await apply(child.id);
    await customer.query(`INSERT INTO "${schema}"."fill_child" DEFAULT VALUES`);
    const fields = await inputs(child.id); fields[0] = { ...fields[0]!, nullable: false, backfillIntent: { kind: 'literal', value: randomUUID() } };
    await update(child.id, fields); await assert.rejects(apply(child.id), { code: 'RELATIONSHIP_CONFLICT' });
    assert.equal((await customer.query(`SELECT parent_id FROM "${schema}"."fill_child"`)).rows[0]!.parent_id, null);
    const parentId = (await customer.query(`INSERT INTO "${schema}"."fill_parent" DEFAULT VALUES RETURNING id`)).rows[0]!.id;
    fields[0] = { ...fields[0]!, backfillIntent: { kind: 'literal', value: parentId } }; await update(child.id, fields); await apply(child.id);
  });
  await t.test('injected transactional failures leave exact PRE and retain intent', async () => {
    for (const stage of ['UPDATE ONLY', 'SELECT 1 FROM ONLY', 'ALTER TABLE', 'NOT_NULL', 'POST_VERIFY', 'COMMENT ON']) {
      const name = 'fault_' + randomUUID().slice(0, 8).replaceAll('-', '');
      const record = await service.create(project.id, owner, { name, fields: [{ name: 'value_key', type: 'integer' }] }); await apply(record.id);
      await customer.query(`INSERT INTO "${schema}"."${name}" DEFAULT VALUES`);
      const before = await repository.get(project.id, owner, record.id);
      const fields = await inputs(record.id); fields[0] = { ...fields[0]!, nullable: false, backfillIntent: { kind: 'literal', value: 1 }, default: { kind: 'literal', value: 2 } };
      await update(record.id, fields); failAt = stage;
      await assert.rejects(apply(record.id)); failAt = '';
      const after = await repository.get(project.id, owner, record.id);
      assert.deepEqual(after.appliedDefinition, before.appliedDefinition);
      assert.equal(after.appliedRevision, before.appliedRevision);
      assert.equal(after.fields[0]!.backfillIntent?.value, 1);
      assert.equal((await customer.query(`SELECT value_key FROM "${schema}"."${name}"`)).rows[0]!.value_key, null);
      assert.equal(customerAdmission.snapshot().total, 0);
      await db.delete(schemaTables).where(eq(schemaTables.id, record.id)); await customer.query(`DROP TABLE "${schema}"."${name}"`);
    }
  });
  await t.test('platform finalization failure reconciles authenticated POST and consumes fill only on publication', async () => {
    const record = await service.create(project.id, owner, { name: 'finalize_failure', fields: [{ name: 'value_key', type: 'integer' }] }); await apply(record.id);
    await customer.query(`INSERT INTO "${schema}"."finalize_failure" DEFAULT VALUES`);
    const fields = await inputs(record.id); fields[0] = { ...fields[0]!, nullable: false, backfillIntent: { kind: 'literal', value: 7 } }; await update(record.id, fields);
    const failingRepository = new Proxy(repository, { get(target, key) {
      if (key === 'finish') return async (...args: Parameters<typeof repository.finish>) => { if (args[5] === 'applied') throw new Error('synthetic platform outage'); return repository.finish(...args); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const failingService = new SchemaService(failingRepository, connections, encryption, executor);
    const preview = await failingService.preview(project.id, owner, record.id);
    await assert.rejects(failingService.apply(project.id, owner, record.id, preview.draftRevision, preview.planHash), { code: 'SCHEMA_OUTCOME_UNKNOWN' });
    const pending = await repository.get(project.id, owner, record.id);
    assert.equal(pending.applyStatus!.status, 'outcome_unknown');
    assert.equal(pending.appliedDefinition!.definition.fields[0]!.nullable, true); assert.equal(pending.fields[0]!.backfillIntent?.value, 7);
    await customer.query(`UPDATE "${schema}"."finalize_failure" SET value_key=9`);
    assert.equal((await reconcile(db, encryption, project.id, pending.applyStatus!.migrationId, 'schema', true)).classification, 'POST_STATE');
    assert.equal((await customer.query(`SELECT value_key FROM "${schema}"."finalize_failure"`)).rows[0]!.value_key, 9);
    assert.equal((await repository.get(project.id, owner, record.id)).fields[0]!.backfillIntent, undefined);
    await db.delete(schemaTables).where(eq(schemaTables.id, record.id)); await customer.query(`DROP TABLE "${schema}"."finalize_failure"`);
  });
  await t.test('a committed intermediate-looking required addition is DIVERGED without authenticated POST', async () => {
    const record = await service.create(project.id, owner, { name: 'transitional_state', fields: [] }); await apply(record.id);
    await update(record.id, [{ name: 'value_key', type: 'integer', nullable: false, backfillIntent: { kind: 'literal', value: 1 } }]);
    const current = await repository.get(project.id, owner, record.id), plan = generatePlan(current, await repository.list(project.id, owner));
    const operationId = await repository.begin(project.id, owner, record.id, plan);
    await customer.query(`ALTER TABLE "${schema}"."transitional_state" ADD COLUMN value_key integer`);
    const inspection = await reconcile(db, encryption, project.id, operationId, 'schema', true);
    assert.equal(inspection.classification, 'DIVERGED'); assert.equal(inspection.applied, false);
    assert.equal((await repository.get(project.id, owner, record.id)).appliedDefinition!.definition.fields.length, 0);
    await db.delete(schemaTables).where(eq(schemaTables.id, record.id)); await customer.query(`DROP TABLE "${schema}"."transitional_state"`);
  });
  await t.test('v4 revisions stale only dependent workflows after successful publication', async () => {
    const flows = new WorkflowService(new PostgresWorkflowRepository(db));
    const tables = [];
    for (const name of ['workflow_changed', 'workflow_unrelated']) {
      const record = await service.create(project.id, owner, { name, fields: [{ name: 'value_key', type: 'integer' }] }); await apply(record.id); tables.push(record);
    }
    const ids: string[] = [];
    for (const record of tables) {
      const definition: WorkflowDefinition = { auth: 'key_only', input: {}, steps: [
        { id: randomUUID(), name: 'read', type: 'query', tableId: record.id, access: { mode: 'key_only' }, select: ['id'], idValue: { kind: 'literal', value: randomUUID() }, onMissing: '404' },
        { id: randomUUID(), name: 'done', type: 'response', status: 204 },
      ] };
      const flow = await flows.create(project.id, owner, record.name.replaceAll('_', '-'), definition);
      const preview = await flows.preview(project.id, owner, flow.id);
      await flows.publish(project.id, owner, flow.id, 1, preview.definitionHash); await flows.toggle(project.id, owner, flow.id, 1, true); ids.push(flow.id);
    }
    const changed = tables[0]!;
    await customer.query(`INSERT INTO "${schema}"."${changed.name}" DEFAULT VALUES`);
    const fields = await inputs(changed.id); fields[0] = { ...fields[0]!, nullable: false };
    await update(changed.id, fields); await assert.rejects(apply(changed.id), { code: 'SCHEMA_DATA_INVALID' });
    assert.equal((await flows.get(project.id, owner, ids[0]!)).readiness.state, 'enabled');
    fields[0] = { ...fields[0]!, backfillIntent: { kind: 'literal', value: 0 } }; await update(changed.id, fields); await apply(changed.id);
    assert.equal((await flows.get(project.id, owner, ids[0]!)).readiness.state, 'blocked');
    assert.equal((await flows.get(project.id, owner, ids[1]!)).readiness.state, 'enabled');
    for (const id of ids) await db.delete(workflowEndpoints).where(eq(workflowEndpoints.id, id));
    for (const record of tables) { await db.delete(schemaTables).where(eq(schemaTables.id, record.id)); await customer.query(`DROP TABLE "${schema}"."${record.name}"`); }
  });
  await t.test('typed date, timestamp microseconds and ordinary UUID fills preserve exact values', async () => {
    for (const [type, value] of [['date', '2024-02-29'], ['timestamp', '2024-02-29T23:59:59.123456+05:30'], ['uuid', '99999999-9999-4999-8999-999999999999']] as const) {
      const record = await service.create(project.id, owner, { name: 'typed_' + type, fields: [{ name: 'value_key', type }] }); await apply(record.id);
      const target = `"${schema}"."${record.name}"`; await customer.query(`INSERT INTO ${target} DEFAULT VALUES`);
      const fields = await inputs(record.id); fields[0] = { ...fields[0]!, nullable: false, backfillIntent: { kind: 'literal', value } };
      await update(record.id, fields); await apply(record.id);
      const equal = await customer.query(`SELECT value_key = $1::${type === 'timestamp' ? 'timestamptz' : type} AS equal FROM ${target}`, [value]);
      assert.equal(equal.rows[0]!.equal, true);
      if (type === 'timestamp') assert.ok((await customer.query(`SELECT value_key::text AS exact FROM ${target}`)).rows[0]!.exact.includes('.123456'));
      await db.delete(schemaTables).where(eq(schemaTables.id, record.id)); await customer.query(`DROP TABLE ${target}`);
    }
  });
  await t.test('exclusive transition locks serialize NULL writers and competing Apply', async () => {
    const record = await service.create(project.id, owner, { name: 'concurrent_fill', fields: [{ name: 'value_key', type: 'integer' }] }); await apply(record.id);
    const target = `"${schema}"."concurrent_fill"`; await customer.query(`INSERT INTO ${target} DEFAULT VALUES`);
    const fields = await inputs(record.id); fields[0] = { ...fields[0]!, nullable: false, backfillIntent: { kind: 'literal', value: 1 } }; await update(record.id, fields);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    pauseBeforeRequired = async () => { entered(); await gate; };
    const applying = apply(record.id); await reached;
    const writer = new pg.Client({ connectionString: url.toString() }); await writer.connect();
    let writerFinished = false;
    const writing = writer.query(`INSERT INTO ${target} DEFAULT VALUES`).then(() => { writerFinished = true; return ''; }, (error: { code: string }) => { writerFinished = true; return error.code; });
    await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(writerFinished, false);
    await assert.rejects(apply(record.id), { code: 'SCHEMA_CONFLICT' });
    release(); await applying; pauseBeforeRequired = undefined;
    assert.equal(await writing, '23502'); await writer.end();
    assert.equal((await customer.query(`SELECT value_key FROM ${target}`)).rows[0]!.value_key, 1);
    await db.delete(schemaTables).where(eq(schemaTables.id, record.id)); await customer.query(`DROP TABLE ${target}`);
  });
  await t.test('bounded service-path performance at 0, 1k, 10k and 100k rows', async () => {
    const cases = ['default_change', 'nullable_add', 'required_no_null', 'partial_fill', 'all_fill', 'add_default', 'add_fill', 'add_both', 'unique_fill', 'reference_fill'];
    for (const rows of [0, 1000, 10000, 100000]) for (const kind of cases) {
      const name = 'bench_' + randomUUID().replaceAll('-', '').slice(0, 12);
      const parent = kind === 'reference_fill' ? (await repository.list(project.id, owner)).find((candidate) => candidate.name === 'fill_parent')! : undefined;
      const referenceValue = parent ? (await customer.query(`SELECT id FROM "${schema}"."fill_parent" LIMIT 1`)).rows[0]!.id as string : undefined;
      const record = await service.create(project.id, owner, { name, fields: [{ name: 'value_key', type: parent ? 'uuid' : 'integer', ...(parent ? { relationship: { tableId: parent.id, onDelete: 'restrict' } as const } : {}), ...(kind === 'unique_fill' ? { unique: true } : {}) }] }); await apply(record.id);
      const target = `"${schema}"."${name}"`;
      if (parent) await customer.query(`INSERT INTO ${target} (value_key) SELECT NULL::uuid FROM generate_series(1,$1::integer)`, [rows]);
      else await customer.query(`INSERT INTO ${target} (value_key) SELECT CASE WHEN $2 IN ('all_fill','unique_fill') OR ($2='partial_fill' AND n%2=0) THEN NULL ELSE n END FROM generate_series(1,$1::integer) n`, [rows, kind]);
      const storageBefore = kind === 'nullable_add' ? (await customer.query('SELECT relfilenode::text AS node FROM pg_class WHERE oid=$1::regclass', [target])).rows[0]!.node : undefined;
      const fields = await inputs(record.id);
      if (kind === 'default_change') fields[0] = { ...fields[0]!, default: { kind: 'literal', value: 0 } };
      else if (kind === 'nullable_add') fields.push({ name: 'new_value', type: 'integer', default: { kind: 'literal', value: 0 } });
      else if (kind.startsWith('add_')) fields.push({ name: 'new_value', type: 'integer', nullable: false, ...(kind !== 'add_default' ? { backfillIntent: { kind: 'literal', value: 1 } as const } : {}), ...(kind !== 'add_fill' ? { default: { kind: 'literal', value: 2 } as const } : {}) });
      else fields[0] = { ...fields[0]!, nullable: false, ...(kind !== 'required_no_null' ? { backfillIntent: { kind: 'literal', value: referenceValue ?? 0 } as const } : {}) };
      await update(record.id, fields);
      measurements = { lockWaitMs: 0, fillMs: 0, ddlMs: 0, catalogReceiptMs: 0, rollbackMs: 0, rowsAffected: 0 };
      const start = performance.now(); let outcome = 'applied';
      try { await apply(record.id); } catch (error) { outcome = (error as { code: string }).code; }
      const totalApplyMs = performance.now() - start;
      const metrics = measurements; measurements = undefined;
      const storageAfter = kind === 'nullable_add' ? (await customer.query('SELECT c.relfilenode::text AS node,a.atthasmissing FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.oid=$1::regclass AND a.attname=$2', [target, 'new_value'])).rows[0] : undefined;
      console.info(JSON.stringify({ benchmark: 'safe-schema-evolution', rows, kind, outcome, ...metrics, totalApplyMs, ...(storageBefore ? { storageBefore, storageAfter } : {}), admissionAfter: customerAdmission.snapshot().total }));
      assert.ok(['applied', 'SCHEMA_TIMEOUT', ...(kind === 'unique_fill' && rows > 1 ? ['SCHEMA_DATA_INVALID'] : [])].includes(outcome));
      assert.equal(customerAdmission.snapshot().total, 0);
      await db.delete(schemaTables).where(eq(schemaTables.id, record.id));
      await customer.query(`DROP TABLE ${target}`);
    }
  });

});
