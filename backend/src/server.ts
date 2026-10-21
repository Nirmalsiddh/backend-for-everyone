import { ObservabilityReadStore } from './modules/observability/read-store.js';
import { TelemetryStore } from './modules/observability/store.js';
import { EventWriter } from './modules/observability/writer.js';
import { ObservabilityRepository } from './modules/observability/queries.js';
import { runtimeAdmission } from './operations/runtime-admission.js';
import { setupLeases } from './operations/setup-lease.js';
import { PostgresDocsRepository } from './modules/api-docs/repository.js';
import { createReadiness } from './database/platform-db/readiness.js';
import { PostgresWorkflowRepository } from './modules/workflows/repository.js';
import { PostgresAuthRepository } from './modules/project-auth/repository.js';
import { PostgresEndpointRepository } from './modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from './modules/api-keys/repository.js';
import { PostgresRuntimeRepository } from './runtime/repository.js';
import { PostgresSchemaRepository } from './modules/schema-builder/repository.js';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createPlatformDatabase } from './database/platform-db/client.js';
import { PostgresPlatformAuthRepository } from './modules/platform-auth/repository.js';
import { PostgresProjectRepository } from './modules/projects/repository.js';
import { PostgresConnectionRepository } from './modules/database-connections/repository.js';

async function main() {
  const env = loadEnv();
  const { db, pool } = createPlatformDatabase(env.databaseUrl);
  const leases = setupLeases(env.databaseUrl);
  const readiness = createReadiness(env.databaseUrl);
  let lastTelemetryLog = 0;
  const warn = (message: string, count = 0) => {
    if (Date.now() - lastTelemetryLog < 10000) return;
    lastTelemetryLog = Date.now();
    console.warn(JSON.stringify({ event: message, count }));
  };
  const telemetryStore = new TelemetryStore(env.databaseUrl, () => warn('observability_pool_error'));
  const writer = new EventWriter((events) => telemetryStore.insert(events), warn);
  const app = buildApp({
    telemetry: writer,
    observabilityRepository: new ObservabilityRepository(new ObservabilityReadStore(pool)),
    env,
    runtimeAdmission: runtimeAdmission(db),
    acquireSetupLease: leases.acquire,
    docsRepository: new PostgresDocsRepository(db),
    readiness: readiness.check,
    platformAuthRepository: new PostgresPlatformAuthRepository(db),
    projectRepository: new PostgresProjectRepository(db),
    connectionRepository: new PostgresConnectionRepository(db),
    schemaRepository: new PostgresSchemaRepository(db),
    endpointRepository: new PostgresEndpointRepository(db),
    apiKeyRepository: new PostgresApiKeyRepository(db),
    runtimeRepository: new PostgresRuntimeRepository(db),
    authRepository: new PostgresAuthRepository(db),
    workflowRepository: new PostgresWorkflowRepository(db),
  });
  let cleaning = false;
  const cleanup = setInterval(() => {
    if (cleaning) return;
    cleaning = true;
    void (async () => {
      for (let batch = 0; batch < 5; batch++) {
        if (await telemetryStore.cleanup() < 1000) break;
      }
    })().catch(() => warn('observability_cleanup_failed')).finally(() => { cleaning = false; });
  }, 300000);
  cleanup.unref();
  pool.on('error', () => app.log.error('Platform database pool error'));
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
    await writer.close();
    await telemetryStore.close();
    await leases.close();
    await readiness.close();
    await pool.end();
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await readiness.check();
    await app.listen({ host: env.host, port: env.port });
  } catch {
    app.log.error('Startup failed; verify configuration and migrations');
    process.exitCode = 1;
    await shutdown();
  }
}

main().catch(() => {
  console.error('Backend startup failed; verify environment configuration.');
  process.exitCode = 1;
});
