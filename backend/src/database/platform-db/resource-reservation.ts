import { and, eq, sql } from 'drizzle-orm';
import type { PlatformDatabase } from './client.js';
import { projects } from './schema.js';
import { missing } from '../../modules/schema-builder/errors.js';
export type PlatformTransaction = Parameters<Parameters<PlatformDatabase['transaction']>[0]>[0];
// Shared transaction-scoped namespace lock; avoids inverting customer-connection/FK row locks.
export async function lockProjectResource(tx: PlatformTransaction, projectId: string, ownerId: string) {
  await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${projectId}::uuid::text, 0))`);
  const [project] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId))).for('key share');
  if (!project) throw missing(); return project.id;
}
