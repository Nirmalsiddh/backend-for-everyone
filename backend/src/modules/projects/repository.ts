import { enforceQuota } from '../../operations/quotas.js';
import { and, asc, eq } from 'drizzle-orm';
import type { PlatformDatabase } from '../../database/platform-db/client.js';
import { projects } from '../../database/platform-db/schema.js';
import { ProjectError } from './service.js';
import type { CreateProjectInput, ProjectRepository } from './types.js';

function postgresCode(error: unknown): string | undefined {
  // Drizzle wraps driver errors; inspect only the code and never expose query details.
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if (
    'cause' in error &&
    error.cause &&
    typeof error.cause === 'object' &&
    'code' in error.cause
  ) {
    return String(error.cause.code);
  }
  return undefined;
}

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly db: PlatformDatabase) {}

  async listOwned(ownerId: string, limit: number, offset: number) {
    return this.db
      .select({
        id: projects.id,
        ownerId: projects.ownerId,
        name: projects.name,
        slug: projects.slug,
        runtimeState: projects.runtimeState,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(eq(projects.ownerId, ownerId))
      .orderBy(asc(projects.createdAt), asc(projects.id))
      .limit(limit)
      .offset(offset);
  }

  async create(ownerId: string, input: CreateProjectInput) {
    try {
      return await this.db.transaction(async (tx) => {
        await enforceQuota(tx, 'projects', ownerId);
        const [project] = await tx
          .insert(projects)
          .values({ ownerId, ...input })
          .returning();
        if (!project) throw new Error('Insert returned no project');
        return project;
      });
    } catch (error) {
      if (postgresCode(error) === '23505') {
        throw new ProjectError(
          409,
          'SLUG_UNAVAILABLE',
          'Project slug is unavailable',
        );
      }
      if (postgresCode(error) === '23503') {
        throw new ProjectError(
          403,
          'OWNER_UNAVAILABLE',
          'Platform user is unavailable',
        );
      }
      throw error;
    }
  }

  async findOwnedById(id: string, ownerId: string) {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)))
      .limit(1);
    return project;
  }
}
