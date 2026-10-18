import { memoryPlatformAuthRepository } from './platform-auth-helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import {
  auth,
  env,
  memoryRepository,
  otherOwnerId,
  ownerId,
} from './helpers.js';

test('create and retrieve a project with server-assigned ownership', async (t) => {
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository("11111111-1111-4111-8111-111111111111"),
    env,
    projectRepository: memoryRepository(),
    logger: false,
  });
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/internal/projects',
    headers: auth,
    payload: { name: '  Shop  ', slug: 'shop-api' },
  });
  assert.equal(created.statusCode, 201);
  const project = created.json();
  assert.equal(project.name, 'Shop');
  assert.equal(project.ownerId, ownerId);
  assert.equal(created.headers.location, `/internal/projects/${project.id}`);
  assert.ok(!Number.isNaN(Date.parse(project.createdAt)));
  const fetched = await app.inject({
    url: created.headers.location as string,
    headers: auth,
  });
  assert.equal(fetched.statusCode, 200);
  assert.deepEqual(fetched.json(), project);
});

test('management endpoints require authentication before body validation', async (t) => {
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository("11111111-1111-4111-8111-111111111111"),
    env,
    projectRepository: memoryRepository(),
    logger: false,
  });
  t.after(() => app.close());
  for (const authorization of ['', 'Bearer wrong', 'Basic abc']) {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/projects',
      headers: { authorization },
      payload: {},
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['www-authenticate'], 'Bearer');
  }
});

test('reject invalid bodies, unknown fields, malformed JSON, and oversized input', async (t) => {
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository("11111111-1111-4111-8111-111111111111"),
    env,
    projectRepository: memoryRepository(),
    logger: false,
  });
  t.after(() => app.close());
  for (const payload of [
    {},
    { name: ' ', slug: 'shop' },
    { name: 'Shop', slug: 'UPPER' },
    { name: 'Shop', slug: 'ab' },
    { name: 123, slug: 'shop' },
    { name: 'Shop', slug: 'shop', ownerId: otherOwnerId },
    { name: 'Shop', slug: 'shop; DROP TABLE users' },
    { name: 'x'.repeat(101), slug: 'shop' },
    { name: 'Shop', slug: 'a'.repeat(64) },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/projects',
      headers: auth,
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  const malformed = await app.inject({
    method: 'POST',
    url: '/internal/projects',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: '{broken',
  });
  assert.equal(malformed.statusCode, 400);
  const oversized = await app.inject({
    method: 'POST',
    url: '/internal/projects',
    headers: auth,
    payload: { name: 'x'.repeat(70_000), slug: 'shop' },
  });
  assert.equal(oversized.statusCode, 413);
});

test('duplicate slug is 409; foreign-owned and absent projects both return 404', async (t) => {
  const repository = memoryRepository();
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository("11111111-1111-4111-8111-111111111111"), env, projectRepository: repository, logger: false });
  t.after(() => app.close());
  const payload = { name: 'Shop', slug: 'shop-api' };
  await repository.create(ownerId, payload);
  const duplicate = await app.inject({
    method: 'POST',
    url: '/internal/projects',
    headers: auth,
    payload,
  });
  assert.equal(duplicate.statusCode, 409);
  const foreign = await repository.create(otherOwnerId, {
    name: 'Other',
    slug: 'other-shop',
  });
  for (const id of [foreign.id, otherOwnerId]) {
    const response = await app.inject({
      url: `/internal/projects/${id}`,
      headers: auth,
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, 'PROJECT_NOT_FOUND');
  }
  assert.equal(
    (await app.inject({ url: '/internal/projects/not-a-uuid', headers: auth }))
      .statusCode,
    400,
  );
});

test('unexpected errors never expose database details', async (t) => {
  const repository = memoryRepository();
  repository.create = async () => {
    throw new Error('postgres://admin:secret@host/db SQL VALUES private');
  };
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository("11111111-1111-4111-8111-111111111111"), env, projectRepository: repository, logger: false });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/internal/projects',
    headers: auth,
    payload: { name: 'Shop', slug: 'shop' },
  });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  });
});

test('project listing is authenticated, bounded, owner scoped, and paginated', async (t) => {
  const repository = memoryRepository();
  await repository.create(ownerId, { name: 'First', slug: 'first' });
  await repository.create(ownerId, { name: 'Second', slug: 'second' });
  await repository.create(otherOwnerId, { name: 'Foreign', slug: 'foreign' });
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository("11111111-1111-4111-8111-111111111111"), env, projectRepository: repository, logger: false });
  t.after(() => app.close());
  assert.equal((await app.inject('/internal/projects')).statusCode, 401);
  const first = await app.inject({
    url: '/internal/projects?limit=1',
    headers: auth,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items.length, 1);
  assert.equal(first.json().nextOffset, 1);
  const second = await app.inject({
    url: '/internal/projects?limit=1&offset=1',
    headers: auth,
  });
  assert.equal(second.json().nextOffset, null);
  assert.notEqual(first.json().items[0].id, second.json().items[0].id);
  assert.equal(second.json().items[0].ownerId, ownerId);
  for (const query of [
    'limit=0',
    'limit=101',
    'offset=-1',
    'offset=1000000',
    'limit=1.5',
    'extra=yes',
  ]) {
    assert.equal(
      (await app.inject({ url: `/internal/projects?${query}`, headers: auth }))
        .statusCode,
      400,
    );
  }
  for (const url of [
    '/internal/projects',
    '/api/missing/resource',
    '/internal/projects/invalid',
  ]) {
    const response = await app.inject({ url, headers: auth });
    assert.equal(typeof response.headers['x-request-id'], 'string');
  }
});
