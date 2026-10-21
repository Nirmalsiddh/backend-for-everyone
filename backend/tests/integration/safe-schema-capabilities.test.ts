import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createSchemaExecutor } from '../../src/database/customer-db/schema-executor.js';
import { boundedClient, customerAdmission } from '../../src/database/customer-db/admission.js';
import { generatePlan } from '../../src/modules/schema-builder/plan.js';
import { normalizeDraft } from '../../src/modules/schema-builder/validation.js';
import type { TableRecord } from '../../src/modules/schema-builder/types.js';

test('schema ownership does not imply fill capability; missing UPDATE rolls back safely', async (t) => {
  if (!process.env.TEST_CUSTOMER_DATABASE_URL) throw new Error('Explicit disposable customer database required');
  const url = new URL(process.env.TEST_CUSTOMER_DATABASE_URL);
  const customer = new pg.Client({ connectionString: url.toString() }); await customer.connect();
  const suffix = randomUUID().replaceAll('-', ''), schema = 'cap_' + suffix, role = 'cap_' + suffix;
  t.after(async () => { await customer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await customer.query(`DROP ROLE IF EXISTS "${role}"`); await customer.end(); });
  await customer.query(`CREATE SCHEMA "${schema}"`); await customer.query(`CREATE ROLE "${role}" NOLOGIN`);
  const config = { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema, ssl: false };
  const draft = normalizeDraft({ name: 'records', fields: [{ name: 'value_key', type: 'integer' }] });
  const table: TableRecord = { ...draft, id: randomUUID(), projectId: randomUUID(), connectionId: randomUUID(), schemaName: schema, draftRevision: 1, appliedRevision: null, appliedDefinition: null, createdAt: new Date(), updatedAt: new Date() };
  const create = generatePlan(table), catalog = await createSchemaExecutor()(config, create, null);
  await customer.query(`INSERT INTO "${schema}"."records" DEFAULT VALUES`);
  await customer.query(`ALTER TABLE "${schema}"."records" OWNER TO "${role}"`);
  await customer.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await customer.query(`REVOKE UPDATE ON "${schema}"."records" FROM "${role}"`);
  table.appliedDefinition = { definition: create.definition, catalog }; table.appliedRevision = 1; table.draftRevision = 2;
  table.fields = [{ ...table.fields[0]!, nullable: false, backfillIntent: { kind: 'literal', value: 0 } }];
  const plan = generatePlan(table);
  const executor = createSchemaExecutor((options) => {
    const client = boundedClient(options, 'schema', 10000);
    return { ...client, async connect() { await client.connect(); await client.query(`SET ROLE "${role}"`); } };
  });
  await assert.rejects(executor(config, plan, table.appliedDefinition), { code: 'SCHEMA_PERMISSION_DENIED' });
  assert.equal((await customer.query(`SELECT value_key FROM "${schema}"."records"`)).rows[0]!.value_key, null);
  assert.equal(customerAdmission.snapshot().total, 0);
  await customer.query(`GRANT UPDATE ON "${schema}"."records" TO "${role}"`);
  await executor(config, plan, table.appliedDefinition);
  assert.equal((await customer.query(`SELECT value_key FROM "${schema}"."records"`)).rows[0]!.value_key, 0);
  assert.equal(customerAdmission.snapshot().total, 0);
});

test('v4 catalog transition preserves legacy collations and atomically adds required UUID/reference fields', async (t) => {
  if (!process.env.TEST_CUSTOMER_DATABASE_URL) throw new Error('Explicit disposable customer database required');
  const url = new URL(process.env.TEST_CUSTOMER_DATABASE_URL), customer = new pg.Client({ connectionString: url.toString() }); await customer.connect();
  const schema = 'delta_' + randomUUID().replaceAll('-', '');
  t.after(async () => { await customer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await customer.end(); });
  await customer.query(`CREATE SCHEMA "${schema}"`);
  const config = { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema, ssl: false };
  const executor = createSchemaExecutor();
  const draft = normalizeDraft({ name: 'records', fields: [{ name: 'value_key', type: 'text' }] });
  const table: TableRecord = { ...draft, id: randomUUID(), projectId: randomUUID(), connectionId: randomUUID(), schemaName: schema, draftRevision: 1, appliedRevision: null, appliedDefinition: null, createdAt: new Date(), updatedAt: new Date() };
  async function apply(tables: TableRecord[] = []) {
    const plan = generatePlan(table, tables);
    const catalog = await executor(config, plan, table.appliedDefinition);
    table.appliedDefinition = { definition: plan.definition, catalog }; table.appliedRevision = table.draftRevision;
    table.fields = plan.definition.fields; table.draftRevision++;
  }
  await apply(); await customer.query(`INSERT INTO "${schema}"."records" DEFAULT VALUES`);
  const nullable = normalizeDraft({ name: table.name, fields: [{ name: 'new_value', type: 'varchar', options: { length: 10 }, default: { kind: 'literal', value: '' } }] }).fields[0]!;
  table.fields = [...table.fields, nullable]; await apply();
  assert.equal((await customer.query(`SELECT new_value FROM "${schema}"."records"`)).rows[0]!.new_value, '');
  const uuid = randomUUID();
  const ordinary = normalizeDraft({ name: table.name, fields: [{ name: 'ordinary_id', type: 'uuid', nullable: false, backfillIntent: { kind: 'literal', value: uuid } }] }).fields[0]!;
  table.fields = [...table.fields, ordinary]; await apply();
  const parent: TableRecord = { ...table, id: randomUUID(), name: 'parents', fields: [], draftRevision: 1, appliedRevision: null, appliedDefinition: null };
  const parentPlan = generatePlan(parent), parentCatalog = await executor(config, parentPlan, null);
  parent.appliedDefinition = { definition: parentPlan.definition, catalog: parentCatalog }; parent.appliedRevision = 1;
  const parentId = (await customer.query(`INSERT INTO "${schema}"."parents" DEFAULT VALUES RETURNING id`)).rows[0]!.id as string;
  const reference = normalizeDraft({ name: table.name, fields: [{ name: 'parent_id', type: 'uuid', nullable: false, relationship: { tableId: parent.id, onDelete: 'restrict' }, backfillIntent: { kind: 'literal', value: parentId } }] }).fields[0]!;
  table.fields = [...table.fields, reference]; await apply([table, parent]);
  const row = (await customer.query(`SELECT ordinary_id,parent_id FROM "${schema}"."records"`)).rows[0]!;
  assert.equal(row.ordinary_id, uuid); assert.equal(row.parent_id, parentId);
  const unicode = normalizeDraft({ name: table.name, fields: [{ name: 'unicode_value', type: 'varchar', options: { length: 1 }, default: { kind: 'literal', value: '🙂' } }] }).fields[0]!;
  table.fields = [...table.fields, unicode];
  if ((await customer.query('SHOW server_encoding')).rows[0]!.server_encoding === 'UTF8') {
    await apply([table, parent]);
    assert.equal((await customer.query(`SELECT unicode_value FROM "${schema}"."records"`)).rows[0]!.unicode_value, '🙂');
  } else {
    await assert.rejects(apply([table, parent]), { code: 'SCHEMA_DATA_INVALID' });
    assert.equal((await customer.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', [schema, table.name, 'unicode_value'])).rows.length, 0);
  }
  assert.equal(customerAdmission.snapshot().total, 0);
});
