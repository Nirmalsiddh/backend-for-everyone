import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPasswordHasher, validatePassword } from '../src/modules/project-auth/passwords.js';
import { AuthRateLimiter } from '../src/modules/project-auth/rate-limit.js';
import { credentials, sessionToken, tokenHash } from '../src/modules/project-auth/service.js';
import { validatePolicies } from '../src/runtime/authorization.js';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import { selectById, selectList, updateRow, deleteRow } from '../src/runtime/queries.js';
import { validateList } from '../src/runtime/validation.js';
test('Argon2id uses fresh salts, explicit parameters, password-preserving verification, and bounded work', async () => {
  const hasher = createPasswordHasher(1); const password = '  Mixed Case passphrase  ';
  const first = await hasher.hash(password); const second = await hasher.hash(password);
  assert.notEqual(first, second); assert.ok(/^\$argon2id\$v=19\$m=19456,(?:t=2,p=1|p=1,t=2)\$/.test(first));
  assert.equal(await hasher.verify(first, password), true);
  assert.equal(await hasher.verify(first, password.trim()), false);
  assert.equal(await hasher.verify(first, password.toLowerCase()), false);
  assert.equal(await hasher.verify(first, 'wrong'), false);
  assert.equal(await hasher.verify('$argon2id$v=19$m=999999999,t=2,p=1$bad$bad', password), false);
  await hasher.dummyVerify('unknown-user-password');
  const pending = hasher.hash(password);
  await assert.rejects(hasher.hash(password), { code: 'AUTH_CAPACITY_EXHAUSTED' }); await pending;
  for (const invalid of ['short', 'x'.repeat(129), 12, null]) assert.throws(() => validatePassword(invalid));
});
test('credentials normalize email only and reject privilege injection or unsupported fields', () => {
  const password = '  Case sensitive password  ';
  assert.deepEqual(credentials({ email: ' Alice@Example.Test ', password }), { email: 'alice@example.test', password });
  for (const body of [null, [], { email: 'a@example.test', password, role: 'admin' }, { email: 'a@example.test', password, status: 'active' }, { email: 'bad', password }]) assert.throws(() => credentials(body), { statusCode: 400 });
  assert.equal(sessionToken(`Bearer us_${'a'.repeat(43)}`), `us_${'a'.repeat(43)}`);
  assert.throws(() => sessionToken(`Bearer pk_${'a'.repeat(43)}`), { statusCode: 401 });
  assert.match(tokenHash('secret'), /^[a-f0-9]{64}$/);
});
test('attempt limits combine project/IP and identifier, expire, isolate projects, and remain bounded', () => {
  let now = 0; const limiter = new AuthRateLimiter(1000, 3, 2, 100, () => now);
  limiter.check('project', 'login', 'ip1', 'email'); limiter.check('project', 'login', 'ip2', 'email');
  assert.throws(() => limiter.check('project', 'login', 'ip3', 'email'), { statusCode: 429, retryAfter: 1 });
  limiter.check('other-project', 'login', 'ip1', 'email'); now = 1001;
  assert.doesNotThrow(() => limiter.check('project', 'login', 'ip1', 'email'));
  const small = new AuthRateLimiter(1000, 10, 10, 2, () => now); small.check('p', 'signup', 'ip1', 'one');
  assert.throws(() => small.check('p', 'signup', 'ip2', 'two'), { statusCode: 429 });
});
test('policies reference applied UUID field IDs; all owner predicates stay inside SQL', () => {
  const draft = normalizeDraft({ name: 'orders', fields: [{ name: 'owner_id', type: 'uuid' }, { name: 'title', type: 'text' }] });
  const definition = { schema: 'public', ...draft }; const userId = randomUUID(); const id = randomUUID();
  const ownership = { field: 'owner_id', userId };
  assert.doesNotThrow(() => validatePolicies({ get: { mode: 'owner', ownerFieldId: draft.fields[0]!.id, allowAdmin: false } }, definition));
  for (const ownerFieldId of [randomUUID(), 'id', draft.fields[1]!.id]) assert.throws(() => validatePolicies({ get: { mode: 'owner', ownerFieldId, allowAdmin: false } }, definition));
  const list = selectList(definition, validateList(definition, { 'filter[title]': 'x', limit: '1' }), ownership);
  assert.match(list.text, /WHERE "title" = \$1::pg_catalog.text AND "owner_id" = \$2::pg_catalog.uuid/);
  assert.equal(list.values[1], userId);
  for (const query of [selectById(definition, id, ownership), updateRow(definition, id, { title: 'new' }, ownership), deleteRow(definition, id, ownership)]) {
    assert.match(query.text, /WHERE "id" = \$\d+::pg_catalog.uuid AND "owner_id" = \$\d+::pg_catalog.uuid/);
    assert.ok(query.values.includes(userId)); assert.ok(query.values.includes(id)); assert.ok(!query.text.includes(userId));
  }
});

test('ambiguous provisioning and failed platform finalization never claim successful provisioning', async () => {
  const { AuthService } = await import('../src/modules/project-auth/service.js');
  const { RuntimeError } = await import('../src/runtime/errors.js');
  const { CredentialEncryption } = await import('../src/security/encryption.js');
  const { env } = await import('./helpers.js');
  const projectId = randomUUID(); const connectionId = randomUUID(); const now = new Date();
  const context: import('../src/modules/project-auth/types.js').AuthContext = { blocked: false, config: {
    id: randomUUID(), projectId, connectionId, enabled: true, signupEnabled: true, provisioningStatus: 'provisioning', authSchemaVersion: 1,
    authUsersTableName: 'reserved', authSessionsTableName: 'reserved', sessionLifetimeSeconds: 86400, revision: 2, createdAt: now, updatedAt: now, catalog: null,
  }, connection: { id: connectionId, projectId, label: 'Fixture', ...new CredentialEncryption(env.connectionEncryptionKey).encrypt({}, `${projectId}:${connectionId}`),
    lastTestStatus: 'success', lastTestedAt: now, createdAt: now, updatedAt: now } };
  const states: string[] = [];
  const repository: import('../src/modules/project-auth/types.js').AuthRepository = {
    async configure() { return context.config; }, async getOwned() { return context; }, async bySlug() { return context; }, async begin() { return context; },
    async finish(_project, _owner, _revision, status) { states.push(status); },
  };
  const store: import('../src/modules/project-auth/types.js').AuthStore = {
    async provision() { throw new RuntimeError(503, 'AUTH_OUTCOME_UNKNOWN', 'Commit uncertain'); },
    async signup() { throw new Error(); }, async findUser() { return undefined; }, async login() {}, async session() { throw new Error(); }, async logout() {}, async setRole() { throw new Error(); },
  };
  const service = new AuthService(repository, store, createPasswordHasher());
  await assert.rejects(service.provision(projectId, 'owner', 1), { code: 'AUTH_OUTCOME_UNKNOWN' }); assert.deepEqual(states, ['outcome_unknown']);
  store.provision = async () => ({}); repository.finish = async () => { throw new Error('platform unavailable'); };
  await assert.rejects(service.provision(projectId, 'owner', 1), { code: 'AUTH_OUTCOME_UNKNOWN' });
});
