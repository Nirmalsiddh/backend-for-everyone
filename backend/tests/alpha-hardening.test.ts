import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CustomerAdmission } from '../src/database/customer-db/admission.js';
import { RuntimeLimiter } from '../src/operations/runtime-admission.js';
import { classifyCatalog } from '../src/operations/reconciliation.js';
import { CredentialEncryption } from '../src/security/encryption.js';
import { writeReceipt, readReceipt } from '../src/operations/receipts.js';
import { buildApp } from '../src/app.js';
import { env, memoryRepository } from './helpers.js';
import {
  fixtureToken,
  memoryPlatformAuthRepository,
} from './platform-auth-helpers.js';
test('coordinated customer admission bounds total/category counts, wait, release and saturation', async () => {
  const admission = new CustomerAdmission(2);
  const a = await admission.acquire('runtime'),
    b = await admission.acquire('auth');
  await assert.rejects(admission.acquire('diagnostic', 15), {
    code: 'CUSTOMER_CAPACITY_EXHAUSTED',
  });
  a();
  a();
  const c = await admission.acquire('schema');
  assert.equal(admission.snapshot().total, 2);
  b();
  c();
  assert.equal(admission.snapshot().total, 0);
});
test('runtime rate limiter is bounded, project scoped and refills', () => {
  let now = 0;
  const limiter = new RuntimeLimiter(() => now, 5, 2);
  limiter.check('a');
  limiter.check('a');
  assert.throws(() => limiter.check('a'), { statusCode: 429 });
  limiter.check('b');
  now += 201;
  limiter.check('a');
});
test('reconciliation never adopts an unreceipted lookalike or a diverged catalog', () => {
  assert.equal(classifyCatalog(null, null, undefined), 'PRE_STATE');
  assert.equal(
    classifyCatalog({ columns: 1 }, { columns: 1 }, undefined),
    'PRE_STATE',
  );
  assert.equal(classifyCatalog(null, { columns: 1 }, undefined), 'DIVERGED');
  assert.equal(
    classifyCatalog(null, { columns: 1 }, { columns: 1 }),
    'POST_STATE',
  );
  assert.equal(
    classifyCatalog(null, { columns: 2 }, { columns: 1 }),
    'DIVERGED',
  );
});
test('recovery receipts are authenticated, operation bound, and contain no plaintext catalog', async () => {
  const encryption = new CredentialEncryption('11'.repeat(32));
  let comment = '';
  const client = {
    connect: async () => {},
    end: async () => {},
    on: () => {},
    query: async (sql: string) => {
      if (sql.startsWith('COMMENT')) {
        comment = sql.split(" IS '")[1]!.slice(0, -1);
        return { rows: [] };
      }
      return { rows: [{ receipt: comment }] };
    },
  };
  const catalog = { value: 'SENSITIVE_DEFAULT_FIXTURE' };
  await writeReceipt(
    client,
    encryption,
    'public',
    'tasks',
    'operation-a',
    catalog,
  );
  assert.doesNotMatch(comment, /SENSITIVE_DEFAULT_FIXTURE/);
  assert.deepEqual(
    await readReceipt(client, encryption, 'public', 'tasks', 'operation-a'),
    catalog,
  );
  assert.equal(
    await readReceipt(client, encryption, 'public', 'tasks', 'operation-b'),
    undefined,
  );
});
test('request IDs are UUIDs; trusted UUID propagation only, runtime suspension/rate/CORS', async (t) => {
  const id = 'ad895e6f-a266-4d70-b7d7-00103a8303dd';
  const app = buildApp({
    env: {
      ...env,
      trustedProxyIps: ['127.0.0.1'],
      runtimeAllowedOrigins: ['https://app.example.test'],
    },
    platformAuthRepository: memoryPlatformAuthRepository(
      '11111111-1111-4111-8111-111111111111',
    ),
    projectRepository: memoryRepository(),
    logger: false,
  });
  t.after(() => app.close());
  const response = await app.inject({
    url: '/health/live',
    headers: { 'x-request-id': id },
  });
  assert.equal(response.headers['x-request-id'], id);
  const untrusted = await app.inject({
    url: '/health/live',
    remoteAddress: '203.0.113.1',
    headers: { 'x-request-id': id },
  });
  assert.notEqual(untrusted.headers['x-request-id'], id);
  assert.match(String(untrusted.headers['x-request-id']), /^[a-f0-9-]{36}$/);
  const invalid = await app.inject({
    url: '/internal/projects',
    headers: { 'x-request-id': 'secret-fixture' },
  });
  assert.notEqual(invalid.headers['x-request-id'], 'secret-fixture');
});

test('management events never log malformed URL identifiers, request payloads or credentials', async (t) => {
  const owner = '11111111-1111-4111-8111-111111111111';
  const secret = 'pk_FIXTURE_SECRET_MUST_NOT_BE_LOGGED';
  const app = buildApp({
    env,
    logger: false,
    projectRepository: memoryRepository(),
    platformAuthRepository: memoryPlatformAuthRepository(owner),
    apiKeyRepository: {
      async create() {
        throw Error('Validation must run first');
      },
      async list() {
        return [];
      },
      async revoke() {
        throw Error('Validation must run first');
      },
    },
  });
  t.after(() => app.close());
  const logs: unknown[] = [];
  app.addHook('onRequest', async (req) => {
    req.log.info = (...args: unknown[]) => {
      logs.push(args);
    };
  });
  for (const url of [
    `/internal/projects/${secret}/api-keys/${owner}`,
    `/internal/projects/${owner}/api-keys/${secret}`,
  ]) {
    const response = await app.inject({
      method: 'DELETE',
      url,
      headers: { authorization: 'Bearer ' + fixtureToken },
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/internal/projects/${owner}/api-keys`,
        headers: { authorization: 'Bearer ' + fixtureToken },
        payload: { name: secret, scope: 'read', password: secret },
      })
    ).statusCode,
    400,
  );
  const text = JSON.stringify(logs);
  assert.match(text, /Management event/);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(fixtureToken));
});
