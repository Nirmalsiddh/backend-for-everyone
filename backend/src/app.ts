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
import { managementAuth } from './security/management-auth.js';

export function buildApp(options: {
  env: Env;
  projectRepository: ProjectRepository;
  logger?: boolean;
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
            redact: ['req.headers.authorization', 'req.headers.cookie'],
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

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
  });

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (
      error instanceof ProjectError ||
      error instanceof ConnectionError ||
      error instanceof SchemaError ||
      error instanceof RuntimeError
    ) {
      if (error instanceof AuthRateLimitError)
        reply.header('retry-after', String(error.retryAfter));
      if (error.statusCode === 401) reply.header('www-authenticate', 'Bearer');
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    }
    if (error.validation) {
      return reply
        .code(400)
        .send({
          code: 'INVALID_REQUEST',
          message: 'Request validation failed',
        });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send({
          code: 'INVALID_REQUEST',
          message: 'Request could not be accepted',
        });
    }
    request.log.error({ requestId: request.id }, 'Internal request failure');
    return reply
      .code(500)
      .send({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
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
  const projects = new ProjectService(options.projectRepository);
  app.register(
    async (internal) => {
      internal.addHook(
        'onRequest',
        managementAuth(options.env.managementToken),
      );
      if (options.workflowRepository)
        await internal.register(workflowRoutes, {
          service: new WorkflowService(options.workflowRepository),
          ownerId: options.env.managementUserId,
        });
      if (authService)
        await internal.register(projectAuthRoutes, {
          service: authService,
          ownerId: options.env.managementUserId,
        });
      if (options.endpointRepository)
        await internal.register(endpointRoutes, {
          service: new EndpointService(options.endpointRepository),
          ownerId: options.env.managementUserId,
        });
      if (options.apiKeyRepository)
        await internal.register(apiKeyRoutes, {
          service: new ApiKeyService(options.apiKeyRepository),
          ownerId: options.env.managementUserId,
        });
      await internal.register(projectRoutes, {
        service: projects,
        ownerId: options.env.managementUserId,
      });
      if (options.schemaRepository && options.connectionRepository) {
        await internal.register(schemaRoutes, {
          ownerId: options.env.managementUserId,
          service: new SchemaService(
            options.schemaRepository,
            options.connectionRepository,
            new CredentialEncryption(options.env.connectionEncryptionKey),
            options.schemaExecutor ?? createSchemaExecutor(),
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
          ownerId: options.env.managementUserId,
        });
      }
    },
    { prefix: '/internal' },
  );

  if (options.runtimeRepository)
    app.register(runtimeRoutes, {
      prefix: '/api',
      allowedOrigins: options.env.runtimeAllowedOrigins,
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
