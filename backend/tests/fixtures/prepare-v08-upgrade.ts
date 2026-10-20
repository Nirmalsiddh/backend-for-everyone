// Executed in a separate process against source archived from the exact v0.8 commit.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
const root = process.env.V08_SOURCE_DIR!;
const old = (path: string) => import(pathToFileURL(resolve(root, 'backend', path)).href);
const [{ buildApp }, { createPlatformDatabase }, models, { PostgresProjectRepository }, { PostgresConnectionRepository }, { PostgresSchemaRepository }, { PostgresEndpointRepository }, { PostgresApiKeyRepository }, { PostgresRuntimeRepository }, { PostgresWorkflowRepository }, { generatePlan }, { createSchemaExecutor }, { CredentialEncryption }, { memoryPlatformAuthRepository }, { auth, env }] = await Promise.all([
  old('src/app.ts'), old('src/database/platform-db/client.ts'), old('src/database/platform-db/schema.ts'), old('src/modules/projects/repository.ts'), old('src/modules/database-connections/repository.ts'), old('src/modules/schema-builder/repository.ts'), old('src/modules/endpoints/repository.ts'), old('src/modules/api-keys/repository.ts'), old('src/runtime/repository.ts'), old('src/modules/workflows/repository.ts'), old('src/modules/schema-builder/plan.ts'), old('src/database/customer-db/schema-executor.ts'), old('src/security/encryption.ts'), old('tests/platform-auth-helpers.ts'), old('tests/helpers.ts'),
]);
const { db, pool } = createPlatformDatabase(process.env.TEST_V08_DATABASE_URL!);
await migrate(db, { migrationsFolder: resolve(root, 'backend/migrations') });
const url = new URL(process.env.TEST_CUSTOMER_DATABASE_URL!);
const customer = new pg.Client({ connectionString: url.toString() }); await customer.connect();
const owner = randomUUID(), schema = 'upgrade_' + randomUUID().replaceAll('-', '');
await customer.query(`CREATE SCHEMA "${schema}"`);
await db.insert(models.users).values({ id: owner, email: owner + '@example.test' });
const projectRepository = new PostgresProjectRepository(db);
const project = await projectRepository.create(owner, { name: 'Exact v0.8', slug: 'upgrade-' + randomUUID() });
const repository = new PostgresSchemaRepository(db);
const app = buildApp({ projectRepository, schemaRepository: repository, connectionRepository: new PostgresConnectionRepository(db), endpointRepository: new PostgresEndpointRepository(db), apiKeyRepository: new PostgresApiKeyRepository(db), runtimeRepository: new PostgresRuntimeRepository(db), workflowRepository: new PostgresWorkflowRepository(db), platformAuthRepository: memoryPlatformAuthRepository(owner), env, logger: false });
const base = '/internal/projects/' + project.id;
const config = { host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema, ssl: false };
const connected = await app.inject({ method: 'POST', url: base + '/database-connection', headers: auth, payload: { ...config, label: 'Exact baseline' } });
if (connected.statusCode !== 201) throw new Error(connected.body);
const golden: unknown[] = [];
async function table(name: string, fields: unknown[], apply = true) {
  const created = await app.inject({ method: 'POST', url: base + '/schema/tables', headers: auth, payload: { name, fields } }); if (created.statusCode !== 201) throw new Error(created.body);
  const record = await repository.get(project.id, owner, created.json().id);
  const tables = await repository.list(project.id, owner); const plan = generatePlan(record, tables);
  golden.push({ table: record, tables, hash: plan.hash });
  const operationId = await repository.begin(project.id, owner, record.id, plan);
  const snapshot = await createSchemaExecutor(undefined, new CredentialEncryption(env.connectionEncryptionKey))(config, { ...plan, receipt: { projectId: project.id, operationId } }, null);
  if (apply) await repository.finish(project.id, owner, record.id, operationId, plan, 'applied', snapshot, null);
  return { record: await repository.get(project.id, owner, record.id), operationId };
}
const target = await table('customers', [{ name: 'name', type: 'text' }]);
const source = await table('orders', [{ name: 'customer_id', type: 'uuid', relationship: { tableId: target.record.id, onDelete: 'restrict' } }, { name: 'value_key', type: 'integer' }]);
for (const item of [target, source]) await new PostgresEndpointRepository(db).save(project.id, owner, item.record.id, { enabledOperations: ['get', 'list', 'create'], expectedAppliedRevision: item.record.appliedRevision, expectedConfigRevision: 0 });
const key = (await app.inject({ method: 'POST', url: base + '/api-keys', headers: auth, payload: { name: 'Old key', scope: 'read_write' } })).json().key;
const bearer = { authorization: 'Bearer ' + key };
const customerRecord = (await app.inject({ method: 'POST', url: `/api/${project.slug}/customers`, headers: bearer, payload: { name: 'Old customer' } })).json();
const order = (await app.inject({ method: 'POST', url: `/api/${project.slug}/orders`, headers: bearer, payload: { customer_id: customerRecord.id, value_key: 3 } })).json();
const expanded = await app.inject({ url: `/api/${project.slug}/orders/${order.id}?include=customer_id`, headers: bearer }); if (expanded.statusCode !== 200) throw new Error(expanded.body);
const pending = await table('legacy_pending', [{ name: 'counter', type: 'integer' }, { name: 'customer_id', type: 'uuid', relationship: { tableId: target.record.id, onDelete: 'restrict' } }], false);
const objects = (await customer.query('SELECT c.relname,c.oid::text,obj_description(c.oid,\'pg_class\') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname', [schema])).rows;
await writeFile(process.env.V08_FIXTURE_OUTPUT!, JSON.stringify({ owner, project, schema, sourceId: source.record.id, targetId: target.record.id, pendingId: pending.record.id, operationId: pending.operationId, order, expanded: expanded.json(), key, golden, objects }));
await app.close(); await customer.end(); await pool.end();
