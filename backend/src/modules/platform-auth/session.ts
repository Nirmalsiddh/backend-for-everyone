import type { FastifyRequest } from 'fastify';
import type { PlatformAuthService } from './service.js';
import type { PlatformPrincipal, PlatformUserDto } from './types.js';
declare module 'fastify' {
  interface FastifyRequest { platformPrincipal: PlatformPrincipal; platformUser: PlatformUserDto }
}
export function platformSessionAuth(service: PlatformAuthService) {
  return async (request: FastifyRequest) => {
    const { principal, user } = await service.authenticate(request.headers.authorization);
    request.platformPrincipal = principal;
    request.platformUser = user;
  };
}
