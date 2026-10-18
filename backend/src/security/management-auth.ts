import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ProjectError } from '../modules/projects/service.js';

export function managementAuth(token: string) {
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return async (request: FastifyRequest) => {
    const received = createHash('sha256').update(request.headers.authorization ?? '').digest();
    if (!timingSafeEqual(expected, received)) {
      throw new ProjectError(401, 'UNAUTHORIZED', 'Valid management credentials required');
    }
  };
}
