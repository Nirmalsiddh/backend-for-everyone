import { memoryPlatformAuthRepository } from './platform-auth-helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { connectionTestError } from '../src/modules/database-connections/errors.js';
import { CredentialEncryption } from '../src/security/encryption.js';
import { auth, env, memoryRepository, ownerId, otherOwnerId } from './helpers.js';
import { connectionInput, memoryConnectionRepository } from './connection-helpers.js';

async function setup() {
  const projects = memoryRepository();
  const project = await projects.create(ownerId, { name: 'Shop', slug: 'shop' });
  const foreign = await projects.create(otherOwnerId, { name: 'Other', slug: 'other' });
  const connections = memoryConnectionRepository(projects);
  let calls = 0;
  let failure = false;
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository("11111111-1111-4111-8111-111111111111"), env, projectRepository: projects, connectionRepository: connections, logger: false,
    connectionTester: async () => { calls++; if (failure) throw connectionTestError('AUTHENTICATION_FAILED'); },
  });
  return { app, connections, project, foreign, path: `/internal/projects/${project.id}/database-connection`,
    calls: () => calls, fail: (value: boolean) => { failure = value; } };
}

function assertSafe(body: string) {
  for (const secret of ['password', connectionInput.password, 'encryptedConfig', 'encryptionIv',
    'encryptionTag', 'encryptionVersion', 'connectionEncryptionKey', env.connectionEncryptionKey, 'postgresql://']) {
    assert.ok(!body.includes(secret), `Response contains forbidden value: ${secret}`);
  }
}

test('connection lifecycle returns safe metadata and encrypts the full configuration', async (t) => {
  const fixture = await setup();
  const { app, path, connections, project } = fixture;
  t.after(() => app.close());
  assert.equal((await app.inject({ url: path, headers: auth })).statusCode, 404);
  const created = await app.inject({ method: 'POST', url: path, headers: auth, payload: connectionInput });
  assert.equal(created.statusCode, 201, created.body);
  assertSafe(created.body);
  const record = (await connections.findOwned(project.id, ownerId))!;
  assert.ok(!JSON.stringify(record).includes(connectionInput.password));
  const config = new CredentialEncryption(env.connectionEncryptionKey).decrypt(record, `${project.id}:${record.id}`);
  const { label: _label, ...expected } = connectionInput;
  assert.deepEqual(config, expected);
  const get = await app.inject({ url: path, headers: auth });
  assert.equal(get.statusCode, 200); assertSafe(get.body);
  const duplicate = await app.inject({ method: 'POST', url: path, headers: auth, payload: connectionInput });
  assert.equal(duplicate.statusCode, 409);
  const retest = await app.inject({ method: 'POST', url: `${path}/test`, headers: auth });
  assert.equal(retest.statusCode, 200, retest.body); assertSafe(retest.body);
  const replaced = await app.inject({ method: 'PUT', url: path, headers: auth,
    payload: { ...connectionInput, label: 'Replacement', password: 'new-secret' } });
  assert.equal(replaced.statusCode, 200, replaced.body); assertSafe(replaced.body);
  assert.equal(replaced.json().id, created.json().id);
  assert.equal(replaced.json().createdAt, created.json().createdAt);
  assert.equal(replaced.json().label, 'Replacement');
  assert.equal((await app.inject({ method: 'DELETE', url: path, headers: auth })).statusCode, 204);
  assert.equal((await app.inject({ url: path, headers: auth })).statusCode, 404);
});

test('failed creation saves nothing; failed replacement preserves all existing data', async (t) => {
  const fixture = await setup();
  const { app, path, connections, project } = fixture;
  t.after(() => app.close());
  fixture.fail(true);
  const failedCreate = await app.inject({ method: 'POST', url: path, headers: auth, payload: connectionInput });
  assert.equal(failedCreate.statusCode, 422); assertSafe(failedCreate.body);
  assert.equal(failedCreate.json().code, 'AUTHENTICATION_FAILED');
  assert.equal(await connections.findOwned(project.id, ownerId), undefined);
  fixture.fail(false);
  await app.inject({ method: 'POST', url: path, headers: auth, payload: connectionInput });
  const before = structuredClone(await connections.findOwned(project.id, ownerId));
  fixture.fail(true);
  const failedPut = await app.inject({ method: 'PUT', url: path, headers: auth,
    payload: { ...connectionInput, password: 'wrong-secret' } });
  assert.equal(failedPut.statusCode, 422); assertSafe(failedPut.body);
  assert.deepEqual(await connections.findOwned(project.id, ownerId), before);
  const failedTest = await app.inject({ method: 'POST', url: `${path}/test`, headers: auth });
  assert.equal(failedTest.statusCode, 422, failedTest.body); assertSafe(failedTest.body);
  assert.equal((await connections.findOwned(project.id, ownerId))?.lastTestStatus, 'failed');
});

test('authentication and ownership checked before any connection test', async (t) => {
  const fixture = await setup();
  const { app, foreign, path } = fixture;
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: path, payload: connectionInput })).statusCode, 401);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
    const response = await app.inject({ method,
      url: `/internal/projects/${foreign.id}/database-connection`, headers: auth,
      ...(method === 'POST' || method === 'PUT' ? { payload: connectionInput } : {}),
    });
    assert.equal(response.statusCode, 404, response.body);
  }
  assert.equal((await app.inject({ method: 'POST',
    url: `/internal/projects/${foreign.id}/database-connection/test`, headers: auth })).statusCode, 404);
  assert.equal(fixture.calls(), 0);
});

test('connection input rejects unknown fields, bad types, blank labels, and socket paths', async (t) => {
  const fixture = await setup();
  t.after(() => fixture.app.close());
  for (const patch of [
    { ssl: 'false' }, { port: '5432' }, { port: 0 }, { port: 65536 },
    { host: '/var/run/postgresql' }, { host: 'postgres://user:pass@host/db' },
    { schema: '' }, { password: '' }, { username: 'bad\u0000name' }, { label: ' ' },
    { arbitrarySql: 'SELECT 1' }, { ssl: { rejectUnauthorized: false } },
  ]) {
    const response = await fixture.app.inject({ method: 'POST', url: fixture.path, headers: auth,
      payload: { ...connectionInput, ...patch } });
    assert.equal(response.statusCode, 400, JSON.stringify(patch));
    assertSafe(response.body);
  }
  assert.equal(fixture.calls(), 0);
});
