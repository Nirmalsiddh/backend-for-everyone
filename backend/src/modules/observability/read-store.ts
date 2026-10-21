import type pg from 'pg';

// Owner dashboard reads use the existing management pool, never the writer pool.
// These limits apply only to observability reads; runtime and write budgets stay fixed.
export class ObservabilityReadStore {
  constructor(private readonly pool: pg.Pool) {}
  async query(text: string, values: unknown[] = []) {
    let abandoned = false;
    let acquisitionTimer: NodeJS.Timeout | undefined;
    const acquiring = this.pool.connect().then((client) => {
      if (abandoned) { client.release(); throw new Error('Observability unavailable'); }
      return client;
    });
    const client = await Promise.race([
      acquiring,
      new Promise<never>((_, reject) => {
        acquisitionTimer = setTimeout(() => {
          abandoned = true;
          reject(new Error('Observability unavailable'));
        }, 250);
      }),
    ]).catch(() => { throw new Error('Observability unavailable'); })
      .finally(() => { clearTimeout(acquisitionTimer); });
    let expired = false;
    const onError = () => {}; // Checked-out pg clients can emit errors independently.
    client.on('error', onError);
    const timer = setTimeout(() => { expired = true; client.release(true); }, 1250);
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '1000ms'");
      await client.query("SET LOCAL lock_timeout = '100ms'");
      const result = await client.query(text, values);
      await client.query('COMMIT');
      return result;
    } catch {
      if (!expired) await client.query('ROLLBACK').catch(() => {});
      throw new Error('Observability unavailable');
    } finally {
      clearTimeout(timer);
      if (!expired) { client.removeListener('error', onError); client.release(); }
    }
  }
}
