import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { fileURLToPath } from 'node:url';
export function createReadiness(databaseUrl: string) {
  const expected = readMigrationFiles({
    migrationsFolder: fileURLToPath(
      new URL('../../../migrations', import.meta.url),
    ),
  }).map((m) => m.hash);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
    query_timeout: 1500,
  });
  pool.on('error', () => {});
  return {
    async check() {
      const result = await pool.query(
        'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id',
      );
      if (
        result.rows.length !== expected.length ||
        result.rows.some((r, i) => r.hash !== expected[i])
      )
        throw new Error('Not ready');
      await pool.query('SELECT runtime_state FROM projects LIMIT 0');
      await pool.query('SELECT revision FROM database_connections LIMIT 0');
      await pool.query('SELECT relationship FROM schema_fields LIMIT 0');
      await pool.query('SELECT plan_context FROM schema_migrations LIMIT 0');
      // Verify the minimum auth schema exists as well as the migration marker.
      await pool.query(
        'SELECT u.id, u.password_hash, u.status, u.updated_at, s.token_hash, s.expires_at FROM users u LEFT JOIN platform_sessions s ON false LIMIT 0',
      );
    },
    close: () => pool.end(),
  };
}
