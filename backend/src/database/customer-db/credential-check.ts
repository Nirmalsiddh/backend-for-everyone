import type { ConnectionConfig } from '../../modules/database-connections/types.js';
import { ConnectionError } from '../../modules/database-connections/errors.js';
import { RuntimeError } from '../../runtime/errors.js';
import {
  DestinationError,
  customerConnectionOptions,
} from '../../security/customer-destination.js';
import { boundedClient } from './admission.js';
import { catalog } from './catalog.js';
import {
  canonical,
  quoteIdentifier,
} from '../../modules/schema-builder/plan.js';
export type CredentialRequirements = {
  managedTables?: import('../../modules/schema-builder/types.js').ManagedTable[];
  schemas: { name: string; catalog: unknown }[];
  auth: { users: string; sessions: string; catalog: unknown } | null;
};
const denied = (code: string, message: string) =>
  new ConnectionError(422, code, message);
export async function inspectCredentials(
  config: ConnectionConfig,
  requirements: CredentialRequirements,
) {
  const client = boundedClient(
    await customerConnectionOptions({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 5000,
      statement_timeout: 2000,
      query_timeout: 3000,
      application_name: 'platform-credential-check',
    }),
    'diagnostic',
  );
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL search_path = pg_catalog');
    const [access] = (
      await client.query(
        "SELECT current_setting('default_transaction_read_only') = 'on' OR pg_is_in_recovery() AS readonly, has_schema_privilege(current_user, $1, 'USAGE') AS usage, has_schema_privilege(current_user, $1, 'CREATE') AS ddl",
        [config.schema],
      )
    ).rows;
    if (!access?.usage)
      throw denied(
        'SCHEMA_ACCESS_MISSING',
        'This credential cannot access the configured PostgreSQL schema',
      );
    if (access.readonly)
      throw denied(
        'DATABASE_READ_ONLY',
        'Connected, but this credential/database is currently read-only for required operations.',
      );
    if (!access.ddl)
      throw denied(
        'DDL_CAPABILITY_MISSING',
        'This credential lacks schema-management capability',
      );
    await client.query(
      'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
      [`schema-builder:${config.schema}`],
    );
    const names = requirements.schemas.map((t) => t.name);
    if (requirements.auth?.catalog)
      names.push(requirements.auth.users, requirements.auth.sessions);
    for (const name of names) {
      const target = `${quoteIdentifier(config.schema)}.${quoteIdentifier(name)}`;
      const [row] = (
        await client.query(
          "SELECT has_table_privilege(current_user, $1, 'SELECT') AS read, has_table_privilege(current_user, $1, 'INSERT, UPDATE, DELETE') AS write, pg_has_role(current_user, c.relowner, 'USAGE') AS ddl FROM pg_class c WHERE c.oid = $1::regclass",
          [target],
        )
      ).rows;
      if (!row?.read)
        throw denied(
          'READ_CAPABILITY_MISSING',
          'This credential lacks required record-read capability',
        );
      // has_table_privilege with a comma-list means ANY privilege. Check writes individually.
      const [writes] = (
        await client.query(
          "SELECT has_table_privilege(current_user, $1, 'INSERT') AND has_table_privilege(current_user, $1, 'UPDATE') AND has_table_privilege(current_user, $1, 'DELETE') AS allowed",
          [target],
        )
      ).rows;
      if (!writes?.allowed)
        throw denied(
          'WRITE_CAPABILITY_MISSING',
          'This credential lacks required record-write capability',
        );
      if (!row.ddl)
        throw denied(
          'DDL_CAPABILITY_MISSING',
          'This credential cannot manage existing application tables',
        );
    }
    for (const table of requirements.managedTables ?? []) {
      if (!table.appliedDefinition) continue;
      const d = table.appliedDefinition.definition;
      const [permission] = (
        await client.query(
          "SELECT has_column_privilege(current_user, $1, 'id', 'REFERENCES') AS allowed",
          [`${quoteIdentifier(d.schema)}.${quoteIdentifier(d.name)}`],
        )
      ).rows;
      if (!permission?.allowed)
        throw denied(
          'RELATIONSHIP_CAPABILITY_MISSING',
          'Credential cannot create relationships to this table.',
        );
    }
    for (const table of requirements.schemas)
      if (
        canonical(
          await catalog(
            client,
            config.schema,
            table.name,
            requirements.managedTables,
          ),
        ) !== canonical(table.catalog)
      )
        throw denied(
          'CATALOG_MISMATCH',
          'Managed database schema needs review before credentials can be updated',
        );
    if (requirements.auth?.catalog) {
      const actual = {
        users: await catalog(client, config.schema, requirements.auth.users),
        sessions: await catalog(
          client,
          config.schema,
          requirements.auth.sessions,
        ),
      };
      if (canonical(actual) !== canonical(requirements.auth.catalog))
        throw denied(
          'CATALOG_MISMATCH',
          'Authentication tables need review before credentials can be updated',
        );
    }
    await client.query('ROLLBACK');
  } catch (error) {
    if (
      error instanceof ConnectionError ||
      error instanceof DestinationError ||
      error instanceof RuntimeError
    )
      throw error;
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
    if (
      [
        'CERT_HAS_EXPIRED',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'ERR_TLS_CERT_ALTNAME_INVALID',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      ].includes(code)
    )
      throw denied(
        'TLS_VERIFICATION_FAILED',
        'Database TLS certificate verification failed; renew the certificate or trusted chain',
      );
    if (['28P01', '28000'].includes(code))
      throw denied('AUTHENTICATION_FAILED', 'Database authentication failed');
    if (code === '42501')
      throw denied(
        'SCHEMA_ACCESS_MISSING',
        'This credential cannot inspect required database objects',
      );
    throw denied(
      'CONNECTION_FAILED',
      'Could not validate candidate database credentials',
    );
  } finally {
    await client.end();
  }
}
