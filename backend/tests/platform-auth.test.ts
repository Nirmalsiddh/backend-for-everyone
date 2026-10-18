import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { PlatformAuthService, platformTokenHash } from '../src/modules/platform-auth/service.js';
import { PlatformRateLimiter } from '../src/modules/platform-auth/rate-limit.js';
import { createPasswordHasher } from '../src/security/passwords.js';
import { memoryPlatformAuthRepository } from './platform-auth-helpers.js';
import { env, memoryRepository } from './helpers.js';
const password = 'platform-password-123456';
const body = { email: 'alice@example.test', password };
test('platform HTTP signup/login/session/logout, strict DTOs and credential boundaries', async (t) => {
  const repository = memoryPlatformAuthRepository();
  const app = buildApp({ env, platformAuthRepository: repository, projectRepository: memoryRepository(), logger: false,
    runtimeRepository: { async authenticate() { throw new Error('must not interpret platform token as key'); }, async resolve() { return undefined; } } });
  t.after(() => app.close());
  const logs: unknown[] = [];
  app.addHook('onRequest', async (req) => { req.log.info = (...args: unknown[]) => { logs.push(args); }; });
  const signup = (payload: Record<string, string>) => app.inject({ method: 'POST', url: '/internal/auth/signup', payload });
  const first = await signup({ ...body, email: ' ALICE@EXAMPLE.TEST ' });
  assert.equal(first.statusCode, 202);
  assert.deepEqual((await signup(body)).json(), first.json());
  assert.equal(repository.users.size, 1);
  assert.equal((await signup({ ...body, ownerId: 'injected' })).statusCode, 400);
  const login = await app.inject({ method: 'POST', url: '/internal/auth/login', payload: body });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.headers['cache-control'], 'no-store');
  const { sessionToken, user } = login.json();
  assert.match(sessionToken, /^ps_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(user).sort(), ['email', 'id']);
  assert.ok(repository.sessions.has(platformTokenHash(sessionToken)));
  assert.ok(!JSON.stringify([...repository.sessions]).includes(sessionToken));
  const headers = { authorization: `Bearer ${sessionToken}` };
  assert.deepEqual((await app.inject({ url: '/internal/auth/me', headers })).json(), user);
  const created = await app.inject({ method: 'POST', url: '/internal/projects', headers, payload: { name: 'Alice project', slug: 'alice-project' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().ownerId, user.id);
  for (const token of ['ps_bad', 'us_' + 'a'.repeat(43), 'pk_' + 'a'.repeat(43), '']) {
    assert.equal((await app.inject({ url: '/internal/projects', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  }
  const runtime = await app.inject({ url: '/api/shop/products', headers });
  assert.equal(runtime.statusCode, 401, runtime.body);
  const logout = await app.inject({ method: 'POST', url: '/internal/auth/logout', headers });
  assert.equal(logout.statusCode, 204);
  assert.equal((await app.inject({ url: '/internal/auth/me', headers })).statusCode, 401);
  const logText = JSON.stringify(logs);
  for (const secret of [password, sessionToken, platformTokenHash(sessionToken), body.email, repository.users.get(body.email)!.passwordHash!]) assert.ok(!logText.includes(secret));
});
test('platform passwords, duplicate race, generic failures, expiry/status, cleanup and ownership', async () => {
  const repository = memoryPlatformAuthRepository();
  let now = Date.now();
  let dummy = 0;
  const real = createPasswordHasher();
  const passwords = { ...real, async dummyVerify(p: string) { dummy++; await real.dummyVerify(p); } };
  const service = new PlatformAuthService(repository, passwords, new PlatformRateLimiter(), () => now);
  await Promise.all([service.signup(body, 'one'), service.signup(body, 'two')]);
  assert.equal(repository.users.size, 1);
  const originalHash = repository.users.get(body.email)!.passwordHash;
  await service.signup({ ...body, password: 'another-password-12345' }, 'three');
  assert.equal(repository.users.get(body.email)!.passwordHash, originalHash);
  for (const password of ['a'.repeat(14), 'a'.repeat(129), '😀'.repeat(129)]) await assert.rejects(service.signup({ ...body, password }, 'limits'));
  // Unicode code points, not UTF-16 units; 128 emoji is exactly 512 bytes.
  await service.signup({ email: 'unicode@example.test', password: '😀'.repeat(128) }, 'unicode');
  const errors: string[] = [];
  for (const attempt of [{ ...body, password: 'incorrect-password' }, { ...body, email: 'missing@example.test' }]) {
    try { await service.login(attempt, 'fail'); } catch (e) { errors.push((e as Error).message); }
  }
  const user = repository.users.get(body.email)!;
  user.status = 'disabled';
  try { await service.login(body, 'disabled'); } catch (e) { errors.push((e as Error).message); }
  user.status = 'active'; user.passwordHash = null;
  try { await service.login(body, 'legacy'); } catch (e) { errors.push((e as Error).message); }
  assert.equal(new Set(errors).size, 1); assert.equal(errors.length, 4); assert.equal(dummy, 2);
  await service.signup(body, 'legacy-signup'); assert.equal(user.passwordHash, null);
  user.passwordHash = originalHash;
  const a = await service.login(body, 'alice');
  const auth = `Bearer ${a.sessionToken}`;
  const session = repository.sessions.get(platformTokenHash(a.sessionToken))!;
  assert.equal(session.expiresAt.getTime() - now, 86400000);
  user.status = 'disabled'; await assert.rejects(service.authenticate(auth));
  user.status = 'active'; now += 86400000; await assert.rejects(service.authenticate(auth));
  now -= 86400000;
  const second = await service.login(body, 'alice-second');
  assert.notEqual(second.sessionToken, a.sessionToken);
  await service.logout(session.id); await assert.rejects(service.authenticate(auth));
  assert.equal((await service.authenticate(`Bearer ${second.sessionToken}`)).principal.userId, user.id);
  now += 9 * 86400000; await service.cleanup(); assert.equal(repository.sessions.size, 0);
});
test('platform rate limits combine email/IP, expire, count successes, and bound state', () => {
  let now = 0; const limiter = new PlatformRateLimiter(100, () => now);
  for (let i = 0; i < 5; i++) limiter.check('login', 'ip', 'email');
  assert.throws(() => limiter.check('login', 'ip', 'email'), { statusCode: 429, retryAfter: 900 });
  limiter.check('login', 'different-ip', 'email');
  now += 900001; limiter.check('login', 'ip', 'email');
  const bounded = new PlatformRateLimiter(2);
  bounded.check('signup', 'ip', 'email'); assert.throws(() => bounded.check('signup', 'ip2', 'email2'), { statusCode: 429 });
  assert.equal(bounded.size, 2);
  const ips = new PlatformRateLimiter();
  for (let i = 0; i < 20; i++) ips.check('login', 'same', String(i));
  assert.throws(() => ips.check('login', 'same', 'next'), { statusCode: 429 });
});
