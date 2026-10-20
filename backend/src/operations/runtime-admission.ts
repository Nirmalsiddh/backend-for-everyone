import { eq } from 'drizzle-orm';
import type { PlatformDatabase } from '../database/platform-db/client.js';
import { projects } from '../database/platform-db/schema.js';
import { RuntimeError } from '../runtime/errors.js';
export class RuntimeLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(
    private readonly now = Date.now,
    private readonly perSecond = 5,
    private readonly burst = 20,
  ) {}
  check(id: string) {
    const now = this.now();
    if (this.buckets.size >= 10000)
      for (const [key, bucket] of this.buckets)
        if (now - bucket.updated > 60000) this.buckets.delete(key);
    const previous = this.buckets.get(id);
    if (!previous && this.buckets.size >= 10000)
      throw new RuntimeError(
        503,
        'RUNTIME_CAPACITY_EXHAUSTED',
        'Runtime capacity is busy',
      );
    const tokens = previous
      ? Math.min(
          this.burst,
          previous.tokens + ((now - previous.updated) * this.perSecond) / 1000,
        )
      : this.burst;
    if (tokens < 1)
      throw new RuntimeError(
        429,
        'RUNTIME_RATE_LIMITED',
        'Runtime request limit reached; wait approximately one second',
      );
    this.buckets.set(id, { tokens: tokens - 1, updated: now });
  }
}
export function runtimeAdmission(db: PlatformDatabase) {
  const limiter = new RuntimeLimiter();
  return async (slug: string) => {
    const [project] = await db
      .select({ id: projects.id, runtimeState: projects.runtimeState })
      .from(projects)
      .where(eq(projects.slug, slug))
      .limit(1);
    if (!project) return;
    if (project.runtimeState !== 'active')
      throw new RuntimeError(
        503,
        'PROJECT_SUSPENDED',
        'Project runtime is suspended; contact the project owner',
      );
    limiter.check(project.id);
  };
}
