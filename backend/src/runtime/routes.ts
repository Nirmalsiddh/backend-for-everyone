import { DestinationError } from '../security/customer-destination.js';
import type { WorkflowEngine } from '../modules/workflows/engine.js';
import type { WorkflowResult } from '../modules/workflows/types.js';
import type { AuthService } from '../modules/project-auth/service.js';
import { AuthRateLimitError } from '../modules/project-auth/rate-limit.js';
import { badRequest } from './errors.js';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import type { Operation } from '../modules/endpoints/types.js';
import { RuntimeError } from './errors.js';
import type { RuntimePrincipal } from './types.js';
import type { RuntimeService } from './service.js';
export async function runtimeRoutes(app: FastifyInstance, options: { service: RuntimeService; allowedOrigins: string[]; auth?: AuthService; workflows?: WorkflowEngine }) {
  type Context = { identity?: RuntimePrincipal; workflow?: Omit<WorkflowResult, 'body'>; action?: string; endpointId?: string; operation?: Operation; rowCount?: number; errorCode?: string };
  const contexts = new WeakMap<FastifyRequest, Context>();
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    const known = error instanceof RuntimeError || error instanceof DestinationError;
    const status = known ? error.statusCode : error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    const code = known ? error.code : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
    const context = contexts.get(req); if (context) context.errorCode = code;
    if (error instanceof AuthRateLimitError) reply.header('retry-after', String(error.retryAfter));
    if (status === 401) reply.header('www-authenticate', 'Bearer');
    return reply.code(status).send({ code, message: known ? error.message : status === 500 ? 'Internal server error' : 'Request could not be accepted', requestId: req.id });
  });
  app.addHook('onRequest', async (req, reply) => {
    contexts.set(req, {});
    reply.header('cache-control', 'no-store');
    const origin = req.headers.origin;
    if (origin && options.allowedOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
      if (req.method === 'OPTIONS') reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
        .header('access-control-allow-headers', 'Authorization, Content-Type');
    } else reply.header('vary', 'Origin');
  });
  app.addHook('onResponse', async (req, reply) => {
    const context = contexts.get(req);
    req.log.info({ requestId: req.id, route: req.routeOptions.url, method: req.method, status: reply.statusCode,
      duration: reply.elapsedTime, ...(context?.workflow ?? {}), projectId: context?.identity?.projectId, apiKeyId: context?.identity && 'keyId' in context.identity ? context.identity.keyId : undefined,
      applicationUserId: context?.identity && 'userId' in context.identity ? context.identity.userId : undefined,
      action: context?.action,
      endpointId: context?.endpointId, operation: context?.operation, rowCount: context?.rowCount, errorCode: context?.errorCode }, 'Runtime request completed');
  });
  type Params = { projectSlug: string; resource: string; id?: string };
  for (const path of ['/:projectSlug/:resource', '/:projectSlug/:resource/:id']) {
    app.options(path, async (_req, reply) => reply.code(204).send());
  }
  if (options.auth) {
    const auth = options.auth;
    for (const action of ['signup', 'login', 'logout', 'me'] as const) {
      app.route<{ Params: { projectSlug: string }; Querystring: Record<string, unknown> }>({
        method: action === 'me' ? 'GET' : 'POST', url: `/:projectSlug/auth/${action}`,
        onRequest: async (req) => { contexts.get(req)!.action = action; },
        handler: async (req, reply) => {
          if (Object.keys(req.query).length || (['logout', 'me'].includes(action) && req.body !== undefined)) throw badRequest();
          const slug = req.params.projectSlug;
          if (action === 'signup') return reply.code(201).send(await auth.signup(slug, req.body, req.ip));
          if (action === 'login') return auth.login(slug, req.body, req.ip);
          if (action === 'me') return auth.me(slug, req.headers.authorization);
          await auth.logout(slug, req.headers.authorization); return reply.code(204).send();
        },
      });
    }
  }
  const routes: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; operation: Operation }[] = [
    { method: 'GET', path: '/:projectSlug/:resource', operation: 'list' },
    { method: 'GET', path: '/:projectSlug/:resource/:id', operation: 'get' },
    { method: 'POST', path: '/:projectSlug/:resource', operation: 'create' },
    { method: 'PATCH', path: '/:projectSlug/:resource/:id', operation: 'update' },
    { method: 'DELETE', path: '/:projectSlug/:resource/:id', operation: 'delete' },
  ];
  for (const route of routes) app.route<{ Params: Params; Querystring: Record<string, unknown> }>({ method: route.method, url: route.path,
    onRequest: async (req) => {
      const context = contexts.get(req)!; context.operation = route.operation;
      context.identity = await options.service.authenticate(req.params.projectSlug, req.headers.authorization);
    },
    handler: async (req, reply) => {
      const context = contexts.get(req)!;
      if (route.operation === 'create' && options.workflows) {
        const result = await options.workflows.execute(context.identity!, req.params.resource, req.body, req.query);
        if (result) {
          const { body: responseBody, ...metadata } = result; context.workflow = metadata;
          if (result.status === 204) return reply.code(204).send();
          return reply.code(result.status).type('application/json').send(JSON.stringify(responseBody));
        }
      }
      const result = await options.service.execute(context.identity!, req.params.resource, route.operation, req.params.id, req.body, req.query,
        (endpointId) => { context.endpointId = endpointId; });
      context.rowCount = result.rowCount;
      if (route.operation === 'delete') return reply.code(204).send();
      if (route.operation === 'create') {
        const row = result.body as Record<string, unknown>;
        reply.code(201).header('location', `/api/${encodeURIComponent(req.params.projectSlug)}/${encodeURIComponent(req.params.resource)}/${String(row.id)}`);
      }
      return reply.send(result.body);
    },
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Resource not found', requestId: req.id }));
}
