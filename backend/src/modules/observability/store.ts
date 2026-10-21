import pg from 'pg';
import type { RequestEvent } from './events.js';
export class TelemetryStore {
  readonly pool: pg.Pool;
  constructor(connectionString: string, onError: () => void) {
    this.pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 100,
      idleTimeoutMillis: 30_000, statement_timeout: 200, lock_timeout: 50,
      query_timeout: 400, application_name: 'platform-observability' });
    // pg emits client errors while checked out as well as pool errors while idle.
    this.pool.on('connect', (client) => { client.on('error', () => {}); });
    this.pool.on('error', () => { try { onError(); } catch { /* Diagnostic only. */ } });
  }
  async query(text: string, values: unknown[] = []) {
    const client = await this.pool.connect().catch(() => { throw new Error('Observability unavailable'); });
    let expired = false;
    // Destroy the connection at the absolute deadline, cancelling server work.
    const timer = setTimeout(() => { expired = true; client.release(true); }, 400);
    try { return await client.query(text, values); }
    catch { throw new Error('Observability unavailable'); }
    finally { clearTimeout(timer); if (!expired) client.release(); }
  }
  async insert(events: readonly Readonly<RequestEvent>[]) {
    const values: unknown[] = [];
    const rows = events.map((e) => {
      const offset = values.length;
      values.push(e.id, e.projectId, e.requestId, e.completedAt, e.eventVersion, e.routeCategory,
        e.operation, e.resource, e.method, e.status, e.errorCode, e.durationUs, e.responseBytes, e.principalKind);
      return `(${Array.from({ length: 14 }, (_, i) => `$${offset + i + 1}`).join(',')})`;
    });
    if (rows.length) await this.query(`INSERT INTO runtime_request_events
      (id,project_id,request_id,completed_at,event_version,route_category,operation,resource,method,status,error_code,duration_us,response_bytes,principal_kind)
      VALUES ${rows.join(',')}`, values);
  }
  async cleanup() {
    // Transaction-scoped lock is automatically released even on cancellation.
    const client = await this.pool.connect().catch(() => { throw new Error('Observability unavailable'); });
    let expired = false;
    const timer = setTimeout(() => { expired = true; client.release(true); }, 400);
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(783190246) AS acquired');
      let deleted = 0;
      if (lock.rows[0]?.acquired) deleted = (await client.query(`DELETE FROM runtime_request_events WHERE id IN (
        SELECT id FROM runtime_request_events WHERE completed_at < now() - interval '7 days'
        ORDER BY completed_at,id LIMIT 1000)`)).rowCount ?? 0;
      await client.query('COMMIT');
      return deleted;
    } catch { if (!expired) await client.query('ROLLBACK').catch(() => {}); throw new Error('Observability cleanup failed'); }
    finally { clearTimeout(timer); if (!expired) client.release(); }
  }
  close() { return this.pool.end(); }
}
