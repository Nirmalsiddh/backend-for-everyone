import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { env, memoryRepository } from './helpers.js';
import { CredentialEncryption } from '../src/security/encryption.js';
import { AuthRateLimiter } from '../src/modules/project-auth/rate-limit.js';
import { createPasswordHasher } from '../src/modules/project-auth/passwords.js';
import type { AuthContext, AuthRepository, AuthStore } from '../src/modules/project-auth/types.js';
test('auth HTTP routes limit attempts before hashing and never log credentials or return hashes', async () => {
  const projectId = randomUUID(); const connectionId = randomUUID(); const now = new Date();
  const context: AuthContext = { blocked: false, config: { id: randomUUID(), projectId, connectionId, enabled: true, signupEnabled: true,
    provisioningStatus: 'ready', authSchemaVersion: 1, authUsersTableName: 'reserved', authSessionsTableName: 'reserved', sessionLifetimeSeconds: 86400, revision: 3, createdAt: now, updatedAt: now, catalog: {} },
    connection: { id: connectionId, projectId, label: 'Fixture', ...new CredentialEncryption(env.connectionEncryptionKey).encrypt({}, `${projectId}:${connectionId}`), lastTestStatus: 'success', lastTestedAt: now, createdAt: now, updatedAt: now } };
  const user = { id: randomUUID(), email: 'private@example.test', role: 'user' as const };
  const repository: AuthRepository = { async bySlug() { return context; }, async configure() { return context.config; }, async getOwned() { return context; }, async begin() { return context; }, async finish() {} };
  let hashes = 0; const realHasher = createPasswordHasher();
  const store: AuthStore = {
    async provision() {}, async signup() { return user; }, async findUser() { return undefined; }, async login() {},
    async session() { return { user, sessionId: randomUUID() }; }, async logout() {}, async setRole() { return user; },
  };
  const app = buildApp({ env, projectRepository: memoryRepository(), logger: false, authRepository: repository, authStore: store,
    passwordHasher: { ...realHasher, async hash(password) { hashes++; return realHasher.hash(password); } }, authRateLimiter: new AuthRateLimiter(60000, 2, 2),
    runtimeRepository: { async authenticate() { return undefined; }, async resolve() { return undefined; } } });
  const logs: unknown[] = []; app.addHook('onRequest', async (req) => { req.log.info = (...args: unknown[]) => { logs.push(args); }; });
  try {
    const url = '/api/shop/auth/signup'; const password = 'Private password for tests';
    const first = await app.inject({ method: 'POST', url, payload: { email: 'private@example.test', password } });
    assert.equal(first.statusCode, 201, first.body); assert.deepEqual(first.json(), user);
    assert.equal((await app.inject({ method: 'POST', url, payload: { email: 'private@example.test', password } })).statusCode, 201);
    const denied = await app.inject({ method: 'POST', url, payload: { email: 'private@example.test', password }, headers: { 'x-forwarded-for': '203.0.113.44' } });
    assert.equal(denied.statusCode, 429, denied.body); assert.ok(denied.headers['retry-after']); assert.ok(denied.json().requestId); assert.equal(hashes, 2);
    assert.equal((await app.inject({ method: 'POST', url, payload: { email: 'private@example.test', password, role: 'admin' } })).statusCode, 400);
    const invalid = await app.inject({ method: 'POST', url: '/api/shop/auth/login', payload: { email: 'unknown@example.test', password: 'wrong' } });
    assert.equal(invalid.statusCode, 401); assert.equal(invalid.json().code, 'INVALID_CREDENTIALS');
    const token = `us_${'a'.repeat(43)}`;
    const me = await app.inject({ url: '/api/shop/auth/me', headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(me.json(), user);
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await app.inject({ method: 'POST', url: '/api/shop/auth/logout', headers: { authorization: `Bearer ${token}` } })).statusCode, 204);
    const text = JSON.stringify(logs);
    for (const secret of [password, token, 'private@example.test', 'unknown@example.test', 'password_hash', 'token_hash']) assert.ok(!text.includes(secret));
  } finally { await app.close(); }
});
