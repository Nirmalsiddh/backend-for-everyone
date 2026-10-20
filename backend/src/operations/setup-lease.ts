import pg from 'pg';
import { RuntimeError } from '../runtime/errors.js';
export function setupLeases(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
    query_timeout: 1500,
    application_name: 'platform-setup-leases',
  });
  pool.on('error', () => {});
  return {
    async acquire(projectId: string) {
      const client = await pool.connect();
      let lost = false;
      const onError = () => {
        lost = true;
      };
      client.on('error', onError);
      const releaseClient = () => {
        client.removeListener('error', onError);
        client.release(
          lost ? new Error('Setup lease connection unavailable') : undefined,
        );
      };
      try {
        const result = await client.query(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 713)) AS acquired',
          [projectId],
        );
        if (!result.rows[0]?.acquired)
          throw new RuntimeError(
            409,
            'SETUP_BUSY',
            'Another setup or recovery operation is in progress; refresh saved status',
          );
      } catch (error) {
        releaseClient();
        throw error;
      }
      return async () => {
        try {
          if (!lost)
            await client.query(
              'SELECT pg_advisory_unlock(hashtextextended($1, 713))',
              [projectId],
            );
        } finally {
          releaseClient();
        }
      };
    },
    close: () => pool.end(),
  };
}
