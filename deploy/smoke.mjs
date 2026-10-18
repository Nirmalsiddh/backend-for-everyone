// Node 24. Secrets arrive through a mode-0600 JSON file, never argv values.
import { readFile } from 'node:fs/promises';
let config;
try { config = JSON.parse(await readFile(process.env.SMOKE_CONFIG, 'utf8')); }
catch { console.error('Invalid protected deployment test configuration'); process.exit(1); }
const app = new URL(config.appOrigin).origin;
const api = new URL(config.apiOrigin).origin;
if (!app.startsWith('https:') || !api.startsWith('https:')) throw new Error('HTTPS origins required');
function expect(value, message) { if (!value) throw new Error(message); }
async function call(origin, path, options = {}) {
  return fetch(origin + path, { ...options, redirect: 'manual', signal: AbortSignal.timeout(25000) });
}
async function main() {
  expect((await call(app, '/login')).status === 200, 'Dashboard HTTPS failed');
  for (const path of ['/internal', '/internal/projects', '/health/ready', '/']) expect((await call(api, path)).status === 404, 'Unexpected public backend route');
  const credentials = JSON.stringify({ email: config.email, password: config.password });
  const headers = { origin: app, 'content-type': 'application/json' };
  expect((await call(app, '/api/auth/signup', { method: 'POST', headers, body: credentials })).status === 202, 'Signup failed');
  const login = await call(app, '/api/auth/login', { method: 'POST', headers, body: credentials });
  expect(login.status === 200, 'Login failed');
  const cookie = login.headers.get('set-cookie') ?? '';
  expect(cookie.startsWith('__Host-platform_session=') && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Lax/i.test(cookie) && !/Domain=/i.test(cookie), 'Unsafe session cookie');
  const loginBody = await login.text();
  expect(!/ps_[A-Za-z0-9_-]{43}/.test(loginBody), 'Session exposed in JSON');
  const session = cookie.split(';')[0];
  expect((await call(app, '/api/management/projects', { headers: { cookie: session } })).status === 200, 'Authenticated listing failed');
  expect((await call(app, '/api/auth/login', { method: 'POST', headers: { ...headers, origin: 'https://hostile.invalid' }, body: credentials })).status === 403, 'Hostile Origin accepted');
  expect(typeof config.runtimePath === 'string' && /^\/api\/[a-z0-9-]+\//.test(config.runtimePath) && config.runtimeKey, 'Disposable runtime path/key required');
  const runtime = await call(api, config.runtimePath, { headers: { authorization: `Bearer ${config.runtimeKey}`, origin: config.corsOrigin } });
  expect(runtime.status === 200, 'Disposable runtime request failed');
  expect(runtime.headers.get('access-control-allow-origin') === config.corsOrigin, 'Configured CORS origin missing');
  expect((await call(app, '/api/auth/logout', { method: 'POST', headers: { origin: app, cookie: session } })).status === 200, 'Logout failed');
  console.log('HTTPS, private routing, signup/login, cookies, listing, Origin, runtime and CORS checks passed');
}
main().catch(() => { console.error('Deployment smoke check failed; inspect sanitized service logs and configuration.'); process.exitCode = 1; });
