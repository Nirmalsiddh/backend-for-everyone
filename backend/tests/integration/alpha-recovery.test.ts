import { catalog } from '../../src/database/customer-db/catalog.js';
import { writeReceipt } from '../../src/operations/receipts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectCredentials } from '../../src/database/customer-db/credential-check.js';
import { ApiKeyService } from '../../src/modules/api-keys/service.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { createReadiness } from '../../src/database/platform-db/readiness.js';
import {
  projects,
  apiKeys,
  platformSessions,
  databaseConnections,
  schemaMigrations,
  projectAuthConfigs,
} from '../../src/database/platform-db/schema.js';
import { CredentialEncryption } from '../../src/security/encryption.js';
import { createPasswordHasher } from '../../src/security/passwords.js';
import { createSchemaExecutor } from '../../src/database/customer-db/schema-executor.js';
import { createAuthStore } from '../../src/database/customer-db/auth-store.js';
import { generatePlan } from '../../src/modules/schema-builder/plan.js';
import { PostgresPlatformAuthRepository } from '../../src/modules/platform-auth/repository.js';
import { platformTokenHash } from '../../src/modules/platform-auth/service.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { PostgresEndpointRepository } from '../../src/modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { hashKey } from '../../src/modules/api-keys/service.js';
import { PostgresAuthRepository } from '../../src/modules/project-auth/repository.js';
import { tokenHash } from '../../src/modules/project-auth/service.js';
import { PostgresWorkflowRepository } from '../../src/modules/workflows/repository.js';
import { PostgresDocsRepository } from '../../src/modules/api-docs/repository.js';
import { PostgresRuntimeRepository } from '../../src/runtime/repository.js';
import { runtimeAdmission } from '../../src/operations/runtime-admission.js';
import { reconcile } from '../../src/operations/reconciliation.js';
import { containRestore } from '../../src/operations/containment.js';
import type { TableRecord } from '../../src/modules/schema-builder/types.js';
import type { AuthContext } from '../../src/modules/project-auth/types.js';
import { env } from '../helpers.js';

test('baseline upgrade, same-target credentials, interrupted setup and restore containment', async (t) => {
  const url = process.env.TEST_UPGRADE_DATABASE_URL;
  if (!url) {
    t.skip('Explicit empty disposable TEST_UPGRADE_DATABASE_URL required');
    return;
  }
  const { db, pool } = createPlatformDatabase(url);
  const customerUrl = new URL(process.env.TEST_CUSTOMER_DATABASE_URL!);
  const customer = new pg.Client({ connectionString: customerUrl.toString() });
  await customer.connect();
  const temporary = await mkdtemp(join(tmpdir(), 'alpha-baseline-'));
  const folder = fileURLToPath(new URL('../../migrations', import.meta.url));
  const journal = JSON.parse(
    await readFile(join(folder, 'meta/_journal.json'), 'utf8'),
  );
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 6);
  await mkdir(join(temporary, 'meta'));
  await writeFile(
    join(temporary, 'meta/_journal.json'),
    JSON.stringify(journal),
  );
  for (const entry of journal.entries)
    await copyFile(
      join(folder, entry.tag + '.sql'),
      join(temporary, entry.tag + '.sql'),
    );
  assert.equal(
    (await pool.query("SELECT 1 FROM pg_tables WHERE schemaname='public'"))
      .rowCount,
    0,
    'Upgrade fixture DB must be empty',
  );
  await migrate(db, { migrationsFolder: temporary });
  const schema = 'alpha_' + randomBytes(6).toString('hex'),
    role = 'alpha_role_' + randomBytes(5).toString('hex');
  await customer.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    await customer.query(`DROP SCHEMA "${schema}" CASCADE`);
    await customer.query(`DROP ROLE IF EXISTS "${role}"`);
    await customer.end();
    await pool.end();
    await rm(temporary, { recursive: true, force: true });
  });
  const ownerId = randomUUID(),
    projectId = randomUUID(),
    connectionId = randomUUID(),
    tableId = randomUUID(),
    authId = randomUUID(),
    keyId = randomUUID(),
    sessionId = randomUUID();
  const email = 'baseline-' + randomUUID() + '@example.test',
    password = 'baseline-password-123456789';
  const passwordHash = await createPasswordHasher().hash(password),
    encryption = new CredentialEncryption(env.connectionEncryptionKey),
    now = new Date();
  const config = {
    host: customerUrl.hostname,
    port: Number(customerUrl.port || 5432),
    database: customerUrl.pathname.slice(1),
    username: decodeURIComponent(customerUrl.username),
    password: decodeURIComponent(customerUrl.password),
    schema,
    ssl: false,
  };
  const encrypted = encryption.encrypt(config, `${projectId}:${connectionId}`),
    slug = 'baseline-' + randomBytes(4).toString('hex');
  await pool.query(
    'INSERT INTO users(id,email,password_hash,status) VALUES($1,$2,$3,$4)',
    [ownerId, email, passwordHash, 'active'],
  );
  await pool.query(
    'INSERT INTO projects(id,owner_id,name,slug) VALUES($1,$2,$3,$4)',
    [projectId, ownerId, 'Baseline fixture', slug],
  );
  await pool.query(
    'INSERT INTO database_connections(id,project_id,label,encrypted_config,encryption_iv,encryption_tag,encryption_version,last_test_status,last_tested_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,now())',
    [
      connectionId,
      projectId,
      'Baseline DB',
      encrypted.encryptedConfig,
      encrypted.encryptionIv,
      encrypted.encryptionTag,
      'success',
    ],
  );
  const fields: TableRecord['fields'] = [
    {
      id: randomUUID(),
      name: 'title',
      position: 0,
      type: 'text',
      options: {},
      nullable: false,
      unique: false,
      default: null,
    },
  ];
  const table: TableRecord = {
    id: tableId,
    projectId,
    connectionId,
    schemaName: schema,
    name: 'tasks',
    fields,
    draftRevision: 1,
    appliedRevision: null,
    appliedDefinition: null,
    createdAt: now,
    updatedAt: now,
  };
  const plan = generatePlan(table),
    snapshot = await createSchemaExecutor()(config, plan, null),
    applied = { definition: plan.definition, catalog: snapshot };
  await pool.query(
    'INSERT INTO schema_tables(id,project_id,connection_id,schema_name,name,draft_revision,applied_revision,applied_definition) VALUES($1,$2,$3,$4,$5,1,1,$6)',
    [tableId, projectId, connectionId, schema, 'tasks', applied],
  );
  for (const f of fields)
    await pool.query(
      'INSERT INTO schema_fields(id,table_id,name,position,type,type_options,nullable,"unique") VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        f.id,
        tableId,
        f.name,
        f.position,
        f.type,
        f.options,
        f.nullable,
        f.unique,
      ],
    );
  await pool.query(
    'INSERT INTO endpoints(project_id,table_id,resource_name,enabled_operations,policies) VALUES($1,$2,$3,$4,$5)',
    [
      projectId,
      tableId,
      'tasks',
      JSON.stringify(['list', 'create']),
      { list: { mode: 'key_only' }, create: { mode: 'authenticated' } },
    ],
  );
  const context: AuthContext = {
    blocked: false,
    connection: {
      id: connectionId,
      projectId,
      label: 'DB',
      ...encrypted,
      lastTestStatus: 'success',
      lastTestedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    config: {
      id: authId,
      projectId,
      connectionId,
      enabled: true,
      signupEnabled: true,
      provisioningStatus: 'provisioning',
      authSchemaVersion: 1,
      authUsersTableName:
        'platform_auth_users_' + projectId.replaceAll('-', ''),
      authSessionsTableName:
        'platform_auth_sessions_' + projectId.replaceAll('-', ''),
      sessionLifetimeSeconds: 86400,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      catalog: null,
    },
  };
  const store = createAuthStore(encryption);
  context.config.catalog = await store.provision(context);
  context.config.provisioningStatus = 'ready';
  await pool.query(
    'INSERT INTO project_auth_configs(id,project_id,connection_id,enabled,signup_enabled,provisioning_status,auth_users_table_name,auth_sessions_table_name,catalog) VALUES($1,$2,$3,true,true,$4,$5,$6,$7)',
    [
      authId,
      projectId,
      connectionId,
      'ready',
      context.config.authUsersTableName,
      context.config.authSessionsTableName,
      context.config.catalog,
    ],
  );
  const appUser = await store.signup(
      context,
      'application@example.test',
      passwordHash,
    ),
    applicationToken = 'us_' + randomBytes(32).toString('base64url');
  await store.login(
    context,
    { ...appUser, passwordHash, status: 'active' },
    tokenHash(applicationToken),
  );
  const key = 'pk_' + randomBytes(32).toString('base64url'),
    platformToken = 'ps_' + randomBytes(32).toString('base64url');
  await pool.query(
    'INSERT INTO api_keys(id,project_id,name,key_hash,key_prefix,scope,created_at) VALUES($1,$2,$3,$4,$5,$6,now())',
    [
      keyId,
      projectId,
      'Baseline key',
      hashKey(key),
      key.slice(0, 11),
      'read_write',
    ],
  );
  await pool.query(
    "INSERT INTO platform_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
    [sessionId, ownerId, platformTokenHash(platformToken)],
  );
  const workflowId = randomUUID(),
    versionId = randomUUID(),
    definition = {
      input: {},
      auth: 'key_only',
      steps: [
        {
          id: randomUUID(),
          name: 'respond',
          type: 'response',
          status: 200,
          body: { kind: 'object', fields: {} },
        },
      ],
    };
  await pool.query(
    'INSERT INTO workflow_endpoints(id,project_id,connection_id,path,enabled,draft_definition) VALUES($1,$2,$3,$4,true,$5)',
    [workflowId, projectId, connectionId, 'baseline-flow', definition],
  );
  await pool.query(
    'INSERT INTO workflow_versions(id,workflow_endpoint_id,version,definition,definition_hash,schema_dependencies) VALUES($1,$2,1,$3,$4,$5)',
    [versionId, workflowId, definition, 'a'.repeat(64), '[]'],
  );
  await pool.query(
    'UPDATE workflow_endpoints SET published_version_id=$1 WHERE id=$2',
    [versionId, workflowId],
  );
  // Existing resources are now upgraded, never recreated.
  await migrate(db, { migrationsFolder: folder });
  const readiness = createReadiness(url);
  await readiness.check();
  await readiness.close();
  const connections = new PostgresConnectionRepository(db),
    schemas = new PostgresSchemaRepository(db);
  const app = buildApp({
    env: { ...env, databaseUrl: url },
    logger: false,
    runtimeAdmission: runtimeAdmission(db),
    platformAuthRepository: new PostgresPlatformAuthRepository(db),
    projectRepository: new PostgresProjectRepository(db),
    connectionRepository: connections,
    schemaRepository: schemas,
    endpointRepository: new PostgresEndpointRepository(db),
    apiKeyRepository: new PostgresApiKeyRepository(db),
    authRepository: new PostgresAuthRepository(db),
    workflowRepository: new PostgresWorkflowRepository(db),
    runtimeRepository: new PostgresRuntimeRepository(db),
    docsRepository: new PostgresDocsRepository(db),
  });
  t.after(() => app.close());
  const headers = { authorization: 'Bearer ' + platformToken };
  await t.test(
    'upgraded login/session, ownership, key, CRUD, application auth, published workflow and Docs',
    async () => {
      assert.equal(
        (await app.inject({ url: '/internal/auth/me', headers })).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/internal/auth/login',
            payload: { email, password },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({ url: `/internal/projects/${projectId}`, headers })
        ).json().id,
        projectId,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/${slug}/tasks`,
            headers: { authorization: 'Bearer ' + key },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/${slug}/tasks`,
            headers: { authorization: 'Bearer ' + applicationToken },
            payload: { title: 'Upgraded record' },
          })
        ).statusCode,
        201,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/${slug}/auth/login`,
            payload: { email: 'application@example.test', password },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/${slug}/baseline-flow`,
            headers: { authorization: 'Bearer ' + key },
            payload: {},
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            url: `/internal/projects/${projectId}/openapi`,
            headers,
          })
        ).statusCode,
        200,
      );
    },
  );
  await t.test(
    'response ceiling rejects complete oversized JSON and project rate limit supplies Retry-After',
    async () => {
      const result = await customer.query(
        `INSERT INTO "${schema}".tasks(title) VALUES($1) RETURNING id`,
        ['x'.repeat(1048576)],
      );
      const request = {
        url: `/api/${slug}/tasks`,
        headers: {
          authorization: 'Bearer ' + key,
          origin: 'https://app.example.test',
        },
      };
      const oversized = await app.inject(request);
      assert.equal(oversized.statusCode, 422);
      assert.equal(oversized.json().code, 'RESPONSE_TOO_LARGE');
      assert.ok(oversized.body.length < 1024);
      await customer.query(`DELETE FROM "${schema}".tasks WHERE id=$1`, [
        result.rows[0].id,
      ]);
      const responses = await Promise.all(
        Array.from({ length: 25 }, () => app.inject(request)),
      );
      const limited = responses.find((response) => response.statusCode === 429);
      assert.ok(limited);
      assert.equal(limited.headers['retry-after'], '1');
      assert.equal(limited.json().code, 'RUNTIME_RATE_LIMITED');
      assert.match(String(limited.headers['x-request-id']), /^[a-f0-9-]{36}$/);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    },
  );
  await t.test(
    'candidate credentials preserve target, failed candidates preserve old ciphertext, stale updates fail',
    async () => {
      await customer.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'alpha-role-disposable' IN ROLE postgres`,
      );
      const url = `/internal/projects/${projectId}/database-connection/credentials`,
        candidate = {
          expectedRevision: 1,
          username: role,
          password: 'wrong',
          ssl: false,
        };
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url,
            headers,
            payload: { ...candidate, host: 'other.example.test' },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ method: 'PUT', url, headers, payload: candidate }))
          .statusCode,
        422,
      );
      assert.equal(
        (await connections.findOwned(projectId, ownerId))!.encryptedConfig,
        encrypted.encryptedConfig,
      );
      const response = await app.inject({
        method: 'PUT',
        url,
        headers,
        payload: { ...candidate, password: 'alpha-role-disposable' },
      });
      assert.equal(response.statusCode, 200, response.json().code);
      assert.equal(response.json().revision, 2);
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url,
            headers,
            payload: { ...candidate, password: 'alpha-role-disposable' },
          })
        ).statusCode,
        409,
      );
      const decoded = encryption.decrypt<typeof config>(
        (await connections.findOwned(projectId, ownerId))!,
        `${projectId}:${connectionId}`,
      );
      assert.deepEqual(
        [decoded.host, decoded.port, decoded.database, decoded.schema],
        [config.host, config.port, config.database, config.schema],
      );
      await customer.query(
        `ALTER ROLE "${role}" SET default_transaction_read_only=on`,
      );
      await assert.rejects(
        inspectCredentials(decoded, { schemas: [], auth: null }),
        { code: 'DATABASE_READ_ONLY' },
      );
      await customer.query(
        `ALTER ROLE "${role}" RESET default_transaction_read_only`,
      );
      await customer.query(`REVOKE postgres FROM "${role}"`);
      await assert.rejects(
        inspectCredentials(decoded, { schemas: [], auth: null }),
        { code: 'SCHEMA_ACCESS_MISSING' },
      );
      await customer.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await assert.rejects(
        inspectCredentials(decoded, { schemas: [], auth: null }),
        { code: 'DDL_CAPABILITY_MISSING' },
      );
      await customer.query(`GRANT CREATE ON SCHEMA "${schema}" TO "${role}"`);
      const required = {
        schemas: [{ name: 'tasks', catalog: snapshot }],
        auth: null,
      };
      await assert.rejects(inspectCredentials(decoded, required), {
        code: 'READ_CAPABILITY_MISSING',
      });
      await customer.query(`GRANT SELECT ON "${schema}".tasks TO "${role}"`);
      await assert.rejects(inspectCredentials(decoded, required), {
        code: 'WRITE_CAPABILITY_MISSING',
      });
      await customer.query(
        `GRANT INSERT, UPDATE, DELETE ON "${schema}".tasks TO "${role}"`,
      );
      await assert.rejects(inspectCredentials(decoded, required), {
        code: 'DDL_CAPABILITY_MISSING',
      });
      await customer.query(`GRANT postgres TO "${role}"`);
    },
  );
  await t.test(
    'auth POST reconciliation finalizes exactly recorded catalogs; diverged objects stay blocked',
    async () => {
      await db
        .update(projectAuthConfigs)
        .set({ provisioningStatus: 'provisioning' })
        .where(eq(projectAuthConfigs.id, authId));
      assert.equal(
        (await reconcile(db, encryption, projectId, authId, 'auth'))
          .classification,
        'POST_STATE',
      );
      assert.equal(
        (await reconcile(db, encryption, projectId, authId, 'auth', true))
          .applied,
        true,
      );
    },
  );
  await t.test(
    'customer transaction lock prevents PRE_STATE classification before in-flight DDL commits',
    async () => {
      const draft = await schemas.create(
        projectId,
        ownerId,
        {
          name: 'locked_recovery',
          fields: [{ name: 'title', type: 'text', nullable: true }],
        },
        {
          connectionId,
          encryptedConfig: (await connections.findOwned(projectId, ownerId))!
            .encryptedConfig,
          schemaName: schema,
        },
      );
      const plan = generatePlan(draft);
      const operationId = await schemas.begin(
        projectId,
        ownerId,
        draft.id,
        plan,
      );
      const ddl = new pg.Client({ connectionString: customerUrl.toString() });
      await ddl.connect();
      let inspection: ReturnType<typeof reconcile> | undefined;
      try {
        await ddl.query('BEGIN');
        await ddl.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`schema-builder:${schema}`],
        );
        for (const statement of plan.statements) await ddl.query(statement);
        await writeReceipt(
          ddl,
          encryption,
          schema,
          draft.name,
          `schema:${projectId}:${operationId}:${plan.hash}`,
          await catalog(ddl, schema, draft.name),
        );
        let settled = false;
        inspection = reconcile(
          db,
          encryption,
          projectId,
          operationId,
          'schema',
        ).finally(() => {
          settled = true;
        });
        let waiting = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          const result = await customer.query(
            "SELECT 1 FROM pg_stat_activity WHERE application_name='platform-reconciliation' AND wait_event_type='Lock'",
          );
          if (result.rows.length) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(
          waiting,
          true,
          'Recovery must wait for the customer transaction, independent of platform lease state',
        );
        assert.equal(settled, false);
        await ddl.query('COMMIT');
        assert.equal((await inspection).classification, 'POST_STATE');
        assert.equal(
          (
            await reconcile(
              db,
              encryption,
              projectId,
              operationId,
              'schema',
              true,
            )
          ).applied,
          true,
        );
      } finally {
        await ddl.end();
        await inspection?.catch(() => {});
      }
    },
  );
  await t.test(
    'schema PRE, POST and DIVERGED classification never reruns DDL',
    async () => {
      for (const outcome of ['PRE_STATE', 'POST_STATE', 'DIVERGED'] as const) {
        const draft = await schemas.create(
          projectId,
          ownerId,
          {
            name: outcome.toLowerCase(),
            fields: [{ name: 'title', type: 'text', nullable: true }],
          },
          {
            connectionId,
            encryptedConfig: (await connections.findOwned(projectId, ownerId))!
              .encryptedConfig,
            schemaName: schema,
          },
        );
        const plan = generatePlan(draft),
          operationId = await schemas.begin(projectId, ownerId, draft.id, plan);
        if (outcome === 'POST_STATE')
          await createSchemaExecutor(undefined, encryption)(
            config,
            { ...plan, receipt: { projectId, operationId } },
            null,
          );
        if (outcome === 'DIVERGED')
          await customer.query(
            `CREATE TABLE "${schema}"."diverged" (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
          );
        assert.equal(
          (await reconcile(db, encryption, projectId, operationId, 'schema'))
            .classification,
          outcome,
        );
        assert.equal(
          (
            await reconcile(
              db,
              encryption,
              projectId,
              operationId,
              'schema',
              true,
            )
          ).classification,
          outcome,
        );
        const [op] = await db
          .select()
          .from(schemaMigrations)
          .where(eq(schemaMigrations.id, operationId));
        assert.equal(
          op!.status,
          outcome === 'POST_STATE'
            ? 'applied'
            : outcome === 'PRE_STATE'
              ? 'failed'
              : 'applying',
        );
      }
    },
  );
  await t.test(
    'suspension blocks all new runtime paths; restored old keys and platform sessions are contained',
    async () => {
      await db
        .update(projects)
        .set({ runtimeState: 'suspended' })
        .where(eq(projects.id, projectId));
      for (const [method, path] of [
        ['GET', 'tasks'],
        ['POST', 'baseline-flow'],
        ['POST', 'auth/login'],
        ['POST', 'auth/signup'],
        ['GET', 'auth/me'],
        ['POST', 'auth/logout'],
      ] as const)
        assert.equal(
          (
            await app.inject({
              method,
              url: `/api/${slug}/${path}`,
              headers: { authorization: 'Bearer ' + key },
              ...(method === 'POST' ? { payload: {} } : {}),
            })
          ).json().code,
          'PROJECT_SUSPENDED',
        );
      assert.equal(
        (await app.inject({ url: `/internal/projects/${projectId}`, headers }))
          .statusCode,
        200,
      );
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, keyId));
      // An older backup contains the previously active key and platform session.
      await db
        .update(apiKeys)
        .set({ revokedAt: null })
        .where(eq(apiKeys.id, keyId));
      await db
        .update(platformSessions)
        .set({ revokedAt: null })
        .where(eq(platformSessions.id, sessionId));
      await db
        .update(projects)
        .set({ runtimeState: 'active' })
        .where(eq(projects.id, projectId));
      await containRestore(db);
      assert.equal(
        (
          await app.inject({
            url: `/api/${slug}/tasks`,
            headers: { authorization: 'Bearer ' + key },
          })
        ).json().code,
        'PROJECT_SUSPENDED',
      );
      assert.equal(
        (await app.inject({ url: '/internal/auth/me', headers })).statusCode,
        401,
      );
      await db
        .update(projects)
        .set({ runtimeState: 'active' })
        .where(eq(projects.id, projectId));
      assert.equal(
        (
          await app.inject({
            url: `/api/${slug}/tasks`,
            headers: { authorization: 'Bearer ' + key },
          })
        ).statusCode,
        401,
      );
    },
  );
  await t.test(
    'transactional alpha quotas cap concurrent projects, active keys, tables and workflows',
    async () => {
      const repo = new PostgresProjectRepository(db);
      const extra = await Promise.all([
        repo.create(ownerId, {
          name: 'Quota one',
          slug: 'quota-one-' + randomBytes(4).toString('hex'),
        }),
        repo.create(ownerId, {
          name: 'Quota two',
          slug: 'quota-two-' + randomBytes(4).toString('hex'),
        }),
      ]);
      await assert.rejects(
        repo.create(ownerId, {
          name: 'Excess',
          slug: 'quota-excess-' + randomBytes(4).toString('hex'),
        }),
        { code: 'ALPHA_LIMIT_REACHED' },
      );
      const keys = new ApiKeyService(new PostgresApiKeyRepository(db));
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          keys.create(projectId, ownerId, 'Quota ' + i, 'read'),
        ),
      );
      await assert.rejects(keys.create(projectId, ownerId, 'Excess', 'read'), {
        code: 'ALPHA_LIMIT_REACHED',
      });
      const pid = extra[0]!.id,
        cid = randomUUID(),
        cipher = encryption.encrypt(config, `${pid}:${cid}`);
      await db.insert(databaseConnections).values({
        id: cid,
        projectId: pid,
        label: 'Quota DB',
        ...cipher,
        lastTestStatus: 'success',
        lastTestedAt: new Date(),
      });
      for (let i = 0; i < 20; i++)
        await schemas.create(
          pid,
          ownerId,
          { name: 'quota_' + i, fields: [] },
          {
            connectionId: cid,
            encryptedConfig: cipher.encryptedConfig,
            schemaName: schema,
          },
        );
      await assert.rejects(
        schemas.create(
          pid,
          ownerId,
          { name: 'excess_table', fields: [] },
          {
            connectionId: cid,
            encryptedConfig: cipher.encryptedConfig,
            schemaName: schema,
          },
        ),
        { code: 'ALPHA_LIMIT_REACHED' },
      );
      const workflows = new PostgresWorkflowRepository(db);
      const wf = {
        input: {},
        auth: 'key_only' as const,
        steps: [
          {
            id: randomUUID(),
            name: 'respond',
            type: 'response' as const,
            status: 200 as const,
            body: { kind: 'object' as const, fields: {} },
          },
        ],
      };
      for (let i = 0; i < 10; i++)
        await workflows.create(pid, ownerId, 'quota-' + i, wf);
      await assert.rejects(
        workflows.create(pid, ownerId, 'excess-workflow', wf),
        { code: 'ALPHA_LIMIT_REACHED' },
      );
    },
  );
  await t.test(
    'isolated restore contains projects, keys and sessions even when the encryption key is invalid',
    async () => {
      await db.update(projects).set({ runtimeState: 'active' });
      await db.update(apiKeys).set({ revokedAt: null });
      await db.update(platformSessions).set({ revokedAt: null });
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(
              new URL(
                '../../src/database/platform-db/verify-restore.ts',
                import.meta.url,
              ),
            ),
          ],
          {
            env: {
              ...process.env,
              PLATFORM_DATABASE_URL: url,
              CONNECTION_ENCRYPTION_KEY: 'invalid',
              CONFIRM_ISOLATED_RESTORE: 'yes',
            },
          },
        ),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS total FROM projects WHERE runtime_state <> 'suspended'",
          )
        ).rows[0].total,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS total FROM api_keys WHERE revoked_at IS NULL',
          )
        ).rows[0].total,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS total FROM platform_sessions WHERE revoked_at IS NULL',
          )
        ).rows[0].total,
        0,
      );
    },
  );
});

test('real customer sockets share admission, absolute deadlines release capacity', async (t) => {
  const url = process.env.TEST_CUSTOMER_DATABASE_URL;
  if (!url) {
    t.skip('Explicit disposable customer DB required');
    return;
  }
  const { boundedClient, customerAdmission } = await import(
    '../../src/database/customer-db/admission.js'
  );
  const clients = Array.from({ length: 16 }, (_, index) =>
    boundedClient(
      { connectionString: url, application_name: 'alpha-budget-fixture' },
      index < 8 ? 'runtime' : index < 14 ? 'auth' : 'diagnostic',
    ),
  );
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  try {
    await Promise.all(clients.map((client) => client.connect()));
    assert.equal(customerAdmission.snapshot().total, 16);
    const sockets = await observer.query(
      "SELECT count(*)::int AS total FROM pg_stat_activity WHERE application_name='alpha-budget-fixture' AND datname=current_database()",
    );
    assert.equal(sockets.rows[0].total, 16);
    const extra = boundedClient({ connectionString: url }, 'schema');
    await assert.rejects(extra.connect(), {
      code: 'CUSTOMER_CAPACITY_EXHAUSTED',
    });
    await extra.end();
  } finally {
    await Promise.all(clients.map((client) => client.end()));
    await observer.end();
  }
  assert.equal(customerAdmission.snapshot().total, 0);
  const deadline = boundedClient({ connectionString: url }, 'diagnostic', 250);
  deadline.on('error', () => {});
  try {
    await deadline.connect();
    await assert.rejects(deadline.query('SELECT pg_sleep(1)'), {
      code: 'CUSTOMER_OPERATION_TIMEOUT',
    });
  } finally {
    await deadline.end();
  }
  assert.equal(customerAdmission.snapshot().total, 0);
});
