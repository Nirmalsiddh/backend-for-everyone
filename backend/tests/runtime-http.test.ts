import { memoryPlatformAuthRepository } from './platform-auth-helpers.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { env, memoryRepository, token } from './helpers.js';
import { hashKey } from '../src/modules/api-keys/service.js';
import { CredentialEncryption } from '../src/security/encryption.js';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import type { RuntimeRepository, RuntimeTarget } from '../src/runtime/types.js';
import { RuntimeError } from '../src/runtime/errors.js';
test('runtime HTTP authentication, fixed routing, CORS, errors, and safe logging', async () => {
  const projectId = randomUUID(); const connectionId = randomUUID(); const id = randomUUID();
  const read = `pk_${'a'.repeat(43)}`; const write = `pk_${'b'.repeat(43)}`;
  const config = { host: 'private.example', port: 5432, database: 'private_database', username: 'private_user', password: 'private_password', schema: 'public', ssl: true };
  const target: RuntimeTarget = { endpointId: randomUUID(), projectId, enabledOperations: ['list', 'get', 'create', 'update', 'delete'], blocked: false,
    applied: { definition: { schema: 'public', ...normalizeDraft({ name: 'products', fields: [{ name: 'sku', type: 'text', nullable: false }] }) }, catalog: {} },
    connection: { id: connectionId, projectId, label: 'Fixture', ...new CredentialEncryption(env.connectionEncryptionKey).encrypt(config, `${projectId}:${connectionId}`), lastTestStatus: 'success', lastTestedAt: new Date(), createdAt: new Date(), updatedAt: new Date() } };
  const repository: RuntimeRepository = {
    async authenticate(slug, hash) { return slug === 'shop' && [hashKey(read), hashKey(write)].includes(hash) ? { projectId, keyId: 'safe-key-id', scope: hash === hashKey(read) ? 'read' : 'read_write' } : undefined; },
    async resolve(pid, resource) { return pid === projectId && resource === 'products' ? target : undefined; },
  };
  let failure: unknown; let calls = 0;
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository("11111111-1111-4111-8111-111111111111"), env: { ...env, runtimeAllowedOrigins: ['https://frontend.example'] }, projectRepository: memoryRepository(), runtimeRepository: repository,
    runtimeExecutor: async (_config, _applied, query) => { calls++; if (failure) throw failure; return query.text.startsWith('SELECT') ? [{ id, sku: 'ABC', external_secret: 'must-not-leak' }] : [{ id, sku: 'ABC' }]; }, logger: false });
  const logs: unknown[] = [];
  app.addHook('onRequest', async (req) => { req.log.info = (...args: unknown[]) => { logs.push(args); }; });
  const headers = { authorization: `Bearer ${write}` }; const base = '/api/shop/products';
  try {
    for (const authorization of [undefined, `Bearer ${token}`, 'Bearer invalid', `Bearer pk_${'c'.repeat(43)}`]) {
      const response = await app.inject({ url: base, headers: authorization ? { authorization } : {} });
      assert.equal(response.statusCode, 401); assert.ok(response.json().requestId);
    }
    assert.equal((await app.inject({ url: '/api/other/products', headers })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: base, headers: { authorization: `Bearer ${read}` }, payload: { sku: 'x' } })).statusCode, 403);
    const preflight = await app.inject({ method: 'OPTIONS', url: base, headers: { origin: 'https://frontend.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers['access-control-allow-origin'], 'https://frontend.example');
    assert.equal((await app.inject({ method: 'OPTIONS', url: base, headers: { origin: 'https://untrusted.example' } })).headers['access-control-allow-origin'], undefined);
    const list = await app.inject({ url: base, headers });
    assert.equal(list.statusCode, 200); assert.equal(list.json().data[0].sku, 'ABC'); assert.ok(!list.body.includes('external_secret'));
    const created = await app.inject({ method: 'POST', url: base, headers, payload: { sku: 'ABC' } });
    assert.equal(created.statusCode, 201); assert.equal(created.headers.location, `${base}/${id}`);
    assert.equal((await app.inject({ method: 'PATCH', url: `${base}/${id}`, headers, payload: { sku: 'NEW' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `${base}/${id}`, headers })).body, '');
    for (const payload of [{ id }, { unknown: 'x' }, []]) assert.equal((await app.inject({ method: 'POST', url: base, headers, payload })).statusCode, 400);
    assert.equal((await app.inject({ url: `${base}/invalid-uuid`, headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: base, headers, payload: { sku: 'x'.repeat(70000) } })).statusCode, 413);
    assert.equal((await app.inject({ url: `${base}?sort=sku%3BDROP`, headers })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/shop/missing', headers })).statusCode, 404);
    target.enabledOperations = [];
    assert.equal((await app.inject({ url: base, headers })).statusCode, 404);
    target.enabledOperations = ['list']; target.blocked = true;
    assert.equal((await app.inject({ url: base, headers })).statusCode, 503); target.blocked = false;
    for (const error of [new Error('private_password SELECT SQLSTATE constraint private_database'), new RuntimeError(504, 'QUERY_TIMEOUT', 'Customer database request timed out')]) {
      failure = error;
      const response = await app.inject({ url: base, headers });
      assert.equal(response.statusCode, error instanceof RuntimeError ? 504 : 500); assert.ok(response.json().requestId);
      assert.ok(!response.body.includes('private_password')); assert.ok(!response.body.includes('SQLSTATE'));
    }
    const text = JSON.stringify(logs);
    for (const secret of [read, write, 'private_password', 'private_database', 'must-not-leak', 'sort=sku', 'SELECT SQLSTATE']) assert.ok(!text.includes(secret));
    assert.ok(calls > 0);
    assert.equal((await app.inject({ method: 'PUT', url: `${base}/${id}`, headers, payload: {} })).statusCode, 404);
  } finally { await app.close(); }
});
