import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../../src/app.js';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { parseDatabaseUrl } from '../../src/config/env.js';
import { users, platformSessions, projects, schemaTables, databaseConnections, projectAuthConfigs, workflowEndpoints } from '../../src/database/platform-db/schema.js';
import { PostgresPlatformAuthRepository } from '../../src/modules/platform-auth/repository.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { PostgresEndpointRepository } from '../../src/modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { PostgresAuthRepository } from '../../src/modules/project-auth/repository.js';
import { PostgresWorkflowRepository } from '../../src/modules/workflows/repository.js';
import { env } from '../helpers.js';
import { platformTokenHash } from '../../src/modules/platform-auth/service.js';
test('real platform authentication persistence, constraints, races and all management ownership boundaries', async (t) => {
  const url = parseDatabaseUrl(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL');
  if (url === process.env.PLATFORM_DATABASE_URL) throw new Error('Use a disposable test database');
  const { db, pool } = createPlatformDatabase(url);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)) });
  const repository = new PostgresPlatformAuthRepository(db);
  const app = buildApp({ env, logger: false, platformAuthRepository: repository, projectRepository: new PostgresProjectRepository(db),
    connectionRepository: new PostgresConnectionRepository(db), connectionTester: async () => {}, schemaRepository: new PostgresSchemaRepository(db),
    endpointRepository: new PostgresEndpointRepository(db), apiKeyRepository: new PostgresApiKeyRepository(db), authRepository: new PostgresAuthRepository(db), workflowRepository: new PostgresWorkflowRepository(db) });
  const suffix = randomUUID(); const password = 'platform-integration-password-123';
  const emails = [`a-${suffix}@example.test`, `b-${suffix}@example.test`, `legacy-${suffix}@example.test`];
  const ids: string[] = []; let projectId: string | undefined;
  t.after(async () => {
    await app.close();
    if (projectId) {
      await db.delete(workflowEndpoints).where(eq(workflowEndpoints.projectId, projectId));
      await db.delete(projectAuthConfigs).where(eq(projectAuthConfigs.projectId, projectId));
      await db.delete(schemaTables).where(eq(schemaTables.projectId, projectId));
      await db.delete(databaseConnections).where(eq(databaseConnections.projectId, projectId));
      await db.delete(projects).where(eq(projects.id, projectId));
    }
    await db.delete(users).where(inArray(users.email, emails)); await pool.end();
  });
  const signup = (email: string) => app.inject({ method: 'POST', url: '/internal/auth/signup', payload: { email, password } });
  const race = await Promise.all([signup(emails[0]!), signup(emails[0]!.toUpperCase())]);
  assert.deepEqual(race.map((r) => r.statusCode), [202, 202]); assert.equal(race[0]!.body, race[1]!.body);
  await signup(emails[1]!);
  const login = async (email: string) => {
    const result = await app.inject({ method: 'POST', url: '/internal/auth/login', payload: { email, password } });
    assert.equal(result.statusCode, 200, result.body); ids.push(result.json().user.id); return result.json() as { user: { id: string }; sessionToken: string };
  };
  const a = await login(emails[0]!); const b = await login(emails[1]!);
  const ah = { authorization: `Bearer ${a.sessionToken}` }; const bh = { authorization: `Bearer ${b.sessionToken}` };
  const created = await app.inject({ method: 'POST', url: '/internal/projects', headers: ah, payload: { name: 'Private project', slug: `auth-${suffix}` } });
  assert.equal(created.statusCode, 201, created.body); projectId = created.json().id;
  assert.equal(created.json().ownerId, a.user.id);
  const base = `/internal/projects/${projectId}`;
  const connection = await app.inject({ method: 'POST', url: base + '/database-connection', headers: ah, payload: {
    label: 'Owned connection', host: 'localhost', port: 5432, database: 'test', username: 'test', password: 'connection-secret', schema: 'public', ssl: false,
  } }); assert.equal(connection.statusCode, 201, connection.body);
  const table = await app.inject({ method: 'POST', url: base + '/schema/tables', headers: ah, payload: { name: 'records', fields: [] } });
  assert.equal(table.statusCode, 201, table.body); const tableId = table.json().id;
  const key = await app.inject({ method: 'POST', url: base + '/api-keys', headers: ah, payload: { name: 'test', scope: 'read' } });
  assert.equal(key.statusCode, 201, key.body);
  const config = await app.inject({ method: 'PUT', url: base + '/auth', headers: ah, payload: { enabled: false, signupEnabled: false, expectedRevision: 0 } });
  assert.equal(config.statusCode, 200, config.body);
  const workflow = await app.inject({ method: 'POST', url: base + '/workflows', headers: ah, payload: { path: 'private-flow', definition: {
    auth: 'key_only', input: {}, steps: [{ id: randomUUID(), name: 'done', type: 'response', status: 200, body: { kind: 'object', fields: {} } }],
  } } }); assert.equal(workflow.statusCode, 201, workflow.body);
  for (const path of ['', '/database-connection', '/schema', `/schema/tables/${tableId}`, '/endpoints', '/api-keys', '/auth', '/workflows', `/workflows/${workflow.json().id}`]) {
    assert.equal((await app.inject({ url: base + path, headers: bh })).statusCode, 404, path);
  }
  for (const [method, path, payload] of [
    ['DELETE', '/database-connection', undefined], ['POST', '/database-connection/test', undefined],
    ['DELETE', `/schema/tables/${tableId}`, undefined], ['DELETE', `/api-keys/${key.json().id}`, undefined],
    ['POST', '/api-keys', { name: 'stolen', scope: 'read' }],
    ['PUT', '/auth', { enabled: true, signupEnabled: true, expectedRevision: 1 }],
  ] as const) assert.equal((await app.inject({ method, url: base + path, headers: bh, ...(payload ? { payload } : {}) })).statusCode, 404, path);
  for (const credential of [key.json().key, 'us_' + 'a'.repeat(43)]) assert.equal((await app.inject({ url: base, headers: { authorization: `Bearer ${credential}` } })).statusCode, 401);
  // Unique email index, session foreign key, status and expiry database checks.
  await assert.rejects(db.insert(users).values({ email: emails[0]!.toUpperCase() }));
  await assert.rejects(db.insert(users).values({ email: 'invalid-' + suffix, status: 'admin' }));
  await assert.rejects(db.insert(platformSessions).values({ userId: randomUUID(), tokenHash: 'f'.repeat(64), expiresAt: new Date(Date.now() + 10000) }));
  await assert.rejects(db.insert(platformSessions).values({ userId: a.user.id, tokenHash: 'e'.repeat(64), expiresAt: new Date(0) }));
  const stored = await repository.findSession(platformTokenHash(a.sessionToken)); assert.ok(stored);
  await db.update(users).set({ status: 'disabled', updatedAt: new Date() }).where(eq(users.id, a.user.id));
  assert.equal((await app.inject({ url: base, headers: ah })).statusCode, 401);
  await db.update(users).set({ status: 'active', updatedAt: new Date() }).where(eq(users.id, a.user.id));
  assert.equal((await app.inject({ method: 'POST', url: '/internal/auth/logout', headers: ah })).statusCode, 204);
  const freshRepository = new PostgresPlatformAuthRepository(db);
  assert.ok((await freshRepository.findSession(platformTokenHash(a.sessionToken)))?.revokedAt);
  assert.equal((await app.inject({ url: base, headers: ah })).statusCode, 401);
  const [legacy] = await db.insert(users).values({ email: emails[2]! }).returning();
  await signup(emails[2]!);
  const unchanged = await repository.findUser(emails[2]!); assert.equal(unchanged!.id, legacy!.id); assert.equal(unchanged!.passwordHash, null); assert.equal(unchanged!.status, 'disabled');
});
