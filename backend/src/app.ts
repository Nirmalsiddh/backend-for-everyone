import { typeScriptClientRoutes } from './modules/typescript-client/routes.js';
import { TypeScriptClientService } from './modules/typescript-client/service.js';
import { customerAdmission } from './database/customer-db/admission.js';
import { randomUUID } from 'node:crypto';
import { docsRoutes } from './modules/api-docs/routes.js';
import { DocsService } from './modules/api-docs/service.js';
import type { DocsRepository } from './modules/api-docs/types.js';
import { DestinationError } from './security/customer-destination.js';
import { workflowRoutes } from './modules/workflows/routes.js';
import { WorkflowService } from './modules/workflows/service.js';
import { WorkflowEngine } from './modules/workflows/engine.js';
import type { WorkflowRepository } from './modules/workflows/types.js';
import {
  createTransactionRunner,
  type CustomerTransactionRunner,
} from './database/customer-db/transaction-runner.js';
import { projectAuthRoutes } from './modules/project-auth/routes.js';
import { AuthService } from './modules/project-auth/service.js';
import type {
  AuthRepository,
  AuthStore,
  PasswordHasher,
} from './modules/project-auth/types.js';
import { createPasswordHasher } from './modules/project-auth/passwords.js';
import {
  AuthRateLimiter,
  AuthRateLimitError,
} from './modules/project-auth/rate-limit.js';
import { createAuthStore } from './database/customer-db/auth-store.js';
import { RuntimeError } from './runtime/errors.js';
import { endpointRoutes } from './modules/endpoints/routes.js';
import { EndpointService } from './modules/endpoints/service.js';
import type { EndpointRepository } from './modules/endpoints/types.js';
import { apiKeyRoutes } from './modules/api-keys/routes.js';
import { ApiKeyService } from './modules/api-keys/service.js';
import type { ApiKeyRepository } from './modules/api-keys/types.js';
import { runtimeRoutes } from './runtime/routes.js';
import { RuntimeService } from './runtime/service.js';
import type { RuntimeExecutor, RuntimeRepository } from './runtime/types.js';
import { createRuntimeExecutor } from './database/customer-db/runtime-executor.js';
import { schemaRoutes } from './modules/schema-builder/routes.js';
import { SchemaService } from './modules/schema-builder/service.js';
import { SchemaError } from './modules/schema-builder/errors.js';
import type {
  SchemaRepository,
  SchemaExecutor,
} from './modules/schema-builder/types.js';
import { createSchemaExecutor } from './database/customer-db/schema-executor.js';
import Fastify, { LogController, type FastifyError } from 'fastify';
import type { Env } from './config/env.js';
import { projectRoutes } from './modules/projects/routes.js';
import { ProjectError, ProjectService } from './modules/projects/service.js';
import type { ProjectRepository } from './modules/projects/types.js';
import { connectionRoutes } from './modules/database-connections/routes.js';
import { ConnectionService } from './modules/database-connections/service.js';
import { ConnectionError } from './modules/database-connections/errors.js';
import type {
  ConnectionRepository,
  ConnectionTester,
} from './modules/database-connections/types.js';
import { CredentialEncryption } from './security/encryption.js';
import { createConnectionTester } from './database/customer-db/connection-test.js';
import { PlatformAuthService } from './modules/platform-auth/service.js';
import { platformAuthRoutes } from './modules/platform-auth/routes.js';
import { platformSessionAuth } from './modules/platform-auth/session.js';
import {
  PlatformAuthError,
  type PlatformAuthRepository,
} from './modules/platform-auth/types.js';
import { createPasswordHasher as createSharedPasswordHasher } from './security/passwords.js';

export function buildApp(options: {
  env: Env;
  platformAuthRepository: PlatformAuthRepository;
  projectRepository: ProjectRepository;
  logger?: boolean;
  readiness?: () => Promise<void>;
  acquireSetupLease?: (projectId: string) => Promise<() => Promise<void>>;
  runtimeAdmission?: (slug: string) => Promise<void>;
  docsRepository?: DocsRepository;
  connectionRepository?: ConnectionRepository;
  connectionTester?: ConnectionTester;
  schemaRepository?: SchemaRepository;
  schemaExecutor?: SchemaExecutor;
  endpointRepository?: EndpointRepository;
  apiKeyRepository?: ApiKeyRepository;
  runtimeRepository?: RuntimeRepository;
  runtimeExecutor?: RuntimeExecutor;
  workflowRepository?: WorkflowRepository;
  transactionRunner?: CustomerTransactionRunner;
  authRepository?: AuthRepository;
  authStore?: AuthStore;
  passwordHasher?: PasswordHasher;
  authRateLimiter?: AuthRateLimiter;
}) {
  const app = Fastify({
    genReqId: (request) => {
      const value = request.headers['x-request-id'];
      const trusted = options.env.trustedProxyIps.includes(
        request.socket.remoteAddress ?? '',
      );
      return trusted &&
        typeof value === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          value,
        )
        ? value
        : randomUUID();
    },
    trustProxy: options.env.trustedProxyIps.length
      ? options.env.trustedProxyIps
      : false,
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            // Do not serialize arbitrary requests, URLs, headers, bodies, or error objects.
            serializers: {
              req: (request) => ({ method: request.method }),
              res: (response) => ({ statusCode: response.statusCode }),
              err: () => ({
                type: 'Error',
                message: 'Request failed',
                stack: '',
              }),
            },
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers.set-cookie',
            ],
          },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
  });

  const eventId = (value: string | undefined) =>
    value &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
      ? value
      : undefined;
  const failureCategories = new WeakMap<object, string>();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  app.get('/health/live', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ status: 'alive' }),
  );
  app.get('/health/ready', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      if (!options.readiness) throw new Error('Not ready');
      await options.readiness();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    failureCategories.set(request, 'REQUEST_FAILED');
    if (
      error instanceof DestinationError ||
      error instanceof PlatformAuthError ||
      error instanceof ProjectError ||
      error instanceof ConnectionError ||
      error instanceof SchemaError ||
      error instanceof RuntimeError
    ) {
      failureCategories.set(request, error.code);
      if (error.code.includes('CAPACITY'))
        request.log.warn(
          {
            requestId: request.id,
            category: 'customer-admission',
            admission: customerAdmission.snapshot(),
          },
          'Capacity rejection',
        );
      if (
        error instanceof AuthRateLimitError ||
        (error instanceof PlatformAuthError && error.retryAfter)
      )
        reply.header('retry-after', String(error.retryAfter));
      if (error.statusCode === 401) reply.header('www-authenticate', 'Bearer');
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        requestId: request.id,
      });
    }
    if (error.validation) {
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: 'Request validation failed',
        requestId: request.id,
      });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        code: 'INVALID_REQUEST',
        message: 'Request could not be accepted',
        requestId: request.id,
      });
    }
    request.log.error({ requestId: request.id }, 'Internal request failure');
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: request.id,
    });
  });

  app.addHook('onResponse', async (request, reply) => {
    if (
      request.routeOptions.url?.startsWith('/internal/projects') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
    ) {
      const p = request.params as {
        projectId?: string;
        id?: string;
        tableId?: string;
        workflowId?: string;
        keyId?: string;
      };
      request.log.info(
        {
          timestamp: new Date().toISOString(),
          requestId: request.id,
          actorPlatformUserId: request.platformPrincipal?.userId,
          projectId: eventId(p.projectId ?? p.id),
          targetType: p.tableId
            ? 'table'
            : p.workflowId
              ? 'workflow'
              : p.keyId
                ? 'api-key'
                : request.routeOptions.url?.includes('database-connection')
                  ? 'database-connection'
                  : request.routeOptions.url?.includes('/auth')
                    ? 'application-auth'
                    : 'project',
          targetId: eventId(
            p.tableId ?? p.workflowId ?? p.keyId ?? p.projectId ?? p.id,
          ),
          action: `${request.method} ${request.routeOptions.url}`,
          outcome:
            reply.statusCode < 400
              ? 'succeeded'
              : failureCategories.get(request)?.includes('UNKNOWN')
                ? 'outcome_unknown'
                : 'failed',
          errorCode: failureCategories.get(request),
          status: reply.statusCode,
        },
        'Management event',
      );
    }
    request.log.info(
      {
        requestId: request.id,
        durationMs: reply.elapsedTime,
        platformUserId: request.platformPrincipal?.userId,
        failureCategory: failureCategories.get(request),
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
      },
      'Request completed',
    );
  });

  const transactionRunner =
    options.transactionRunner ?? createTransactionRunner();
  const encryption = new CredentialEncryption(
    options.env.connectionEncryptionKey,
  );
  const authService = options.authRepository
    ? new AuthService(
        options.authRepository,
        options.authStore ?? createAuthStore(encryption),
        options.passwordHasher ?? createPasswordHasher(),
        options.authRateLimiter ?? new AuthRateLimiter(),
      )
    : undefined;
  const platformAuth = new PlatformAuthService(
    options.platformAuthRepository,
    createSharedPasswordHasher(),
  );
  app.decorateRequest('platformPrincipal');
  app.decorateRequest('platformUser');
  app.register(platformAuthRoutes, {
    prefix: '/internal',
    service: platformAuth,
  });
  const cleanup = setInterval(
    () => {
      void platformAuth
        .cleanup()
        .catch(() => app.log.warn('Platform session cleanup failed'));
    },
    60 * 60 * 1000,
  );
  cleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(cleanup);
  });
  const projects = new ProjectService(options.projectRepository);
  app.register(
    async (internal) => {
      const leases = new WeakMap<object, () => Promise<void>>();
      internal.addHook('preValidation', async (request) => {
        const match =
          /^\/internal\/projects\/([a-f0-9-]{36})\/.*\/(?:apply|provision|credentials)$/.exec(
            request.url.split('?')[0]!,
          );
        if (match && options.acquireSetupLease)
          leases.set(request, await options.acquireSetupLease(match[1]!));
      });
      internal.addHook('preHandler', async (request) => {
        if (
          request.routeOptions.url?.startsWith('/internal/projects') &&
          !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
        ) {
          const p = request.params as {
            projectId?: string;
            tableId?: string;
            workflowId?: string;
            keyId?: string;
          };
          request.log.info(
            {
              timestamp: new Date().toISOString(),
              requestId: request.id,
              actorPlatformUserId: request.platformPrincipal?.userId,
              projectId: eventId(p.projectId),
              targetType: p.tableId
                ? 'table'
                : p.workflowId
                  ? 'workflow'
                  : p.keyId
                    ? 'api-key'
                    : request.routeOptions.url?.includes('database-connection')
                      ? 'database-connection'
                      : request.routeOptions.url?.includes('/auth')
                        ? 'application-auth'
                        : 'project',
              targetId: eventId(
                p.tableId ?? p.workflowId ?? p.keyId ?? p.projectId,
              ),
              action: `${request.method} ${request.routeOptions.url}`,
              outcome: 'started',
            },
            'Management event',
          );
        }
      });
      internal.addHook('onResponse', async (request) => {
        await leases.get(request)?.();
      });
      internal.addHook('onRequest', async (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
      });
      internal.addHook('onRequest', platformSessionAuth(platformAuth));
      if (options.docsRepository)
        await internal.register(docsRoutes, {
          service: new DocsService(
            options.docsRepository,
            options.env.publicRuntimeOrigin,
          ),
        });
      if (options.docsRepository)
        await internal.register(typeScriptClientRoutes, { service: new TypeScriptClientService(options.docsRepository) });
      if (options.workflowRepository)
        await internal.register(workflowRoutes, {
          service: new WorkflowService(options.workflowRepository),
        });
      if (authService)
        await internal.register(projectAuthRoutes, {
          service: authService,
        });
      if (options.endpointRepository)
        await internal.register(endpointRoutes, {
          service: new EndpointService(options.endpointRepository),
        });
      if (options.apiKeyRepository)
        await internal.register(apiKeyRoutes, {
          service: new ApiKeyService(options.apiKeyRepository),
        });
      await internal.register(projectRoutes, {
        service: projects,
      });
      if (options.schemaRepository && options.connectionRepository) {
        await internal.register(schemaRoutes, {
          service: new SchemaService(
            options.schemaRepository,
            options.connectionRepository,
            new CredentialEncryption(options.env.connectionEncryptionKey),
            options.schemaExecutor ??
              createSchemaExecutor(undefined, encryption),
          ),
        });
      }
      if (options.connectionRepository) {
        await internal.register(connectionRoutes, {
          service: new ConnectionService(
            projects,
            options.connectionRepository,
            new CredentialEncryption(options.env.connectionEncryptionKey),
            options.connectionTester ?? createConnectionTester(),
          ),
        });
      }
    },
    { prefix: '/internal' },
  );

  if (options.runtimeRepository)
    app.register(runtimeRoutes, {
      prefix: '/api',
      allowedOrigins: options.env.runtimeAllowedOrigins,
      ...(options.runtimeAdmission
        ? { admission: options.runtimeAdmission }
        : {}),
      ...(authService ? { auth: authService } : {}),
      ...(options.workflowRepository
        ? {
            workflows: new WorkflowEngine(
              options.workflowRepository,
              encryption,
              transactionRunner,
            ),
          }
        : {}),
      service: new RuntimeService(
        options.runtimeRepository,
        new CredentialEncryption(options.env.connectionEncryptionKey),
        options.runtimeExecutor ??
          createRuntimeExecutor(undefined, 10, transactionRunner),
        authService,
      ),
    });
  return app;
}
