import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Validator } from '@seriousme/openapi-schema-validator';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import {
  projects,
  users,
  schemaTables,
  schemaFields,
  endpoints,
  databaseConnections,
  workflowEndpoints,
  workflowVersions,
  schemaMigrations,
} from '../../src/database/platform-db/schema.js';
import { PostgresDocsRepository } from '../../src/modules/api-docs/repository.js';
import { DocsService } from '../../src/modules/api-docs/service.js';
import { parseDatabaseUrl } from '../../src/config/env.js';
import { snapshot } from '../api-docs-fixtures.js';
test('PostgreSQL docs snapshot: ownership, draft isolation, applied/published changes, toggles and blocked states', async (t) => {
  const url = parseDatabaseUrl(
    process.env.TEST_DATABASE_URL,
    'TEST_DATABASE_URL',
  );
  assert.notEqual(url, process.env.PLATFORM_DATABASE_URL);
  const { db, pool } = createPlatformDatabase(url);
  const owner = randomUUID(),
    foreign = randomUUID(),
    projectId = randomUUID(),
    connectionId = randomUUID(),
    tableId = randomUUID(),
    workflowId = randomUUID();
  t.after(async () => {
    try {
      await db
        .delete(schemaMigrations)
        .where(eq(schemaMigrations.projectId, projectId));
      await db
        .delete(workflowEndpoints)
        .where(eq(workflowEndpoints.projectId, projectId));
      await db
        .delete(schemaTables)
        .where(eq(schemaTables.projectId, projectId));
      await db
        .delete(databaseConnections)
        .where(eq(databaseConnections.projectId, projectId));
      await db.delete(projects).where(eq(projects.id, projectId));
      await db.delete(users).where(eq(users.id, owner));
    } finally {
      await pool.end();
    }
  });
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL('../../migrations', import.meta.url),
    ),
  });
  await db.insert(users).values({ id: owner, email: `${owner}@example.test` });
  await db
    .insert(projects)
    .values({
      id: projectId,
      ownerId: owner,
      name: 'Docs',
      slug: `docs-${projectId}`,
    });
  // Deliberately unusable connection: docs generation must not decrypt or connect.
  await db
    .insert(databaseConnections)
    .values({
      id: connectionId,
      projectId,
      label: 'Unused',
      encryptedConfig: 'secret-encrypted-fixture',
      encryptionIv: '11'.repeat(12),
      encryptionTag: '11'.repeat(12),
      encryptionVersion: 1,
      lastTestStatus: 'success',
      lastTestedAt: new Date(),
    });
  const input = snapshot(),
    fields = input.resources[0]!.fields!.map((f) => ({
      ...f,
      id: randomUUID(),
    }));
  const definition = {
    schema: 'private_schema_sentinel',
    name: 'tasks',
    fields,
  };
  await db
    .insert(schemaTables)
    .values({
      id: tableId,
      projectId,
      connectionId,
      schemaName: definition.schema,
      name: 'tasks',
      draftRevision: 1,
      appliedRevision: 1,
      appliedDefinition: { definition, catalog: { secret: 'catalog-secret' } },
    });
  await db
    .insert(schemaFields)
    .values(
      fields.map((f) => ({ ...f, tableId, position: fields.indexOf(f) })),
    );
  const policy = {
    mode: 'owner' as const,
    ownerFieldId: fields[2]!.id,
    allowAdmin: false,
  };
  await db
    .insert(endpoints)
    .values({
      projectId,
      tableId,
      resourceName: 'tasks',
      enabledOperations: ['list', 'create', 'update'],
      policies: { list: policy, create: policy, update: policy },
    });
  const published = input.workflows[0]!.definition!;
  await db
    .insert(workflowEndpoints)
    .values({
      id: workflowId,
      projectId,
      connectionId,
      path: 'place-order',
      enabled: true,
      draftDefinition: published,
    });
  const [version] = await db
    .insert(workflowVersions)
    .values({
      workflowEndpointId: workflowId,
      version: 1,
      definition: published,
      definitionHash: 'a'.repeat(64),
      schemaDependencies: [{ tableId, appliedRevision: 1 }],
    })
    .returning();
  await db
    .update(workflowEndpoints)
    .set({ publishedVersionId: version!.id })
    .where(eq(workflowEndpoints.id, workflowId));
  const repo = new PostgresDocsRepository(db),
    service = new DocsService(repo, 'https://api.example.test');
  const initial = await service.get(projectId, owner);
  assert.equal(
    (
      await new Validator().validate(
        initial as unknown as Record<string, unknown>,
      )
    ).valid,
    true,
  );
  await assert.rejects(service.get(projectId, foreign), { statusCode: 404 });
  await db
    .update(schemaFields)
    .set({ name: 'draft_secret_field' })
    .where(eq(schemaFields.id, fields[0]!.id));
  await db
    .update(schemaTables)
    .set({ draftRevision: 2 })
    .where(eq(schemaTables.id, tableId));
  await db
    .update(workflowEndpoints)
    .set({
      draftDefinition: {
        ...published,
        input: { draft_secret_input: { type: 'string' } },
      },
      draftRevision: 2,
    })
    .where(eq(workflowEndpoints.id, workflowId));
  assert.deepEqual(await service.get(projectId, owner), initial);
  const updated = {
    ...definition,
    fields: fields.map((f, i) =>
      i === 0 ? { ...f, name: 'applied_title' } : f,
    ),
  };
  await db
    .update(schemaTables)
    .set({
      appliedDefinition: { definition: updated, catalog: {} },
      appliedRevision: 2,
    })
    .where(eq(schemaTables.id, tableId));
  await assert.rejects(service.get(projectId, owner), { statusCode: 503 }); // workflow dependency is stale
  await db
    .update(workflowEndpoints)
    .set({ enabled: false })
    .where(eq(workflowEndpoints.id, workflowId));
  const applied = await service.get(projectId, owner);
  assert.ok(!applied.paths['/place-order']);
  assert.ok(JSON.stringify(applied).includes('applied_title'));
  const [v2] = await db
    .insert(workflowVersions)
    .values({
      workflowEndpointId: workflowId,
      version: 2,
      definition: {
        ...published,
        input: { published_input: { type: 'boolean' } },
      },
      definitionHash: 'b'.repeat(64),
      schemaDependencies: [{ tableId, appliedRevision: 2 }],
    })
    .returning();
  await db
    .update(workflowEndpoints)
    .set({ enabled: true, publishedVersionId: v2!.id })
    .where(eq(workflowEndpoints.id, workflowId));
  assert.ok(
    JSON.stringify(await service.get(projectId, owner)).includes(
      'published_input',
    ),
  );
  await db
    .update(endpoints)
    .set({ enabledOperations: ['list'] })
    .where(eq(endpoints.projectId, projectId));
  const disabled = await service.get(projectId, owner);
  assert.ok(!disabled.paths['/tasks']!.post);
  assert.ok(!disabled.paths['/tasks/{id}']);
  await db
    .insert(schemaMigrations)
    .values({
      id: randomUUID(),
      projectId,
      tableId,
      draftRevision: 2,
      planHash: 'c'.repeat(64),
      definition: updated,
      status: 'outcome_unknown',
    });
  await assert.rejects(service.get(projectId, owner), {
    code: 'API_DOCS_UNAVAILABLE',
  });
  for (const secret of [
    'secret-encrypted-fixture',
    'private_schema_sentinel',
    'catalog-secret',
    ...fields.map((f) => f.id),
    workflowId,
    version!.id,
  ])
    assert.ok(!JSON.stringify(initial).includes(secret), secret);
});
