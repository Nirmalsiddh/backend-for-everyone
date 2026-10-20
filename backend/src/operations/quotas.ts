import { sql } from 'drizzle-orm';
import type { PlatformTransaction } from '../database/platform-db/resource-reservation.js';
import { RuntimeError } from '../runtime/errors.js';
const limits = {
  projects: 3,
  schema_tables: 20,
  api_keys: 10,
  workflow_endpoints: 10,
} as const;
export async function enforceQuota(
  tx: PlatformTransaction,
  resource: keyof typeof limits,
  id: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${resource}:${id}`}, 714))`,
  );
  // Identifiers are selected exclusively from this developer-authored map.
  const table = sql.identifier(resource),
    column = sql.identifier(
      resource === 'projects' ? 'owner_id' : 'project_id',
    );
  const active = resource === 'api_keys' ? sql`AND revoked_at IS NULL` : sql``;
  const result = await tx.execute(
    sql`SELECT count(*)::int AS count FROM ${table} WHERE ${column} = ${id}::uuid ${active}`,
  );
  if (Number(result.rows[0]?.count) >= limits[resource])
    throw new RuntimeError(
      409,
      'ALPHA_LIMIT_REACHED',
      `Private alpha limit reached: ${limits[resource]} ${resource.replaceAll('_', ' ')}`,
    );
}
