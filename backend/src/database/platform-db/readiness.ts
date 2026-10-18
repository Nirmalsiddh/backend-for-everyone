import pg from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { fileURLToPath } from 'node:url';
export function createReadiness(databaseUrl: string) {
  const expected = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)) }).at(-1)!.hash;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1000, statement_timeout: 1000, query_timeout: 1500 });
  pool.on('error', () => {});
  return {
    async check() {
      const result = await pool.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1');
      if (result.rows[0]?.hash !== expected) throw new Error('Not ready');
      // Verify the minimum auth schema exists as well as the migration marker.
      await pool.query('SELECT u.id, u.password_hash, u.status, u.updated_at, s.token_hash, s.expires_at FROM users u LEFT JOIN platform_sessions s ON false LIMIT 0');
    },
    close: () => pool.end(),
  };
}
