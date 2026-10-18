import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adapter,
  supported,
  tableDto,
  managementDto,
} from '../src/lib/server/adapter';
process.env.DASHBOARD_ORIGIN = 'http://localhost';
process.env.DASHBOARD_COOKIE_MODE = 'local-http';
const platformToken = 'ps_' + 'a'.repeat(43);
const id = '11111111-1111-4111-8111-111111111111';
test('adapter rejects arbitrary targets, unlisted methods, traversal, and cross-origin mutations', async () => {
  for (const path of [
    'https://evil.test',
    'projects/../secrets',
    `projects/${id}/unknown`,
  ])
    assert.equal(supported(path, 'GET'), false);
  assert.equal(supported('projects', 'DELETE'), false);
  assert.equal(supported('shop/products', 'POST', true), true);
  assert.equal(supported('shop/../internal/projects', 'GET', true), false);
  assert.equal(supported('shop/auth/login', 'PATCH', true), false);
  assert.equal(supported('shop/products', 'DELETE', true), false);
  const response = await adapter(
    new Request('http://localhost/api/management/projects', {
      method: 'POST',
      headers: { origin: 'https://evil.test' },
    }),
    ['projects'],
  );
  assert.equal(response.status, 403);
});
test('explicit management DTOs exclude internal records and preserve only intentional one-time secrets', () => {
  assert.deepEqual(
    managementDto(`projects/${id}/schema/tables`, 'POST', {
      id,
      fields: [],
      appliedDefinition: null,
    }),
    { id, fields: [], appliedDefinition: null },
  );
  const row = tableDto({
    id,
    fields: [],
    appliedDefinition: {
      catalog: { sql: 'private' },
      definition: { name: 'products', fields: [] },
    },
    encryptedConfig: 'secret',
  }) as object;
  assert.ok(!JSON.stringify(row).includes('private'));
  assert.ok(!JSON.stringify(row).includes('secret'));
  assert.deepEqual(
    managementDto(`projects/${id}/api-keys`, 'POST', {
      id,
      key: 'pk_once',
      keyHash: 'never',
    }),
    { id, key: 'pk_once' },
  );
  assert.deepEqual(
    managementDto(`projects/${id}/api-keys`, 'GET', [
      { id, key: 'pk_once', keyHash: 'never' },
    ]),
    [{ id }],
  );
});
test('only management calls receive the platform session; runtime forwards explicit runtime credential and request ID', async (t) => {
  const original = globalThis.fetch;
  const oldOrigin = process.env.BACKEND_ORIGIN;
  t.after(() => {
    globalThis.fetch = original;
    if (oldOrigin === undefined) delete process.env.BACKEND_ORIGIN;
    else process.env.BACKEND_ORIGIN = oldOrigin;
  });
  process.env.BACKEND_ORIGIN = 'http://127.0.0.1:3000';
  let sent = '';
  globalThis.fetch = async (_url, init) => {
    sent = new Headers(init?.headers).get('authorization') ?? '';
    return Response.json(
      { items: [], nextOffset: null },
      { headers: { 'x-request-id': 'backend-id' } },
    );
  };
  const response = await adapter(
    new Request('http://localhost/api/management/projects', { headers: { cookie: `platform_session=${platformToken}` } }),
    ['projects'],
  );
  assert.equal(sent, `Bearer ${platformToken}`);
  assert.equal(response.headers.get('x-request-id'), 'backend-id');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await adapter(
    new Request('http://localhost/api/runtime/shop/products', {
      headers: { authorization: 'Bearer pk_runtime', cookie: `platform_session=${platformToken}` },
    }),
    ['shop', 'products'],
    true,
  );
  assert.equal(sent, 'Bearer pk_runtime');
  await adapter(
    new Request('http://localhost/api/runtime/shop/products', { headers: { cookie: `platform_session=${platformToken}` } }),
    ['shop', 'products'],
    true,
  );
  assert.equal(sent, '');
});

test('normalized Next URL still accepts matching incoming Origin/Host and preserves sanitized backend errors', async (t) => {
  const original = globalThis.fetch;
  const oldOrigin = process.env.BACKEND_ORIGIN;
  t.after(() => {
    globalThis.fetch = original;
    if (oldOrigin === undefined) delete process.env.BACKEND_ORIGIN;
    else process.env.BACKEND_ORIGIN = oldOrigin;
  });
  process.env.BACKEND_ORIGIN = 'http://127.0.0.1:3000';
  globalThis.fetch = async () =>
    Response.json(
      {
        code: 'INVALID_REQUEST',
        message: 'Request validation failed',
        stack: 'never',
        sql: 'never',
      },
      { status: 400, headers: { 'x-request-id': 'validation-id' } },
    );
  const response = await adapter(
    new Request('http://localhost:3001/api/management/projects', {
      method: 'POST',
      headers: {
        host: 'localhost',
        cookie: `platform_session=${platformToken}`,
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: '{malformed',
    }),
    ['projects'],
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('x-request-id'), 'validation-id');
  assert.deepEqual(await response.json(), {
    code: 'INVALID_REQUEST',
    message: 'Request validation failed',
  });
});

test('runtime responses preserve business JSON, sanitized errors and empty bodies', async (t) => {
  const original = globalThis.fetch;
  const old = process.env.BACKEND_ORIGIN;
  t.after(() => {
    globalThis.fetch = original;
    if (old === undefined) delete process.env.BACKEND_ORIGIN;
    else process.env.BACKEND_ORIGIN = old;
  });
  process.env.BACKEND_ORIGIN = 'http://127.0.0.1:3000';
  for (const value of [
    { reason: 'Insufficient stock' },
    ['rejected'],
    'rejected',
    42,
    false,
    null,
    {
      code: 'INVALID_REQUEST',
      message: 'Request could not be accepted',
      requestId: 'safe-id',
    },
  ]) {
    globalThis.fetch = async () =>
      Response.json(value, {
        status: 422,
        headers: { 'x-request-id': 'safe-id' },
      });
    const response = await adapter(
      new Request('http://localhost/api/runtime/shop/checkout', {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      ['shop', 'checkout'],
      true,
    );
    assert.equal(response.status, 422);
    assert.equal(response.headers.get('x-request-id'), 'safe-id');
    assert.deepEqual(await response.json(), value);
  }
  globalThis.fetch = async () =>
    new Response(null, {
      status: 204,
      headers: { 'x-request-id': 'empty-id' },
    });
  const empty = await adapter(
    new Request('http://localhost/api/runtime/shop/products', { headers: { cookie: `platform_session=${platformToken}` } }),
    ['shop', 'products'],
    true,
  );
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
  assert.equal(empty.headers.get('x-request-id'), 'empty-id');
});

test('adapter distinguishes invalid configuration, transport and contract failures', async (t) => {
  const oldFetch = globalThis.fetch;
  const oldOrigin = process.env.BACKEND_ORIGIN;
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (oldOrigin === undefined) delete process.env.BACKEND_ORIGIN;
    else process.env.BACKEND_ORIGIN = oldOrigin;
  });
  process.env.BACKEND_ORIGIN = 'https://user:secret@bad.test';
  const req = () => new Request('http://localhost/api/management/projects', { headers: { cookie: `platform_session=${platformToken}` } });
  assert.equal(
    (await (await adapter(req(), ['projects'])).json()).code,
    'DASHBOARD_CONFIGURATION_INVALID',
  );
  process.env.BACKEND_ORIGIN = 'http://127.0.0.1:3000';
  globalThis.fetch = async () => {
    throw new Error('private details');
  };
  assert.equal(
    (await (await adapter(req(), ['projects'])).json()).code,
    'BACKEND_UNAVAILABLE',
  );
  globalThis.fetch = async () =>
    new Response('<html>private error</html>', { status: 500 });
  const mismatch = await adapter(req(), ['projects']);
  assert.equal((await mismatch.json()).code, 'BACKEND_CONTRACT_MISMATCH');
});
