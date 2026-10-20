import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function createPlatformDatabase(
  connectionString: string,
  applicationName = 'platform-management',
) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
    application_name: applicationName,
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export type PlatformDatabase = ReturnType<typeof createPlatformDatabase>['db'];
