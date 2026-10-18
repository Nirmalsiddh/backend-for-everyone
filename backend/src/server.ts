import { PostgresWorkflowRepository } from './modules/workflows/repository.js';
import { PostgresAuthRepository } from './modules/project-auth/repository.js';
import { PostgresEndpointRepository } from './modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from './modules/api-keys/repository.js';
import { PostgresRuntimeRepository } from './runtime/repository.js';
import { PostgresSchemaRepository } from './modules/schema-builder/repository.js';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPlatformDatabase } from './database/platform-db/client.js';
import { users } from './database/platform-db/schema.js';
import { PostgresProjectRepository } from './modules/projects/repository.js';
import { PostgresConnectionRepository } from './modules/database-connections/repository.js';
import { eq } from 'drizzle-orm';

async function main() {
  const env = loadEnv();
  const { db, pool } = createPlatformDatabase(env.databaseUrl);
  const app = buildApp({ env, projectRepository: new PostgresProjectRepository(db),
    connectionRepository: new PostgresConnectionRepository(db), schemaRepository: new PostgresSchemaRepository(db), endpointRepository: new PostgresEndpointRepository(db),
    apiKeyRepository: new PostgresApiKeyRepository(db), runtimeRepository: new PostgresRuntimeRepository(db), authRepository: new PostgresAuthRepository(db), workflowRepository: new PostgresWorkflowRepository(db) });
  pool.on('error', () => app.log.error('Platform database pool error'));
  app.addHook('onClose', async () => { await pool.end(); });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); } catch { process.exitCode = 1; }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    const [owner] = await db.select({ id: users.id }).from(users)
      .where(eq(users.id, env.managementUserId)).limit(1);
    if (!owner) throw new Error('Configured management user does not exist');
    await app.listen({ host: env.host, port: env.port });
  } catch {
    app.log.error('Startup failed; verify configuration, migrations, and management user');
    process.exitCode = 1;
    await shutdown();
  }
}

main().catch(() => {
  console.error('Backend startup failed; verify environment configuration.');
  process.exitCode = 1;
});
