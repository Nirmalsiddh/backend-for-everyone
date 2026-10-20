import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { normalizeDraft } from '../../src/modules/schema-builder/validation.js';
import { generatePlan, quoteIdentifier as q } from '../../src/modules/schema-builder/plan.js';
import { createSchemaExecutor } from '../../src/database/customer-db/schema-executor.js';
import { createRuntimeExecutor } from '../../src/database/customer-db/runtime-executor.js';
import { boundedClient, customerAdmission } from '../../src/database/customer-db/admission.js';
import { selectList, serializeRow } from '../../src/runtime/queries.js';
import { validateList } from '../../src/runtime/validation.js';
import type { AppliedDefinition, TableRecord } from '../../src/modules/schema-builder/types.js';

test('advanced querying exact PostgreSQL semantics, pagination, includes, drift and bounded local measurements', async (t) => {
  const url = new URL(process.env.TEST_CUSTOMER_DATABASE_URL!);
  const schema = 'query_' + randomUUID().replaceAll('-', '');
  const customer = new pg.Client({ connectionString: url.toString() }); await customer.connect();
  t.after(async () => { await customer.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`); await customer.end(); });
  await customer.query(`CREATE SCHEMA ${q(schema)}`);
  const config = { host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema, ssl: false };
  const supplierDraft = normalizeDraft({ name: 'suppliers', fields: [{ name: 'name', type: 'text' }] });
  const supplierTable: TableRecord = {
    id: randomUUID(), projectId: randomUUID(), connectionId: randomUUID(), schemaName: schema,
    ...supplierDraft, draftRevision: 1, appliedRevision: null, appliedDefinition: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const supplierPlan = generatePlan(supplierTable, [supplierTable]);
  const supplier: AppliedDefinition = { definition: supplierPlan.definition, catalog: await createSchemaExecutor()(config, supplierPlan, null) };
  supplierTable.appliedRevision = 1; supplierTable.appliedPhysicalRevision = 1; supplierTable.appliedDefinition = supplier;
  const supplierId = randomUUID();
  await customer.query(`INSERT INTO ${q(schema)}.suppliers (id,name) VALUES ($1,$2)`, [supplierId,'Synthetic supplier']);
  const draft = normalizeDraft({ name: 'products', fields: [
    { name: 'supplier_id', type: 'uuid', relationship: { tableId: supplierTable.id, onDelete: 'restrict' } },
    { name: 'alternate_supplier_id', type: 'uuid', relationship: { tableId: supplierTable.id, onDelete: 'restrict' } },
    { name: 'quantity', type: 'integer' }, { name: 'indexed_quantity', type: 'integer' },
    { name: 'counter', type: 'bigint' }, { name: 'amount', type: 'decimal', options: { precision: 24, scale: 2 } },
    { name: 'day', type: 'date' }, { name: 'instant', type: 'timestamp' }, { name: 'active', type: 'boolean' },
    { name: 'label', type: 'text' }, { name: 'short_label', type: 'varchar', options: { length: 200 } },
    { name: 'owner_id', type: 'uuid' }, { name: 'payload', type: 'jsonb' },
  ] });
  const table: TableRecord = {
    id: randomUUID(), projectId: supplierTable.projectId, connectionId: supplierTable.connectionId, schemaName: schema,
    ...draft, draftRevision: 1, appliedRevision: null, appliedDefinition: null,
    createdAt: new Date(), updatedAt: new Date(),
    indexes: [{ id: randomUUID(), specificationVersion: 1, unique: false, fieldIds: [draft.fields.find((field) => field.name === 'indexed_quantity')!.id] }],
  };
  const plan = generatePlan(table, [supplierTable,table]);
  const applied: AppliedDefinition = { definition: plan.definition, catalog: await createSchemaExecutor()(config, plan, null), managedTables: [{ id: supplierTable.id, appliedRevision: 1, appliedPhysicalRevision: 1, appliedDefinition: supplier }] };
  applied.managedTables!.push({ id: table.id, appliedRevision: 1, appliedPhysicalRevision: 1, appliedDefinition: { definition: applied.definition, catalog: applied.catalog } });
  const ownerA = randomUUID(), ownerB = randomUUID();
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'] as const;
  for (let index = 0; index < 3; index++) await customer.query(`INSERT INTO ${q(schema)}.products (id,quantity,indexed_quantity,counter,amount,day,instant,active,label,short_label,owner_id) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8::text,$8::varchar,$9)`, [ids[index], index + 1, ['9007199254740992','9007199254740993','9223372036854775807'][index], ['123456789012345678.90','123456789012345678.91','123456789012345678.92'][index], `2024-02-${27 + index}`, `2026-01-01T00:00:00.12345${index}Z`, index === 0 ? true : index === 1 ? false : null, ['ACME, Inc.', 'A&B', null][index], index === 0 ? ownerA : ownerB]);
  await customer.query(`UPDATE ${q(schema)}.products SET supplier_id=$1,alternate_supplier_id=$1 WHERE quantity<3`, [supplierId]);
  let dataQueries = 0;
  const executor = createRuntimeExecutor((options) => {
    const client = boundedClient(options, 'runtime');
    return { ...client, query: async (text, values) => {
      if (/^SELECT .* FROM ONLY /.test(text)) dataQueries++;
      return client.query(text, values);
    } };
  });
  const list = async (query: Record<string, string>, ownership?: { field: string; userId: string }) => {
    dataQueries = 0;
    const result = await executor(config, applied, selectList(applied.definition, validateList(applied.definition, query), ownership));
    assert.equal(dataQueries, 1); assert.equal(customerAdmission.snapshot().total, 0);
    return result;
  };
  const expectIds = async (query: Record<string, string>, expected: string[]) => assert.deepEqual((await list(query)).map((row) => row.id), expected);
  await t.test('integer comparisons, membership and ordering apply before page selection', async () => {
    for (const [op, expected] of [['eq',[ids[1]]], ['neq',[ids[0],ids[2]]], ['gt',[ids[2]]], ['gte',[ids[1],ids[2]]], ['lt',[ids[0]]], ['lte',[ids[0],ids[1]]]] as const)
      await expectIds({ [`filter[quantity][${op}]`]: '2' }, [...expected]);
    await expectIds({ 'filter[quantity][in]': '["1","3"]' }, [ids[0]!, ids[2]!]);
    await expectIds({ 'filter[quantity][gte]': '2', sort: 'quantity', direction: 'desc', limit: '1' }, [ids[2]!,ids[1]!]); // includes lookahead
    await expectIds({ 'filter[quantity][gte]': '2', sort: 'quantity', direction: 'desc', offset: '1', limit: '1' }, [ids[1]!]);
    await expectIds({ 'filter[quantity][gt]': '2', 'filter[quantity][lt]': '2' }, []);
    await expectIds({ 'filter[owner_id][in]': JSON.stringify([ownerB]), sort: 'owner_id', direction: 'desc' }, [ids[1]!,ids[2]!]);
  });
  await t.test('managed relationship UUID operators filter parents without joining targets', async () => {
    await expectIds({ 'filter[supplier_id][eq]': supplierId }, [ids[0],ids[1]]);
    await expectIds({ 'filter[supplier_id][neq]': supplierId }, []);
    await expectIds({ 'filter[supplier_id][in]': JSON.stringify([supplierId]) }, [ids[0],ids[1]]);
    await expectIds({ 'filter[supplier_id][is_null]': 'true' }, [ids[2]]);
    await expectIds({ 'filter[supplier_id][is_null]': 'false' }, [ids[0],ids[1]]);
  });
  await t.test('bigint/decimal exactness, calendar ranges and microsecond timezone comparisons', async () => {
    await expectIds({ 'filter[counter][gt]': '9007199254740992', 'filter[counter][lt]': '9223372036854775807' }, [ids[1]!]);
    await expectIds({ 'filter[counter][in]': '["9007199254740993","9223372036854775807"]' }, [ids[1]!,ids[2]!]);
    await expectIds({ 'filter[amount][gte]': '123456789012345678.91', 'filter[amount][lt]': '123456789012345678.92' }, [ids[1]!]);
    await expectIds({ 'filter[amount][in]': '["123456789012345678.90","123456789012345678.92"]' }, [ids[0]!,ids[2]!]);
    await expectIds({ 'filter[day][gte]': '2024-02-28', 'filter[day][lte]': '2024-02-29' }, [ids[1]!,ids[2]!]);
    await expectIds({ 'filter[instant][gt]': '2026-01-01T05:30:00.123450+05:30', 'filter[instant][lte]': '2026-01-01T00:00:00.123451Z' }, [ids[1]!]);
    const row = serializeRow(applied.definition, (await list({ 'filter[id][eq]': ids[2]! }))[0]!);
    assert.equal(row.counter, '9223372036854775807'); assert.equal(row.amount, '123456789012345678.92');
  });
  await t.test('NULL, boolean, text membership and owner filters only narrow rows', async () => {
    await expectIds({ 'filter[active][eq]': 'true' }, [ids[0]!]);
    await expectIds({ 'filter[active][neq]': 'true' }, [ids[1]!]);
    await expectIds({ 'filter[label][is_null]': 'true' }, [ids[2]!]);
    await expectIds({ 'filter[label][is_null]': 'false' }, [ids[0]!,ids[1]!]);
    await expectIds({ 'filter[label][neq]': 'ACME, Inc.' }, [ids[1]!]);
    await expectIds({ 'filter[short_label][in]': '["ACME, Inc.","A&B"]' }, [ids[0]!,ids[1]!]);
    assert.deepEqual(await list({ 'filter[owner_id][neq]': ownerA }, { field: 'owner_id', userId: ownerA }), []);
    assert.deepEqual(await list({ 'filter[owner_id][in]': JSON.stringify([ownerB]) }, { field: 'owner_id', userId: ownerA }), []);
    for (const text of ['', 'null', '雪 & "quoted" +']) {
      await customer.query(`UPDATE ${q(schema)}.products SET label=$1::text,short_label=$1::varchar WHERE id=$2`, [text, ids[0]]);
      for (const name of ['label','short_label']) for (const op of ['eq','neq','in'])
        await expectIds({ [`filter[${name}][${op}]`]: op === 'in' ? JSON.stringify([text]) : text }, op === 'neq' ? [ids[1]!] : [ids[0]!]);
    }
  });
  await t.test('bounded representative query timings at 1k/10k/100k with managed index and includes', async () => {
    for (const rows of [1000,10000,100000]) {
      await customer.query(`TRUNCATE ${q(schema)}.products`);
      await customer.query(`INSERT INTO ${q(schema)}.products (quantity,indexed_quantity,amount,owner_id,supplier_id,alternate_supplier_id) SELECT value,value,value,$1::uuid,$3::uuid,$3::uuid FROM generate_series(1,$2) value`, [ownerA,rows,supplierId]);
      await customer.query(`ANALYZE ${q(schema)}.products`);
      if (rows === 1000) for (const size of [1,25,100]) for (const count of [0,1,2]) {
        dataQueries = 0;
        const options = validateList(applied.definition, { 'filter[quantity][gte]': '500', 'filter[supplier_id][in]': JSON.stringify([supplierId]), limit: String(size) });
        const names = ['supplier_id','alternate_supplier_id'].slice(0,count);
        const page = await executor(config, applied, selectList(applied.definition,options), undefined, count ? { includes: names.map((name) => ({ name, applied: supplier })), limit: size, fence: async () => {} } : undefined);
        assert.equal(page.length,size+1); assert.equal(dataQueries,count+1);
        for (const row of page.slice(0,size)) for (const name of names) assert.equal((row._related as Record<string,{name:string}>)[name]!.name,'Synthetic supplier');
        assert.equal(page[size]!._related,undefined);
        assert.equal(customerAdmission.snapshot().total,0);
        console.log(JSON.stringify({ evidence: 'advanced-include-count', size, includes: count, dataQueries, admissionAfter: customerAdmission.snapshot().total }));
      }
      const fixtures: [string,Record<string,string>][] = [
        ['legacy-equality', { 'filter[quantity]': '500' }],
        ['unindexed-equality', { 'filter[quantity][eq]': '500' }],
        ['managed-index-equality', { 'filter[indexed_quantity][eq]': '500' }],
        ['range', { 'filter[amount][gte]': '500', 'filter[amount][lte]': '525' }],
        ['in', { 'filter[quantity][in]': '["1","500","999"]' }],
        ['filter-sort', { 'filter[quantity][gte]': '500', sort: 'quantity', direction: 'desc' }],
        ['filter-include', { 'filter[quantity][gte]': '500' }],
      ];
      for (const [kind,query] of fixtures) {
        dataQueries = 0;
        const options = validateList(applied.definition, query);
        const started = performance.now();
        const result = await executor(config, applied, selectList(applied.definition, options), undefined, kind === 'filter-include' ? { includes: [{ name: 'supplier_id', applied: supplier }], limit: options.limit, fence: async () => {} } : undefined);
        const durationMs = performance.now()-started;
        assert.equal(dataQueries, kind === 'filter-include' ? 2 : 1);
        assert.equal(customerAdmission.snapshot().total, 0);
        const response = { data: result.slice(0,options.limit).map((row) => ({ ...serializeRow(applied.definition,row), ...(row._related ? { _related: row._related } : {}) })), pagination: { limit: options.limit, offset: options.offset, hasMore: result.length>options.limit } };
        console.log(JSON.stringify({ benchmark: 'advanced-query', rows, kind, durationMs, returned: response.data.length, dataQueries, responseBytes: Buffer.byteLength(JSON.stringify(response)), admissionAfter: customerAdmission.snapshot().total }));
      }
    }
  });
  await t.test('missing managed index fails closed even for simple new predicates', async () => {
    const index = (await customer.query('SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname LIKE $2', [schema,'ix_usr_%'])).rows[0].indexname;
    await customer.query(`DROP INDEX ${q(schema)}.${q(index)}`);
    await assert.rejects(list({ 'filter[quantity][eq]': '500' }), { code: 'RUNTIME_UNAVAILABLE' });
    assert.equal(dataQueries, 0); assert.equal(customerAdmission.snapshot().total, 0);
  });
});
