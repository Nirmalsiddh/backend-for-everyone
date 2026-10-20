import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../../src/app.js';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import {
  users,
  projects,
  databaseConnections,
  schemaTables,
  apiKeys,
  workflowEndpoints,
} from '../../src/database/platform-db/schema.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { PostgresEndpointRepository } from '../../src/modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { PostgresRuntimeRepository } from '../../src/runtime/repository.js';
import { PostgresWorkflowRepository } from '../../src/modules/workflows/repository.js';
import { PostgresDocsRepository } from '../../src/modules/api-docs/repository.js';
import { createSchemaExecutor } from '../../src/database/customer-db/schema-executor.js';
import {
  generatePlan,
  canonical,
  quoteIdentifier as q,
} from '../../src/modules/schema-builder/plan.js';
import { CredentialEncryption } from '../../src/security/encryption.js';
import { reconcile } from '../../src/operations/reconciliation.js';
import type {
  FieldInput,
  TableRecord,
} from '../../src/modules/schema-builder/types.js';
import type { WorkflowDefinition } from '../../src/modules/workflows/types.js';
import { memoryPlatformAuthRepository } from '../platform-auth-helpers.js';
import { auth, env } from '../helpers.js';

test('managed relationships: PostgreSQL enforcement, parent drift, workflow atomicity and recovery', async (t) => {
  const platformUrl = process.env.TEST_DATABASE_URL!;
  const url = new URL(process.env.TEST_CUSTOMER_DATABASE_URL!);
  assert.notEqual(new URL(platformUrl).toString(), url.toString());
  const { db, pool } = createPlatformDatabase(platformUrl);
  const customer = new pg.Client({ connectionString: url.toString() });
  await customer.connect();
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL('../../migrations', import.meta.url),
    ),
  });
  const owner = randomUUID(),
    schema = `rel_${randomUUID().replaceAll('-', '')}`;
  await db.insert(users).values({ id: owner, email: `${owner}@example.test` });
  const projectRepository = new PostgresProjectRepository(db);
  const project = await projectRepository.create(owner, {
    name: 'Relationships',
    slug: `rel-${randomUUID()}`,
  });
  const repository = new PostgresSchemaRepository(db);
  const encryption = new CredentialEncryption(env.connectionEncryptionKey);
  const deps = {
    projectRepository,
    schemaRepository: repository,
    connectionRepository: new PostgresConnectionRepository(db),
    endpointRepository: new PostgresEndpointRepository(db),
    apiKeyRepository: new PostgresApiKeyRepository(db),
    runtimeRepository: new PostgresRuntimeRepository(db),
    workflowRepository: new PostgresWorkflowRepository(db),
    docsRepository: new PostgresDocsRepository(db),
    platformAuthRepository: memoryPlatformAuthRepository(owner),
    env,
    logger: false as const,
  };
  const app = buildApp(deps);
  t.after(async () => {
    await app.close();
    await customer.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await db
      .delete(workflowEndpoints)
      .where(eq(workflowEndpoints.projectId, project.id));
    await db.delete(schemaTables).where(eq(schemaTables.projectId, project.id));
    await db.delete(apiKeys).where(eq(apiKeys.projectId, project.id));
    await db
      .delete(databaseConnections)
      .where(eq(databaseConnections.projectId, project.id));
    await db.delete(projects).where(eq(projects.id, project.id));
    await db.delete(users).where(eq(users.id, owner));
    await customer.end();
    await pool.end();
  });
  await customer.query(`CREATE SCHEMA ${q(schema)}`);
  const base = `/internal/projects/${project.id}`,
    runtime = `/api/${project.slug}`;
  const config = {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password) || 'disposable-fixture-password',
    schema,
    ssl: false,
  };
  const connected = await app.inject({
    method: 'POST',
    url: base + '/database-connection',
    headers: auth,
    payload: { ...config, label: 'Disposable' },
  });
  assert.equal(connected.statusCode, 201, connected.body);
  async function draft(name: string, fields: FieldInput[]) {
    const r = await app.inject({
      method: 'POST',
      url: base + '/schema/tables',
      headers: auth,
      payload: { name, fields },
    });
    assert.equal(r.statusCode, 201, r.body);
    return repository.get(project.id, owner, r.json().id);
  }
  const tablePath = (id: string) => `${base}/schema/tables/${id}`;
  async function apply(table: TableRecord) {
    const preview = await app.inject({
      method: 'POST',
      url: tablePath(table.id) + '/preview',
      headers: auth,
    });
    assert.equal(preview.statusCode, 200, preview.body);
    const result = await app.inject({
      method: 'POST',
      url: tablePath(table.id) + '/apply',
      headers: auth,
      payload: {
        expectedDraftRevision: table.draftRevision,
        planHash: preview.json().planHash,
      },
    });
    assert.equal(result.statusCode, 200, result.body);
    return repository.get(project.id, owner, table.id);
  }
  async function enable(table: TableRecord) {
    const r = await app.inject({
      method: 'PUT',
      url: tablePath(table.id) + '/api',
      headers: auth,
      payload: {
        enabledOperations: ['list', 'get', 'create', 'update', 'delete'],
        expectedAppliedRevision: table.appliedRevision,
        expectedConfigRevision: 0,
      },
    });
    assert.equal(r.statusCode, 200, r.body);
  }
  const parent = await apply(
    await draft('customers', [{ name: 'name', type: 'text', nullable: false }]),
  );
  const parentBefore = canonical(parent.appliedDefinition);
  await enable(parent);
  const parentDefinition: WorkflowDefinition = {
    auth: 'key_only',
    input: {},
    steps: [
      {
        id: randomUUID(),
        name: 'parent_write',
        type: 'insert',
        tableId: parent.id,
        access: { mode: 'key_only' },
        values: {
          [parent.fields[0]!.id]: {
            kind: 'literal',
            value: 'Parent workflow record',
          },
        },
        select: ['id'],
      },
      { id: randomUUID(), name: 'done', type: 'response', status: 204 },
    ],
  };
  const parentFlow = await app.inject({
    method: 'POST',
    url: base + '/workflows',
    headers: auth,
    payload: { path: 'parent-action', definition: parentDefinition },
  });
  assert.equal(parentFlow.statusCode, 201, parentFlow.body);
  const parentFlowPath = base + '/workflows/' + parentFlow.json().id;
  const parentFlowPreview = await app.inject({
    method: 'POST',
    url: parentFlowPath + '/preview',
    headers: auth,
  });
  const parentPublished = await app.inject({
    method: 'POST',
    url: parentFlowPath + '/publish',
    headers: auth,
    payload: {
      expectedDraftRevision: 1,
      definitionHash: parentFlowPreview.json().definitionHash,
    },
  });
  assert.equal(parentPublished.statusCode, 200, parentPublished.body);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: parentFlowPath,
        headers: auth,
        payload: { expectedDraftRevision: 1, enabled: true },
      })
    ).statusCode,
    200,
  );
  const keyResponse = await app.inject({
    method: 'POST',
    url: base + '/api-keys',
    headers: auth,
    payload: { name: 'Relationships', scope: 'read_write' },
  });
  assert.equal(keyResponse.statusCode, 201, keyResponse.body);
  const bearer = { authorization: `Bearer ${keyResponse.json().key}` };
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: runtime + path,
      headers: bearer,
      ...(payload ? { payload } : {}),
    });
  const customerResponse = await call('POST', '/customers', {
    name: 'Example',
  });
  assert.equal(customerResponse.statusCode, 201, customerResponse.body);
  const customerId = customerResponse.json().id;
  const relation: FieldInput = {
    name: 'customer_id',
    type: 'uuid',
    nullable: false,
    relationship: { tableId: parent.id, onDelete: 'restrict' },
  };
  let child = await draft('orders', [
    relation,
    {
      name: 'total',
      type: 'decimal',
      options: { precision: 12, scale: 2 },
      nullable: false,
    },
  ]);
  await t.test(
    'draft references do not affect database or deployed docs',
    async () => {
      assert.equal(
        (
          await customer.query(
            'SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename=$2',
            [schema, 'orders'],
          )
        ).rowCount,
        0,
      );
      const docs = await app.inject({ url: base + '/openapi', headers: auth });
      assert.equal(docs.statusCode, 200, docs.body);
      assert.ok(!docs.body.includes('References customers'));
      const targets = await app.inject({
        url: base + '/schema/reference-targets',
        headers: auth,
      });
      assert.equal(targets.statusCode, 200, targets.body);
      assert.deepEqual(targets.json().targets, [
        { id: parent.id, name: 'customers' },
      ]);
    },
  );
  child = await apply(child);
  await enable(child);
  const fk = `fk_${child.fields[0]!.id.replaceAll('-', '')}`,
    index = `ix_fk_${child.fields[0]!.id.replaceAll('-', '')}`;
  await t.test(
    'exact FK/index DDL and incoming triggers preserve parent snapshot',
    async () => {
      const [row] = (
        await customer.query(
          `SELECT confdeltype,confupdtype,condeferrable,convalidated FROM pg_constraint WHERE conname=$1 AND connamespace=$2::regnamespace`,
          [fk, schema],
        )
      ).rows;
      assert.deepEqual(row, {
        confdeltype: 'r',
        confupdtype: 'a',
        condeferrable: false,
        convalidated: true,
      });
      assert.equal(
        (
          await customer.query(
            'SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2',
            [schema, index],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        canonical(
          (await repository.get(project.id, owner, parent.id))
            .appliedDefinition,
        ),
        parentBefore,
      );
      const r = await call('GET', '/customers');
      assert.equal(r.statusCode, 200, r.body);
    },
  );
  await t.test(
    'incoming relationship does not stale a previously published parent workflow',
    async () => {
      const result = await call('POST', '/parent-action', {});
      assert.equal(result.statusCode, 204, result.body);
    },
  );
  let orderId: string;
  await t.test(
    'CRUD validates references, blocks parent delete and filters raw UUIDs',
    async () => {
      const valid = await call('POST', '/orders', {
        customer_id: customerId,
        total: '12.00',
      });
      assert.equal(valid.statusCode, 201, valid.body);
      orderId = valid.json().id;
      assert.equal(valid.json().customer_id, customerId);
      for (const [operationIndex, r] of [
        await call('POST', '/orders', {
          customer_id: randomUUID(),
          total: '1.00',
        }),
        await call('PATCH', `/orders/${orderId}`, {
          customer_id: randomUUID(),
        }),
        await call('DELETE', `/customers/${customerId}`),
      ].entries()) {
        assert.equal(
          r.statusCode,
          409,
          `operation ${operationIndex}: ${r.body}`,
        );
        assert.equal(r.json().code, 'RELATIONSHIP_CONFLICT');
        assert.ok(!r.body.includes(fk));
        assert.ok(!r.body.includes(customerId));
      }
      assert.equal(
        (await call('PATCH', `/orders/${orderId}`, { customer_id: customerId }))
          .statusCode,
        200,
      );
      const filtered = await call(
        'GET',
        `/orders?filter[customer_id]=${customerId}`,
      );
      assert.equal(filtered.statusCode, 200, filtered.body);
      assert.equal(filtered.json().data.length, 1);
    },
  );
  await t.test(
    'applied OpenAPI has UUID/public relationship descriptions without IDs',
    async () => {
      const r = await app.inject({ url: base + '/openapi', headers: auth });
      assert.equal(r.statusCode, 200, r.body);
      assert.match(r.body, /References customers.id/);
      assert.ok(!r.body.includes(parent.id));
      assert.ok(!r.body.includes(fk));
      assert.ok(!r.body.includes(index));
      assert.equal(
        r.json().paths['/orders'].post.requestBody.content['application/json']
          .schema.properties.customer_id.format,
        'uuid',
      );
    },
  );
  await t.test(
    'nullable addition and immutable relationship rules',
    async () => {
      const added = await repository.update(
        project.id,
        owner,
        child.id,
        child.draftRevision,
        {
          name: child.name,
          fields: [
            ...child.fields.map(({ position: _, default: d, ...f }) => ({
              ...f,
              ...(d ? { default: d } : {}),
            })),
            { ...relation, name: 'other_customer_id', nullable: true },
          ],
        },
      );
      child = await apply(added);
      assert.equal(
        (
          await call('PATCH', `/orders/${orderId!}`, {
            other_customer_id: null,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await call('PATCH', `/orders/${orderId!}`, {
            other_customer_id: customerId,
          })
        ).statusCode,
        200,
      );
      await assert.rejects(
        repository.update(project.id, owner, parent.id, parent.draftRevision, {
          name: parent.name,
          fields: [
            ...parent.fields.map(({ position: _, default: d, ...f }) => ({
              ...f,
              ...(d ? { default: d } : {}),
            })),
            {
              ...relation,
              name: 'order_id',
              nullable: true,
              relationship: { tableId: child.id, onDelete: 'restrict' },
            },
          ],
        }),
        /circular table dependency/,
      );
    },
  );
  await t.test('workflow FK violation rolls back earlier write', async () => {
    const first = randomUUID(),
      second = randomUUID();
    const definition: WorkflowDefinition = {
      auth: 'key_only',
      input: { customer: { type: 'uuid', required: true } },
      steps: [
        {
          id: first,
          name: 'first_write',
          type: 'insert',
          tableId: parent.id,
          access: { mode: 'key_only' },
          values: {
            [parent.fields[0]!.id]: {
              kind: 'literal',
              value: 'Must roll back',
            },
          },
          select: ['id'],
        },
        {
          id: second,
          name: 'second_write',
          type: 'insert',
          tableId: child.id,
          access: { mode: 'key_only' },
          values: {
            [child.fields[0]!.id]: {
              kind: 'reference',
              source: 'request',
              path: ['body', 'customer'],
            },
            [child.fields[1]!.id]: { kind: 'literal', value: '1.00' },
          },
          select: ['id'],
        },
        { id: randomUUID(), name: 'done', type: 'response', status: 204 },
      ],
    };
    const created = await app.inject({
      method: 'POST',
      url: base + '/workflows',
      headers: auth,
      payload: { path: 'place-order', definition },
    });
    assert.equal(created.statusCode, 201, created.body);
    const path = base + '/workflows/' + created.json().id;
    const preview = await app.inject({
      method: 'POST',
      url: path + '/preview',
      headers: auth,
    });
    assert.equal(preview.statusCode, 200, preview.body);
    const published = await app.inject({
      method: 'POST',
      url: path + '/publish',
      headers: auth,
      payload: {
        expectedDraftRevision: 1,
        definitionHash: preview.json().definitionHash,
      },
    });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: path,
          headers: auth,
          payload: { expectedDraftRevision: 1, enabled: true },
        })
      ).statusCode,
      200,
    );
    const result = await call('POST', '/place-order', {
      customer: randomUUID(),
    });
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(result.json().code, 'RELATIONSHIP_CONFLICT');
    assert.equal(
      (
        await customer.query(
          `SELECT count(*)::int AS n FROM ${q(schema)}.customers WHERE name=$1`,
          ['Must roll back'],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await call('POST', '/place-order', { customer: customerId })).statusCode,
      204,
    );
  });
  await t.test(
    'relationship child revision requires republish while parent workflow stays usable',
    async () => {
      child = await apply(
        await repository.update(
          project.id,
          owner,
          child.id,
          child.draftRevision,
          {
            name: child.name,
            fields: [
              ...child.fields.map(({ position: _, default: d, ...f }) => ({
                ...f,
                ...(d ? { default: d } : {}),
              })),
              { name: 'note', type: 'text', nullable: true },
            ],
          },
        ),
      );
      assert.equal(
        (await call('POST', '/place-order', { customer: customerId }))
          .statusCode,
        503,
      );
      const parentResult = await call('POST', '/parent-action', {});
      assert.equal(parentResult.statusCode, 204, parentResult.body);
    },
  );
  await t.test(
    'missing index and disabled FK enforcement fail closed for child and parent',
    async () => {
      await customer.query(
        `ALTER TABLE ${q(schema)}.orders DISABLE TRIGGER ALL`,
      );
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      assert.equal((await call('GET', '/customers')).statusCode, 503);
      await customer.query(
        `ALTER TABLE ${q(schema)}.orders ENABLE TRIGGER ALL`,
      );
      await customer.query(`DROP INDEX ${q(schema)}.${q(index)}`);
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      await customer.query(
        `CREATE INDEX ${q(index)} ON ${q(schema)}.orders USING btree (customer_id)`,
      );
      assert.equal((await call('GET', '/orders')).statusCode, 200);
    },
  );
  await t.test(
    'missing/retargeted/unvalidated/extra FKs and changed indexes fail closed',
    async () => {
      const table = `${q(schema)}.orders`;
      const recreate = async (action = 'RESTRICT', tail = '') =>
        customer.query(
          `ALTER TABLE ${table} ADD CONSTRAINT ${q(fk)} FOREIGN KEY(customer_id) REFERENCES ${q(schema)}.customers(id) ON DELETE ${action} ON UPDATE NO ACTION NOT DEFERRABLE ${tail}`,
        );
      await customer.query(`ALTER TABLE ${table} DROP CONSTRAINT ${q(fk)}`);
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      assert.equal((await call('GET', '/customers')).statusCode, 503);
      await customer.query(
        `CREATE TABLE ${q(schema)}.other_customers (id uuid PRIMARY KEY)`,
      );
      await customer.query(
        `INSERT INTO ${q(schema)}.other_customers SELECT id FROM ${q(schema)}.customers`,
      );
      await customer.query(
        `ALTER TABLE ${table} ADD CONSTRAINT ${q(fk)} FOREIGN KEY(customer_id) REFERENCES ${q(schema)}.other_customers(id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE`,
      );
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      await customer.query(`ALTER TABLE ${table} DROP CONSTRAINT ${q(fk)}`);
      await customer.query(`DROP TABLE ${q(schema)}.other_customers`);
      await recreate('CASCADE');
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      await customer.query(`ALTER TABLE ${table} DROP CONSTRAINT ${q(fk)}`);
      await recreate('RESTRICT', 'NOT VALID');
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      await customer.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${q(fk)}`);
      assert.equal((await call('GET', '/orders')).statusCode, 200);
      await customer.query(
        `ALTER TABLE ${table} ALTER CONSTRAINT ${q(fk)} DEFERRABLE`,
      );
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      await customer.query(
        `ALTER TABLE ${table} ALTER CONSTRAINT ${q(fk)} NOT DEFERRABLE`,
      );
      await customer.query(`DROP INDEX ${q(schema)}.${q(index)}`);
      await customer.query(`CREATE INDEX ${q(index)} ON ${table}(total)`);
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      await customer.query(`DROP INDEX ${q(schema)}.${q(index)}`);
      await customer.query(`CREATE INDEX ${q(index)} ON ${table}(customer_id)`);
      await customer.query(
        `ALTER TABLE ${table} ADD CONSTRAINT unexpected_fk FOREIGN KEY(customer_id) REFERENCES ${q(schema)}.customers(id)`,
      );
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      assert.equal((await call('GET', '/customers')).statusCode, 503);
      await customer.query(
        `ALTER TABLE ${table} DROP CONSTRAINT unexpected_fk`,
      );
      await customer.query(
        `ALTER TABLE ${q(schema)}.customers ADD COLUMN external_drift text`,
      );
      assert.equal((await call('GET', '/orders')).statusCode, 503);
      await customer.query(
        `ALTER TABLE ${q(schema)}.customers DROP COLUMN external_drift`,
      );
      assert.equal((await call('GET', '/orders')).statusCode, 200);
    },
  );
  await t.test(
    'interrupted FK Apply reconciles exact PRE/POST/DIVERGED without DDL replay',
    async () => {
      const make = async (name: string) => {
        const table = await draft(name, [{ ...relation, nullable: true }]);
        const plan = generatePlan(
          table,
          await repository.list(project.id, owner),
        );
        const id = await repository.begin(project.id, owner, table.id, plan);
        return {
          table,
          plan: {
            ...plan,
            receipt: { projectId: project.id, operationId: id },
          },
          id,
        };
      };
      const pre = await make('pre_state');
      assert.equal(
        (await reconcile(db, encryption, project.id, pre.id, 'schema'))
          .classification,
        'PRE_STATE',
      );
      await reconcile(db, encryption, project.id, pre.id, 'schema', true);
      const post = await make('post_state');
      await createSchemaExecutor(undefined, encryption)(
        config,
        post.plan,
        null,
      );
      assert.equal(
        (await reconcile(db, encryption, project.id, post.id, 'schema'))
          .classification,
        'POST_STATE',
      );
      const managedIndex = `ix_fk_${post.table.fields[0]!.id.replaceAll('-', '')}`;
      await customer.query(`DROP INDEX ${q(schema)}.${q(managedIndex)}`);
      assert.equal(
        (await reconcile(db, encryption, project.id, post.id, 'schema'))
          .classification,
        'DIVERGED',
      );
      await customer.query(
        `CREATE INDEX ${q(managedIndex)} ON ${q(schema)}.post_state USING btree (customer_id)`,
      );
      const postFk = `fk_${post.table.fields[0]!.id.replaceAll('-', '')}`;
      await customer.query(
        `ALTER TABLE ${q(schema)}.post_state DROP CONSTRAINT ${q(postFk)}`,
      );
      assert.equal(
        (await reconcile(db, encryption, project.id, post.id, 'schema'))
          .classification,
        'DIVERGED',
      );
      await customer.query(
        `ALTER TABLE ${q(schema)}.post_state ADD CONSTRAINT ${q(postFk)} FOREIGN KEY(customer_id) REFERENCES ${q(schema)}.customers(id) ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE`,
      );
      await customer.query(
        `ALTER TABLE ${q(schema)}.post_state DISABLE TRIGGER ALL`,
      );
      assert.equal(
        (await reconcile(db, encryption, project.id, post.id, 'schema'))
          .classification,
        'DIVERGED',
      );
      await customer.query(
        `ALTER TABLE ${q(schema)}.post_state ENABLE TRIGGER ALL`,
      );
      const [comment] = (
        await customer.query(
          "SELECT obj_description($1::regclass,'pg_class') AS receipt",
          [`${q(schema)}.post_state`],
        )
      ).rows;
      await customer.query(`COMMENT ON TABLE ${q(schema)}.post_state IS NULL`);
      assert.equal(
        (await reconcile(db, encryption, project.id, post.id, 'schema'))
          .classification,
        'DIVERGED',
      );
      await customer.query(
        `COMMENT ON TABLE ${q(schema)}.post_state IS '${String(comment.receipt).replaceAll("'", "''")}'`,
      );
      assert.equal(
        (await reconcile(db, encryption, project.id, post.id, 'schema', true))
          .classification,
        'POST_STATE',
      );
      const partial = await make('partial_state');
      await customer.query(
        `CREATE TABLE ${q(schema)}.partial_state (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid)`,
      );
      assert.equal(
        (await reconcile(db, encryption, project.id, partial.id, 'schema'))
          .classification,
        'DIVERGED',
      );
      await customer.query(`DROP TABLE ${q(schema)}.partial_state`);
      assert.equal(
        (
          await reconcile(
            db,
            encryption,
            project.id,
            partial.id,
            'schema',
            true,
          )
        ).classification,
        'PRE_STATE',
      );
    },
  );
});
