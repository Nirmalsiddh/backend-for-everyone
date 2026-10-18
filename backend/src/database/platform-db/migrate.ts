import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { parseDatabaseUrl } from '../../config/env.js';
import { createPlatformDatabase } from './client.js';

const { db, pool } = createPlatformDatabase(
  parseDatabaseUrl(process.env.PLATFORM_DATABASE_URL, 'PLATFORM_DATABASE_URL'),
);
try {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)) });
  console.info('Platform migrations applied');
} catch {
  console.error('Platform migration failed; verify database access and migration state.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
