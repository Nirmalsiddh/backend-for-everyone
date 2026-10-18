import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../../src/app.js';
import { parseDatabaseUrl } from '../../src/config/env.js';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { projects, users } from '../../src/database/platform-db/schema.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { auth, env } from '../helpers.js';

test('PostgreSQL migrations, persistence, ownership, constraints, and conflict mapping', async (t) => {
  const url = parseDatabaseUrl(
    process.env.TEST_DATABASE_URL,
    'TEST_DATABASE_URL',
  );
  if (url === process.env.PLATFORM_DATABASE_URL)
    throw new Error('Use a separate disposable test database');
  const { db, pool } = createPlatformDatabase(url);
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  let seeded = false;
  t.after(async () => {
    try {
      if (seeded) {
        await db
          .delete(projects)
          .where(inArray(projects.ownerId, [ownerId, otherOwnerId]));
        await db
          .delete(users)
          .where(inArray(users.id, [ownerId, otherOwnerId]));
      }
    } finally {
      await pool.end();
    }
  });
  const migrationsFolder = fileURLToPath(
    new URL('../../migrations', import.meta.url),
  );
  await migrate(db, { migrationsFolder });
  await migrate(db, { migrationsFolder }); // Applying the same history twice must be safe.
  await db.insert(users).values([
    { id: ownerId, email: `${ownerId}@example.test` },
    { id: otherOwnerId, email: `${otherOwnerId}@example.test` },
  ]);
  seeded = true;
  const repository = new PostgresProjectRepository(db);
  const app = buildApp({
    env: { ...env, managementUserId: ownerId },
    projectRepository: repository,
    logger: false,
  });
  t.after(() => app.close());
  const payload = { name: 'Integration shop', slug: `shop-${randomUUID()}` };
  const created = await app.inject({
    method: 'POST',
    url: '/internal/projects',
    headers: auth,
    payload,
  });
  assert.equal(created.statusCode, 201, created.body);
  const saved = await repository.findOwnedById(created.json().id, ownerId);
  assert.equal(saved?.slug, payload.slug);
  const secondApp = buildApp({
    env: { ...env, managementUserId: ownerId },
    projectRepository: new PostgresProjectRepository(db),
    logger: false,
  });
  t.after(() => secondApp.close());
  assert.equal(
    (
      await secondApp.inject({
        url: `/internal/projects/${saved!.id}`,
        headers: auth,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    await repository.findOwnedById(saved!.id, otherOwnerId),
    undefined,
  );
  const foreign = await repository.create(otherOwnerId, {
    name: 'Other',
    slug: `other-${randomUUID()}`,
  });
  assert.equal(
    (
      await app.inject({
        url: `/internal/projects/${foreign.id}`,
        headers: auth,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/internal/projects',
        headers: auth,
        payload,
      })
    ).statusCode,
    409,
  );
  await assert.rejects(
    repository.create(randomUUID(), {
      name: 'Missing owner',
      slug: `missing-${randomUUID()}`,
    }),
    { code: 'OWNER_UNAVAILABLE' },
  );
  await assert.rejects(
    db
      .insert(projects)
      .values({ ownerId, name: 'Bad slug', slug: 'Invalid Slug' }),
  );
  await assert.rejects(
    db
      .insert(projects)
      .values({ ownerId, name: ' ', slug: `empty-${randomUUID()}` }),
  );
  await assert.rejects(db.delete(users).where(eq(users.id, ownerId)));
  await assert.rejects(
    db.insert(users).values({ email: `${ownerId}@EXAMPLE.TEST` }),
  );
  const listed = await repository.listOwned(ownerId, 100, 0);
  assert.ok(listed.some((item) => item.id === saved!.id));
  assert.ok(listed.every((item) => item.ownerId === ownerId));
  assert.equal((await repository.listOwned(ownerId, 1, 0)).length, 1);
  const dangerousName = "Robert'); DROP TABLE users;--";
  const safe = await repository.create(ownerId, {
    name: dangerousName,
    slug: `safe-${randomUUID()}`,
  });
  assert.equal(
    (await repository.findOwnedById(safe.id, ownerId))?.name,
    dangerousName,
  );
  assert.equal(
    (await db.select().from(users).where(eq(users.id, ownerId))).length,
    1,
  );
});
