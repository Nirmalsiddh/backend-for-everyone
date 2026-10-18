import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { customerConnectionOptions, destinationConfig, publicAddress } from '../src/security/customer-destination.js';
import { memoryPlatformAuthRepository } from './platform-auth-helpers.js';
import { env, memoryRepository } from './helpers.js';
const restricted = { NODE_ENV: 'production', CUSTOMER_DB_ALLOWED_DESTINATIONS: 'db.example.test:5432' };
const options = { host: 'db.example.test', port: 5432, ssl: { rejectUnauthorized: true } };
test('health distinguishes liveness, database readiness/failure and exposes no internals', async (t) => {
  let failure = false;
  const app = buildApp({ env, logger: false, platformAuthRepository: memoryPlatformAuthRepository(), projectRepository: memoryRepository(), readiness: async () => { if (failure) throw new Error('postgresql://secret; raw SQL'); } });
  t.after(() => app.close());
  assert.deepEqual((await app.inject('/health/live')).json(), { status: 'alive' });
  assert.equal((await app.inject('/health/ready')).statusCode, 200);
  failure = true;
  const unavailable = await app.inject('/health/ready');
  assert.equal(unavailable.statusCode, 503); assert.deepEqual(unavailable.json(), { status: 'unavailable' });
});
test('destination policy rejects non-public address families including metadata and transition ranges', async () => {
  for (const address of ['0.0.0.0', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '168.63.129.16', '100.100.100.200', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '2002:7f00:1::', '64:ff9b::7f00:1']) {
    assert.equal(publicAddress(address), false, address);
    await assert.rejects(customerConnectionOptions(options, restricted, async () => [{ address, family: 6 }]), { code: 'DESTINATION_NOT_ALLOWED' });
  }
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
test('exact destination, TLS requirement, DNS pinning, mixed answers, errors and revalidation', async () => {
  await assert.rejects(customerConnectionOptions({ ...options, host: 'other.example.test' }, restricted), { code: 'DESTINATION_NOT_ALLOWED' });
  await assert.rejects(customerConnectionOptions({ ...options, port: 5433 }, restricted), { code: 'DESTINATION_NOT_ALLOWED' });
  await assert.rejects(customerConnectionOptions({ ...options, ssl: false }, restricted), { code: 'TLS_REQUIRED' });
  await assert.rejects(customerConnectionOptions({ ...options, ssl: { rejectUnauthorized: false } }, restricted), { code: 'TLS_REQUIRED' });
  let calls = 0;
  const resolver = async () => { calls++; return [{ address: calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; };
  const pinned = await customerConnectionOptions(options, restricted, resolver);
  assert.equal(pinned.host, '8.8.8.8');
  assert.equal(typeof pinned.ssl === 'object' && pinned.ssl.servername, 'db.example.test');
  assert.equal(typeof pinned.ssl === 'object' && pinned.ssl.rejectUnauthorized, true);
  await assert.rejects(customerConnectionOptions(options, restricted, resolver), { code: 'DESTINATION_NOT_ALLOWED' });
  await assert.rejects(customerConnectionOptions(options, restricted, async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), { code: 'DESTINATION_NOT_ALLOWED' });
  await assert.rejects(customerConnectionOptions(options, restricted, async () => { throw new Error('secret DNS detail'); }), { message: 'Customer database destination is not allowed' });
  await assert.rejects(customerConnectionOptions(options, restricted, async () => []));
  assert.throws(() => destinationConfig({ ...restricted, CUSTOMER_DB_POLICY: 'development' }));
  for (const value of ['*.example.test:5432', 'http://db.example.test:5432', 'db.example.test:0', '127.0.0.1:5432', 'db.example.test:65536']) assert.throws(() => destinationConfig({ ...restricted, CUSTOMER_DB_ALLOWED_DESTINATIONS: value }));
});
test('proxy trust accepts forwarded IP only through exact configured peer and ignores forged headers', async (t) => {
  for (const trusted of [true, false]) {
    const app = buildApp({ env: { ...env, trustedProxyIps: ['172.30.10.2'] }, logger: false, platformAuthRepository: memoryPlatformAuthRepository(), projectRepository: memoryRepository() });
    app.get('/ip-fixture', (req) => ({ ip: req.ip })); t.after(() => app.close());
    const result = await app.inject({ url: '/ip-fixture', remoteAddress: trusted ? '172.30.10.2' : '203.0.113.9', headers: { 'x-forwarded-for': '198.51.100.7' } });
    assert.equal(result.json().ip, trusted ? '198.51.100.7' : '203.0.113.9');
  }
});

test('every customer connection entry point enforces production policy before creating a socket', async () => {
  const { createConnectionTester } = await import('../src/database/customer-db/connection-test.js');
  const { createSchemaExecutor } = await import('../src/database/customer-db/schema-executor.js');
  const { createTransactionRunner } = await import('../src/database/customer-db/transaction-runner.js');
  const { createAuthStore } = await import('../src/database/customer-db/auth-store.js');
  const { CredentialEncryption } = await import('../src/security/encryption.js');
  const { generatePlan } = await import('../src/modules/schema-builder/plan.js');
  const { normalizeDraft } = await import('../src/modules/schema-builder/validation.js');
  const previous = { NODE_ENV: process.env.NODE_ENV, CUSTOMER_DB_ALLOWED_DESTINATIONS: process.env.CUSTOMER_DB_ALLOWED_DESTINATIONS, CUSTOMER_DB_POLICY: process.env.CUSTOMER_DB_POLICY };
  process.env.NODE_ENV = 'production'; process.env.CUSTOMER_DB_ALLOWED_DESTINATIONS = 'approved.example.test:5432'; process.env.CUSTOMER_DB_POLICY = 'restricted';
  let sockets = 0;
  const factory = () => { sockets++; throw new Error('Policy bypass'); };
  const config = { host: 'forbidden.example.test', port: 5432, database: 'test', username: 'test', password: 'secret', schema: 'public', ssl: true };
  const now = new Date(); const projectId = 'p'; const connectionId = 'c';
  const plan = generatePlan({ id: '11111111-1111-4111-8111-111111111111', projectId, connectionId, schemaName: 'public', ...normalizeDraft({ name: 'products', fields: [] }), draftRevision: 1, appliedRevision: null, appliedDefinition: null, createdAt: now, updatedAt: now });
  const encryption = new CredentialEncryption('11'.repeat(32));
  const context = { blocked: false, config: { id: 'auth', projectId, connectionId, enabled: true, signupEnabled: true, provisioningStatus: 'ready' as const, authSchemaVersion: 1,
    authUsersTableName: 'users', authSessionsTableName: 'sessions', sessionLifetimeSeconds: 86400, revision: 1, createdAt: now, updatedAt: now, catalog: {} },
    connection: { id: connectionId, projectId, label: 'Fixture', ...encryption.encrypt(config, `${projectId}:${connectionId}`), lastTestStatus: 'success' as const, lastTestedAt: now, createdAt: now, updatedAt: now } };
  try {
    await assert.rejects(createConnectionTester(factory)(config), { code: 'DESTINATION_NOT_ALLOWED' });
    await assert.rejects(createSchemaExecutor(factory)(config, plan, null), { code: 'DESTINATION_NOT_ALLOWED' });
    await assert.rejects(createTransactionRunner(factory)(config, async () => 1), { code: 'DESTINATION_NOT_ALLOWED' });
    await assert.rejects(createAuthStore(encryption, factory).provision(context), { code: 'DESTINATION_NOT_ALLOWED' });
    assert.equal(sockets, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
