import { buildEvent, type EventContext, type EventSink } from '../modules/observability/events.js';
import { invalidInclude, parseInclude } from './include.js';
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
export async function runtimeRoutes(
  app: FastifyInstance,
  options: {
    service: RuntimeService;
    allowedOrigins: string[];
    admission?: (slug: string, resolved?: (projectId: string) => void) => Promise<void>;
    telemetry?: EventSink;
    auth?: AuthService;
    workflows?: WorkflowEngine;
  },
) {
  type Context = {
    identity?: RuntimePrincipal;
    workflow?: Omit<WorkflowResult, 'body'>;
    action?: string;
    endpointId?: string;
    operation?: Operation;
    rowCount?: number;
    errorCode?: string;
  };
  const contexts = new WeakMap<FastifyRequest, Context>();
  const events = new WeakMap<FastifyRequest, EventContext>();
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    const known =
      error instanceof RuntimeError || error instanceof DestinationError;
    const status = known
      ? error.statusCode
      : error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    const code = known
      ? error.code
      : status === 500
        ? 'INTERNAL_ERROR'
        : 'INVALID_REQUEST';
    const context = contexts.get(req);
    if (context) context.errorCode = code;
    const event = events.get(req);
    if (event) event.errorCode = code;
    if (status === 429) reply.header('retry-after', '1');
    if (error instanceof AuthRateLimitError)
      reply.header('retry-after', String(error.retryAfter));
    if (status === 401) reply.header('www-authenticate', 'Bearer');
    return reply
      .code(status)
      .send({
        code,
        message: known
          ? error.message
          : status === 500
            ? 'Internal server error'
            : 'Request could not be accepted',
        requestId: req.id,
      });
  });
  app.addHook('onRequest', async (req, reply) => {
    contexts.set(req, {});
    events.set(req, { started: process.hrtime.bigint(), recorded: false, category: 'unresolved', operation: null, resource: null, principal: 'anonymous', errorCode: null, responseBytes: null });
    const event = events.get(req)!;
    const template = req.routeOptions.url ?? '';
    const authAction = /\/auth\/(signup|login|me|logout)$/.exec(template)?.[1];
    if (authAction) { event.category = 'auth'; event.operation = `auth.${authAction}` as EventContext['operation']; }
    else if (template.endsWith('/:resource') || template.endsWith('/:resource/:id')) {
      const operation = ['GET','HEAD'].includes(req.method) ? template.endsWith('/:id') ? 'get' : 'list' : req.method === 'POST' ? 'create' : req.method === 'PATCH' ? 'update' : req.method === 'DELETE' ? 'delete' : null;
      if (operation && !(operation === 'create' && options.workflows)) { event.category = 'crud'; event.operation = `crud.${operation}`; }
    }
    const includeKeys = [...new URL(req.raw.url ?? '/', 'http://runtime').searchParams.keys()]
      .filter((key) => key === 'include' || /^include[.\[\]]/.test(key));
    if (includeKeys.length) {
      if (req.method !== 'GET' || /\/auth\//.test(req.url) || includeKeys.length !== 1 || includeKeys[0] !== 'include') throw invalidInclude();
      parseInclude({ include: new URL(req.raw.url!, 'http://runtime').searchParams.get('include') });
    }
    reply.header('cache-control', 'no-store');
    const origin = req.headers.origin;
    if (origin && options.allowedOrigins.includes(origin)) {
      reply
        .header('access-control-allow-origin', origin)
        .header('vary', 'Origin')
        .header(
          'access-control-expose-headers',
          'X-Request-Id, Retry-After, Location',
        );
      if (req.method === 'OPTIONS')
        reply
          .header(
            'access-control-allow-methods',
            'GET, POST, PATCH, DELETE, OPTIONS',
          )
          .header(
            'access-control-allow-headers',
            'Authorization, Content-Type',
          );
    } else reply.header('vary', 'Origin');
  });
  app.addHook('onResponse', async (req, reply) => {
    const context = contexts.get(req);
    const eventContext = events.get(req);
    if (eventContext && options.telemetry) {
      try {
        const event = buildEvent(eventContext, req.id, req.method, reply.statusCode);
        if (event) options.telemetry.enqueue(event);
      } catch { /* Telemetry cannot replace a runtime result. */ }
    }
    req.log.info(
      {
        requestId: req.id,
        route: req.routeOptions.url,
        method: req.method,
        status: reply.statusCode,
        duration: reply.elapsedTime,
        ...(context?.workflow ?? {}),
        projectId: context?.identity?.projectId,
        apiKeyId:
          context?.identity && 'keyId' in context.identity
            ? context.identity.keyId
            : undefined,
        applicationUserId:
          context?.identity && 'userId' in context.identity
            ? context.identity.userId
            : undefined,
        action: context?.action,
        endpointId: context?.endpointId,
        operation: context?.operation,
        rowCount: context?.rowCount,
        errorCode: context?.errorCode,
      },
      'Runtime request completed',
    );
  });
  app.addHook('onRequest', async (req) => {
    if (req.method !== 'OPTIONS') {
      const slug = (req.params as { projectSlug?: string }).projectSlug;
      if (slug) await options.admission?.(slug, (projectId) => { events.get(req)!.projectId = projectId; });
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const event = events.get(req);
    if (event) event.responseBytes = req.method === 'HEAD' || [204,304].includes(reply.statusCode) ? 0 : typeof payload === 'string' ? Buffer.byteLength(payload) : Buffer.isBuffer(payload) ? payload.length : null;
    return payload;
  });
  app.addHook('preSerialization', async (_req, _reply, payload) => {
    if (
      Buffer.byteLength(
        typeof payload === 'string' ? payload : (JSON.stringify(payload) ?? ''),
      ) > 1048576
    )
      throw new RuntimeError(
        422,
        'RESPONSE_TOO_LARGE',
        'Response exceeds 1 MiB; request fewer records or smaller results',
      );
    return payload;
  });
  type Params = { projectSlug: string; resource: string; id?: string };
  for (const path of [
    '/:projectSlug/:resource',
    '/:projectSlug/:resource/:id',
  ]) {
    app.options(path, async (_req, reply) => reply.code(204).send());
  }
  if (options.auth) {
    const auth = options.auth;
    for (const action of ['signup', 'login', 'logout', 'me'] as const) {
      app.route<{
        Params: { projectSlug: string };
        Querystring: Record<string, unknown>;
      }>({
        method: action === 'me' ? 'GET' : 'POST',
        url: `/:projectSlug/auth/${action}`,
        onRequest: async (req) => {
          contexts.get(req)!.action = action;
          const event = events.get(req)!; event.category = 'auth'; event.operation = `auth.${action}`;
        },
        handler: async (req, reply) => {
          if (
            Object.keys(req.query).length ||
            (['logout', 'me'].includes(action) && req.body !== undefined)
          )
            throw badRequest();
          const slug = req.params.projectSlug;
          if (action === 'signup')
            return reply
              .code(201)
              .send(await auth.signup(slug, req.body, req.ip));
          if (action === 'login') return auth.login(slug, req.body, req.ip);
          if (action === 'me') {
            const result = await auth.me(slug, req.headers.authorization);
            events.get(req)!.principal = 'app_user';
            return result;
          }
          await auth.logout(slug, req.headers.authorization);
          return reply.code(204).send();
        },
      });
    }
  }
  const routes: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    operation: Operation;
  }[] = [
    { method: 'GET', path: '/:projectSlug/:resource', operation: 'list' },
    { method: 'GET', path: '/:projectSlug/:resource/:id', operation: 'get' },
    { method: 'POST', path: '/:projectSlug/:resource', operation: 'create' },
    {
      method: 'PATCH',
      path: '/:projectSlug/:resource/:id',
      operation: 'update',
    },
    {
      method: 'DELETE',
      path: '/:projectSlug/:resource/:id',
      operation: 'delete',
    },
  ];
  for (const route of routes)
    app.route<{ Params: Params; Querystring: Record<string, unknown> }>({
      method: route.method,
      url: route.path,
      onRequest: async (req) => {
        const context = contexts.get(req)!;
        context.operation = route.operation;
        const event = events.get(req)!;
        if (!(route.operation === 'create' && options.workflows)) { event.category = 'crud'; event.operation = `crud.${route.operation}`; }
        context.identity = await options.service.authenticate(
          req.params.projectSlug,
          req.headers.authorization,
        );
        event.projectId = context.identity.projectId;
        event.principal = 'kind' in context.identity && context.identity.kind === 'user' ? 'app_user' : 'project_key';
      },
      handler: async (req, reply) => {
        const context = contexts.get(req)!;
        if (route.operation === 'create' && options.workflows) {
          const result = await options.workflows.execute(
            context.identity!,
            req.params.resource,
            req.body,
            req.query,
            (resource) => { const event = events.get(req)!; event.category = 'workflow'; event.operation = 'workflow.execute'; event.resource = resource; },
          );
          if (result) {
            const { body: responseBody, ...metadata } = result;
            context.workflow = metadata;
            if (result.status === 204) return reply.code(204).send();
            return reply
              .code(result.status)
              .type('application/json')
              .send(JSON.stringify(responseBody));
          }
        }
        const event = events.get(req)!;
        event.category = 'crud'; event.operation = `crud.${route.operation}`;
        const result = await options.service.execute(
          context.identity!,
          req.params.resource,
          route.operation,
          req.params.id,
          req.body,
          req.query,
          (endpointId, resource) => {
            events.get(req)!.resource = resource;
            context.endpointId = endpointId;
          },
        );
        context.rowCount = result.rowCount;
        if (route.operation === 'delete') return reply.code(204).send();
        if (route.operation === 'create') {
          const row = result.body as Record<string, unknown>;
          reply
            .code(201)
            .header(
              'location',
              `/api/${encodeURIComponent(req.params.projectSlug)}/${encodeURIComponent(req.params.resource)}/${String(row.id)}`,
            );
        }
        return reply.send(result.body);
      },
    });
  app.setNotFoundHandler((req, reply) => {
    if (Object.keys(req.query as Record<string, unknown>).some((key) => key === 'include' || /^include[.\[\]]/.test(key))) throw invalidInclude();
    const event = events.get(req);
    if (event) event.errorCode = 'NOT_FOUND';
    return reply
      .code(404)
      .send({
        code: 'NOT_FOUND',
        message: 'Resource not found',
        requestId: req.id,
      });
  });
}
