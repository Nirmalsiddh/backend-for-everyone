import type pg from 'pg';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { parseDatabaseUrl } from '../../config/env.js';
import { createPlatformDatabase } from './client.js';

const { db, pool } = createPlatformDatabase(
  parseDatabaseUrl(process.env.PLATFORM_DATABASE_URL, 'PLATFORM_DATABASE_URL'),
);
let lock: pg.PoolClient | undefined;
try {
  lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock(783190245)");
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)) });
  if (process.env.PROVISION_ALPHA_ROLES === '1') {
    await pool.query('GRANT USAGE ON SCHEMA drizzle TO platform_app');
    await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO platform_app');
    await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app');
    await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_app');
  }
  console.info('Platform migrations applied');
} catch {
  console.error('Platform migration failed; verify database access and migration state.');
  process.exitCode = 1;
} finally {
  await lock?.query("SELECT pg_advisory_unlock(783190245)").catch(() => {});
  lock?.release();
  await pool.end();
}
