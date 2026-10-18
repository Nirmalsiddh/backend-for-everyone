import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadEnv } from '../src/config/env.js';

const valid = {
  PLATFORM_DATABASE_URL: 'postgresql://test:secret@localhost/platform',
  CONNECTION_ENCRYPTION_KEY: '11'.repeat(32),
};

test('environment defaults and explicit configuration', () => {
  const env = loadEnv(valid);
  assert.equal(env.host, '127.0.0.1');
  assert.equal(env.port, 3000);
  assert.equal(loadEnv({ ...valid, PORT: '4000', NODE_ENV: 'production', PUBLIC_RUNTIME_ORIGIN: 'https://api.example.test' }).port, 4000);
});

test('reject invalid environment without echoing secrets', () => {
  for (const patch of [
    { PLATFORM_DATABASE_URL: 'https://secret.example/db' },
    { PLATFORM_DATABASE_URL: 'postgresql://localhost/' },
    { TRUSTED_DASHBOARD_PROXY: '0.0.0.0/0' }, { TRUSTED_PROXY_IPS: '0.0.0.0/0' }, { TRUSTED_PROXY_IPS: '8.8.8.8' }, { TRUSTED_PROXY_IPS: '0.0.0.0' },
    { PORT: '0' }, { PORT: '65536' }, { PORT: '1.5' }, { PORT: '' },
    { CONNECTION_ENCRYPTION_KEY: '' }, { CONNECTION_ENCRYPTION_KEY: 'zz'.repeat(32) },
    { NODE_ENV: 'invalid' }, { HOST: ' ' },
  ]) assert.throws(() => loadEnv({ ...valid, ...patch }));
  assert.throws(() => loadEnv({ ...valid, PLATFORM_DATABASE_URL: 'secret-value' }),
    { message: 'PLATFORM_DATABASE_URL must be a PostgreSQL connection URL' });
});

test('runtime origin configuration is explicit and rejects wildcard or non-origin URLs', () => {
  assert.deepEqual(loadEnv(valid).runtimeAllowedOrigins, []);
  assert.deepEqual(loadEnv({ ...valid, RUNTIME_ALLOWED_ORIGINS: 'https://app.example,http://localhost:5173,https://app.example' }).runtimeAllowedOrigins, ['https://app.example', 'http://localhost:5173']);
  for (const origin of ['*', 'null', 'https://app.example/path', 'https://user:secret@app.example', 'file:///tmp/app']) {
    assert.throws(() => loadEnv({ ...valid, RUNTIME_ALLOWED_ORIGINS: origin }));
  }
});

test('OpenAPI public runtime origin is explicit, sanitized and HTTPS-only in production', () => {
  assert.equal(loadEnv({ ...valid, PUBLIC_RUNTIME_ORIGIN: 'https://api.example.test' }).publicRuntimeOrigin, 'https://api.example.test');
  for (const origin of ['', 'https://api.example.test/path', 'https://api.example.test/', 'https://user:secret@api.example.test', 'http://api.example.test', 'null']) {
    assert.throws(() => loadEnv({ ...valid, NODE_ENV: 'production', PUBLIC_RUNTIME_ORIGIN: origin }), /PUBLIC_RUNTIME_ORIGIN/);
  }
});
