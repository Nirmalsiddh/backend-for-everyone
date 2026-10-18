import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthForm, LogoutButton } from '../src/components/platform-auth';
import { authHandler } from '../src/lib/server/auth-handler';
import { cookieSettings } from '../src/lib/server/auth-config';
process.env.DASHBOARD_ORIGIN = 'http://localhost';
process.env.DASHBOARD_COOKIE_MODE = 'local-http';
process.env.BACKEND_ORIGIN = 'http://127.0.0.1:3000';
const token = 'ps_' + 'a'.repeat(43);
function request(action: string, origin: string | null = 'http://localhost', extra: Record<string, string> = {}) {
  return new Request(`http://localhost/api/auth/${action}`, { method: 'POST', headers: {
    ...(origin === null ? {} : { origin }), 'content-type': 'application/json', ...extra,
  }, body: action === 'logout' ? undefined : JSON.stringify({ email: 'a@example.test', password: 'password-123456789' }) });
}
test('auth forms expose credentials inputs with correct autocomplete and no unrelated flows', () => {
  for (const signup of [true, false]) {
    const html = renderToStaticMarkup(createElement(AuthForm, { signup }));
    assert.match(html, /type="email"/); assert.match(html, /type="password"/);
    assert.match(html, signup ? /new-password/ : /current-password/);
    assert.doesNotMatch(html, /localStorage|sessionToken|forgot password/i);
  }
  assert.match(renderToStaticMarkup(createElement(LogoutButton)), /Log out/);
});
test('login sets HttpOnly cookie and strips token; signup does not log in; logout confirms revocation', async (t) => {
  const original = fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ sessionToken: token, user: { id: 'user', email: 'a@example.test', passwordHash: 'never' } });
  const response = await authHandler(request('login'), 'login');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax; Path=\/; Max-Age=86400/);
  assert.deepEqual(await response.json(), { user: { id: 'user', email: 'a@example.test' } });
  const signup = await authHandler(request('signup'), 'signup');
  assert.equal(signup.status, 202); assert.equal(signup.headers.get('set-cookie'), null);
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    return new Response(null, { status: 204 });
  };
  const logout = await authHandler(request('logout', 'http://localhost', { cookie: `platform_session=${token}` }), 'logout');
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
  globalThis.fetch = async () => { throw new Error('secret'); };
  const unavailable = await authHandler(request('logout', 'http://localhost', { cookie: `platform_session=${token}` }), 'logout');
  assert.equal(unavailable.status, 503); assert.equal(unavailable.headers.get('set-cookie'), null);
});
test('all auth mutations reject hostile/missing/null Origin and cross-site signals before fetching', async (t) => {
  const original = fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new Error('must not fetch'); };
  for (const action of ['signup', 'login', 'logout']) {
    for (const origin of [null, 'null', 'http://evil.test', 'http://localhost.evil.test', 'http://localhost/path'])
      assert.equal((await authHandler(request(action, origin), action)).status, 403);
    assert.equal((await authHandler(request(action, 'http://localhost', { 'sec-fetch-site': 'cross-site' }), action)).status, 403);
  }
});
test('secure cookie mode cannot silently downgrade on a non-local or HTTP origin', () => {
  process.env.DASHBOARD_COOKIE_MODE = 'secure';
  assert.throws(cookieSettings);
  process.env.DASHBOARD_ORIGIN = 'https://dashboard.example';
  assert.deepEqual(cookieSettings(), { name: '__Host-platform_session', secure: true });
  process.env.DASHBOARD_COOKIE_MODE = 'local-http'; assert.throws(cookieSettings);
  process.env.DASHBOARD_ORIGIN = 'http://localhost';
});
