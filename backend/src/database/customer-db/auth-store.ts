import pg from 'pg';
import { CredentialEncryption } from '../../security/encryption.js';
import type { ConnectionConfig } from '../../modules/database-connections/types.js';
import type { AuthContext, AuthStore, LoginUser, Role, SafeUser, SessionGuard } from '../../modules/project-auth/types.js';
import { canonical, quoteIdentifier as q } from '../../modules/schema-builder/plan.js';
import { validateTargetSchema } from '../../modules/schema-builder/validation.js';
import { RuntimeError, unauthorized, unavailable, notFound } from '../../runtime/errors.js';
import { catalog } from './catalog.js';
import type { SchemaClient } from './schema-executor.js';
export function authTables(context: AuthContext, schema: string) {
  validateTargetSchema(schema);
  const suffix = context.config.projectId.replaceAll('-', '');
  if (context.config.authUsersTableName !== `platform_auth_users_${suffix}` || context.config.authSessionsTableName !== `platform_auth_sessions_${suffix}`) throw unavailable();
  return { users: `${q(schema)}.${q(context.config.authUsersTableName)}`, sessions: `${q(schema)}.${q(context.config.authSessionsTableName)}` };
}
export async function checkAuthCatalog(client: SchemaClient, context: AuthContext, schema: string) {
  const tables = authTables(context, schema);
  await client.query(`LOCK TABLE ONLY ${tables.users}, ONLY ${tables.sessions} IN ACCESS SHARE MODE`);
  const snapshot = { users: await catalog(client, schema, context.config.authUsersTableName), sessions: await catalog(client, schema, context.config.authSessionsTableName) };
  if (canonical(snapshot) !== canonical(context.config.catalog)) throw unavailable();
  return tables;
}
function safeUser(row: Record<string, unknown>): SafeUser {
  if (typeof row.id !== 'string' || typeof row.email !== 'string' || !['user', 'admin'].includes(String(row.role))) throw unavailable();
  return { id: row.id, email: row.email, role: row.role as Role };
}
export async function sessionOnClient(client: SchemaClient, context: AuthContext, schema: string, tokenHash: string) {
  const tables = await checkAuthCatalog(client, context, schema);
  const [session] = (await client.query(`SELECT id, user_id FROM ${tables.sessions} WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP FOR SHARE`, [tokenHash])).rows;
  if (!session) throw unauthorized();
  const [row] = (await client.query(`SELECT id, email, role, status FROM ${tables.users} WHERE id = $1::uuid FOR SHARE`, [session.user_id])).rows;
  if (!row || row.status !== 'active') throw unauthorized();
  return { user: safeUser(row), sessionId: String(session.id) };
}
export async function verifySessionGuard(client: SchemaClient, schema: string, guard: SessionGuard) {
  const current = await sessionOnClient(client, guard.context, schema, guard.tokenHash);
  if (current.user.id !== guard.userId || current.user.role !== guard.role) throw unauthorized();
}
export function createAuthStore(encryption: CredentialEncryption,
  factory: (options: pg.ClientConfig) => SchemaClient = (options) => new pg.Client(options), capacity = 10): AuthStore {
  let active = 0;
  async function run<T>(context: AuthContext, provision: boolean, work: (client: SchemaClient, tables: { users: string; sessions: string }, schema: string) => Promise<T>): Promise<T> {
    if (active >= capacity) throw new RuntimeError(503, 'AUTH_CAPACITY_EXHAUSTED', 'Authentication capacity exhausted');
    active++;
    let client: SchemaClient | undefined; let transaction = false; let committing = false;
    try {
      const connection = context.connection;
      const config = encryption.decrypt<ConnectionConfig>(connection, `${connection.projectId}:${connection.id}`);
      client = factory({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 5000, statement_timeout: 3000, query_timeout: 4000, application_name: 'platform-auth' });
      client.on('error', () => {}); await client.connect(); await client.query('BEGIN'); transaction = true;
      await client.query('SET LOCAL search_path = pg_catalog'); await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
      const tables = provision ? authTables(context, config.schema) : await checkAuthCatalog(client, context, config.schema);
      const result = await work(client, tables, config.schema);
      committing = true; await client.query('COMMIT'); transaction = false; return result;
    } catch (error) {
      if (committing) throw new RuntimeError(503, 'AUTH_OUTCOME_UNKNOWN', 'Authentication operation outcome could not be confirmed');
      if (transaction && client) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof RuntimeError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === '23505') throw new RuntimeError(409, 'ACCOUNT_CREATION_FAILED', 'Unable to create account');
      throw unavailable();
    } finally { try { if (client) await client.end().catch(() => {}); } finally { active--; } }
  }
  return {
    provision(context) {
      return run(context, true, async (client, tables, schema) => {
        // No IF NOT EXISTS: an existing object is never adopted.
        await client.query(`CREATE TABLE ${tables.users} (
          id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), email text NOT NULL UNIQUE,
          password_hash text NOT NULL, role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
          status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254))`);
        await client.query(`CREATE TABLE ${tables.sessions} (
          id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), user_id uuid NOT NULL REFERENCES ${tables.users}(id) ON DELETE CASCADE,
          token_hash varchar(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at timestamptz NOT NULL, revoked_at timestamptz)`);
        // UNIQUE constraints already index normalized email and token_hash.
        await client.query(`CREATE INDEX ${q(`auth_session_user_${context.config.projectId.replaceAll('-', '')}`)} ON ${tables.sessions} (user_id)`);
        return { users: await catalog(client, schema, context.config.authUsersTableName), sessions: await catalog(client, schema, context.config.authSessionsTableName) };
      });
    },
    signup(context, email, hash) {
      return run(context, false, async (client, tables) => {
        const [row] = (await client.query(`INSERT INTO ${tables.users} (email, password_hash, role, status) VALUES ($1, $2, 'user', 'active') RETURNING id, email, role`, [email, hash])).rows;
        if (!row) throw unavailable(); return safeUser(row);
      });
    },
    findUser(context, email) {
      return run(context, false, async (client, tables) => {
        const [row] = (await client.query(`SELECT id, email, role, status, password_hash FROM ${tables.users} WHERE email = $1`, [email])).rows;
        return row ? { ...safeUser(row), passwordHash: String(row.password_hash), status: String(row.status) } : undefined;
      });
    },
    login(context, user: LoginUser, tokenHash) {
      return run(context, false, async (client, tables) => {
        const [row] = (await client.query(`SELECT id FROM ${tables.users} WHERE id = $1::uuid AND password_hash = $2 AND status = 'active' FOR SHARE`, [user.id, user.passwordHash])).rows;
        if (!row) throw new RuntimeError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
        await client.query(`INSERT INTO ${tables.sessions} (user_id, token_hash, expires_at) VALUES ($1::uuid, $2, CURRENT_TIMESTAMP + $3::integer * INTERVAL '1 second')`, [user.id, tokenHash, context.config.sessionLifetimeSeconds]);
      });
    },
    session(context, tokenHash) {
      return run(context, false, async (client, _tables, schema) => sessionOnClient(client, context, schema, tokenHash));
    },
    logout(context, tokenHash) {
      return run(context, false, async (client, tables) => { await client.query(`UPDATE ${tables.sessions} SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE token_hash = $1`, [tokenHash]); });
    },
    setRole(context, userId, role) {
      return run(context, false, async (client, tables) => {
        const [row] = (await client.query(`UPDATE ${tables.users} SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2::uuid RETURNING id, email, role`, [role, userId])).rows;
        if (!row) throw notFound(); return safeUser(row);
      });
    },
  };
}
