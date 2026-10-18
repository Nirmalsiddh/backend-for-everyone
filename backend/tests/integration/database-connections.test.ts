import { memoryPlatformAuthRepository } from '../platform-auth-helpers.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../../src/app.js';
import { parseDatabaseUrl } from '../../src/config/env.js';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { databaseConnections, projects, users } from '../../src/database/platform-db/schema.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { CredentialEncryption } from '../../src/security/encryption.js';
import { createConnectionTester } from '../../src/database/customer-db/connection-test.js';
import { auth, env } from '../helpers.js';

// Both URLs must point to disposable databases. The customer URL must use password authentication.
test('real PostgreSQL customer connection lifecycle and failed credential replacement', async (t) => {
  const platformUrl = parseDatabaseUrl(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
  const customerUrl = new URL(parseDatabaseUrl(process.env.TEST_CUSTOMER_DATABASE_URL, 'TEST_CUSTOMER_DATABASE_URL'));
  if (platformUrl === process.env.PLATFORM_DATABASE_URL) throw new Error('Use a separate disposable platform database');
  if (customerUrl.toString() === new URL(platformUrl).toString()) throw new Error('Use a separate customer database');
  const { db, pool } = createPlatformDatabase(platformUrl);
  const ownerId = randomUUID();
  let projectId: string | undefined;
  t.after(async () => {
    try {
      if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
      await db.delete(users).where(eq(users.id, ownerId));
    } finally { await pool.end(); }
  });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)) });
  await db.insert(users).values({ id: ownerId, email: `${ownerId}@example.test` });
  const projectRepository = new PostgresProjectRepository(db);
  const project = await projectRepository.create(ownerId, { name: 'Connection test', slug: `connection-${randomUUID()}` });
  projectId = project.id;
  const repository = new PostgresConnectionRepository(db);
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository(ownerId), env, projectRepository,
    connectionRepository: repository, logger: false });
  t.after(() => app.close());
  const path = `/internal/projects/${project.id}/database-connection`;
  const input = {
    label: 'Integration customer', host: customerUrl.hostname, port: Number(customerUrl.port || 5432),
    database: decodeURIComponent(customerUrl.pathname.slice(1)), username: decodeURIComponent(customerUrl.username),
    password: decodeURIComponent(customerUrl.password), schema: 'public', ssl: false,
  };
  assert.ok(input.password, 'Customer test database must require a password');
  const safe = (body: string) => {
    for (const secret of [input.password, 'encryptedConfig', 'encryptionIv', 'encryptionTag', env.connectionEncryptionKey]) {
      assert.ok(!body.includes(secret), 'Secret appeared in API response');
    }
  };
  const create = await app.inject({ method: 'POST', url: path, headers: auth, payload: input });
  assert.equal(create.statusCode, 201, create.body); safe(create.body);
  const metadata=await app.inject({url:path,headers:auth});
  assert.equal(metadata.json().identity.host,input.host);
  assert.equal(metadata.json().identity.database,input.database);
  assert.equal(metadata.json().replacement.eligible,true);
  safe(metadata.body);
  const original = (await repository.findOwned(project.id, ownerId))!;
  assert.ok(original);
  assert.ok(!JSON.stringify(original).includes(input.password));
  const encryption = new CredentialEncryption(env.connectionEncryptionKey);
  const { label: _label, ...config } = input;
  assert.deepEqual(encryption.decrypt(original, `${project.id}:${original.id}`), config);
  assert.equal(await repository.findOwned(project.id, randomUUID()), undefined);
  await assert.rejects(repository.create({ ...original, id: randomUUID() }, ownerId), { code: 'CONNECTION_EXISTS' });
  assert.equal((await app.inject({ method: 'POST', url: path, headers: auth, payload: input })).statusCode, 409);
  const fetched = await app.inject({ url: path, headers: auth });
  assert.equal(fetched.statusCode, 200); safe(fetched.body);
  const beforeFailure = await repository.findOwned(project.id, ownerId);
  const failed = await app.inject({ method: 'PUT', url: path, headers: auth,
    payload: { ...input, password: 'deliberately-incorrect-password' } });
  assert.equal(failed.statusCode, 422, failed.body);
  assert.equal(failed.json().code, 'AUTHENTICATION_FAILED'); safe(failed.body);
  assert.deepEqual(await repository.findOwned(project.id, ownerId), beforeFailure);
  const missingSchema = await app.inject({ method: 'PUT', url: path, headers: auth,
    payload: { ...input, schema: `missing_${randomUUID()}` } });
  assert.equal(missingSchema.statusCode, 422, missingSchema.body);
  assert.equal(missingSchema.json().code, 'SCHEMA_UNAVAILABLE');
  assert.deepEqual(await repository.findOwned(project.id, ownerId), beforeFailure);
  const retest = await app.inject({ method: 'POST', url: `${path}/test`, headers: auth });
  assert.equal(retest.statusCode, 200, retest.body); safe(retest.body);
  const updated = await app.inject({ method: 'PUT', url: path, headers: auth,
    payload: { ...input, label: 'Updated label' } });
  assert.equal(updated.statusCode, 200, updated.body); safe(updated.body);
  assert.equal(updated.json().id, original.id);
  assert.notEqual((await repository.findOwned(project.id, ownerId))?.encryptedConfig, original.encryptedConfig);
  assert.equal(await repository.markTest(original, ownerId, 'failed', new Date()), undefined);
  assert.equal(await repository.replace(original, ownerId, original.encryptedConfig), undefined);
  assert.equal(await repository.deleteOwned(project.id, randomUUID()), false);
  assert.equal((await app.inject({ method: 'DELETE', url: path, headers: auth })).statusCode, 204);
  assert.equal((await app.inject({ url: path, headers: auth })).statusCode, 404);
  // Removing platform configuration must leave the customer's database available.
  await createConnectionTester()(config);
  assert.equal((await db.select().from(databaseConnections).where(eq(databaseConnections.projectId, project.id))).length, 0);
});
