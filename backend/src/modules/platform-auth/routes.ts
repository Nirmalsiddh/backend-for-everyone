import type { FastifyInstance } from 'fastify';
import type { PlatformAuthService } from './service.js';
import { platformSessionAuth } from './session.js';
const user = { type: 'object', additionalProperties: false, required: ['id', 'email'], properties: { id: { type: 'string' }, email: { type: 'string' } } } as const;
const credentials = { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: {
  email: { type: 'string', minLength: 1, maxLength: 300 }, password: { type: 'string', minLength: 1, maxLength: 256 },
} } as const;
export async function platformAuthRoutes(app: FastifyInstance, options: { service: PlatformAuthService }) {
  const service = options.service;
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.post<{ Body: { email: string; password: string } }>('/auth/signup', { schema: { body: credentials, response: { 202: {
    type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } },
  } } } }, async (request, reply) => reply.code(202).send(await service.signup(request.body, request.ip)));
  app.post<{ Body: { email: string; password: string } }>('/auth/login', { schema: { body: credentials, response: { 200: {
    type: 'object', additionalProperties: false, required: ['user', 'sessionToken'], properties: { user, sessionToken: { type: 'string' } },
  } } } }, (request) => service.login(request.body, request.ip));
  app.get('/auth/me', { onRequest: platformSessionAuth(service), schema: { response: { 200: user } } }, (request) => request.platformUser);
  app.post('/auth/logout', { onRequest: platformSessionAuth(service) }, async (request, reply) => {
    await service.logout(request.platformPrincipal.sessionId);
    return reply.code(204).send();
  });
}
