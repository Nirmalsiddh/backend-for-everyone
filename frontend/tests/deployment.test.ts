import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicRuntimeOrigin } from '../src/lib/server/runtime-origin';
import { cookieSettings, allowedRequest, sessionCookie } from '../src/lib/server/auth-config';
test('public runtime origin is independent from private backend and requires production HTTPS', () => {
  const config: NodeJS.ProcessEnv = { NODE_ENV: 'production', BACKEND_ORIGIN: 'http://backend:3000', PUBLIC_RUNTIME_ORIGIN: 'https://api.example.com', DASHBOARD_COOKIE_MODE: 'secure' };
  assert.equal(publicRuntimeOrigin(config), 'https://api.example.com');
  for (const origin of ['', 'http://api.example.com', 'https://api.example.com/path', 'https://user:pass@api.example.com']) assert.throws(() => publicRuntimeOrigin({ ...config, PUBLIC_RUNTIME_ORIGIN: origin }));
});
test('production cookie/origin behind private HTTP proxy never downgrades from forwarded headers', () => {
  process.env.DASHBOARD_ORIGIN = 'https://app.example.com'; process.env.DASHBOARD_COOKIE_MODE = 'secure';
  assert.deepEqual(cookieSettings(), { name: '__Host-platform_session', secure: true });
  const cookie = sessionCookie('ps_fixture'); assert.match(cookie, /HttpOnly; Secure; SameSite=Lax; Path=\//); assert.doesNotMatch(cookie, /Domain=/);
  const request = new Request('http://frontend:3001/api/auth/login', { method: 'POST', headers: { host: 'app.example.com', origin: 'https://app.example.com', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.test' } });
  assert.equal(allowedRequest(request), true);
  assert.equal(allowedRequest(new Request('http://frontend:3001/api/auth/login', { method: 'POST', headers: { host: 'app.example.com', origin: 'https://evil.test' } })), false);
});
