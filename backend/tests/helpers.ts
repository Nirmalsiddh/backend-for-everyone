import { randomUUID } from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
import { ProjectError } from '../src/modules/projects/service.js';
import type {
  Project,
  ProjectRepository,
} from '../src/modules/projects/types.js';

export const ownerId = '11111111-1111-4111-8111-111111111111';
export const otherOwnerId = '22222222-2222-4222-8222-222222222222';
export const token = 'test-token-0123456789-abcdefghijklmnop';
export const auth = { authorization: `Bearer ${token}` };
export const env = loadEnv({
  CONNECTION_ENCRYPTION_KEY: '11'.repeat(32),
  NODE_ENV: 'test',
  PLATFORM_DATABASE_URL: 'postgresql://test:test@localhost/platform_test',
  MANAGEMENT_API_TOKEN: token,
  MANAGEMENT_USER_ID: ownerId,
});

export function memoryRepository(): ProjectRepository {
  const records = new Map<string, Project>();
  return {
    async listOwned(ownerId, limit, offset) {
      return [...records.values()]
        .filter((item) => item.ownerId === ownerId)
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .slice(offset, offset + limit);
    },
    async create(ownerId, input) {
      if ([...records.values()].some((item) => item.slug === input.slug)) {
        throw new ProjectError(
          409,
          'SLUG_UNAVAILABLE',
          'Project slug is unavailable',
        );
      }
      const project = {
        id: randomUUID(),
        ownerId,
        ...input,
        createdAt: new Date(),
      };
      records.set(project.id, project);
      return project;
    },
    async findOwnedById(id, ownerId) {
      const record = records.get(id);
      return record?.ownerId === ownerId ? record : undefined;
    },
  };
}
