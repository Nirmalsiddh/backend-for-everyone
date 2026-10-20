import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { createPlatformDatabase } from '../database/platform-db/client.js';
import {
  databaseConnections,
  projects,
  users,
  platformSessions,
  schemaMigrations,
  projectAuthConfigs,
} from '../database/platform-db/schema.js';
import { CredentialEncryption } from '../security/encryption.js';
import { parseDatabaseUrl } from '../config/env.js';
import { setupLeases } from './setup-lease.js';
import { reconcile } from './reconciliation.js';
const args = process.argv.slice(2);
const allowed = new Set([
  '--project',
  '--operation',
  '--user',
  '--apply',
  '--maintenance-confirmed',
  '--backup-confirmed',
]);
function flag(name: string) {
  return args.includes(name);
}
function value(name: string) {
  const i = args.indexOf(name);
  return i < 0 ? '' : (args[i + 1] ?? '');
}
function identifier(name: string) {
  const v = value(name);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v))
    throw new Error('Explicit UUID identifier required');
  return v;
}
async function main() {
  if (args.some((a) => a.startsWith('--') && !allowed.has(a)))
    throw new Error('Unknown operator option');
  const url = parseDatabaseUrl(
    process.env.PLATFORM_DATABASE_URL,
    'PLATFORM_DATABASE_URL',
  );
  const { db, pool } = createPlatformDatabase(url, 'platform-operator');
  const leases = setupLeases(url);
  const encryption = new CredentialEncryption(
    process.env.CONNECTION_ENCRYPTION_KEY ?? '',
  );
  const apply = flag('--apply');
  const timestamp = new Date().toISOString();
  const requestId = randomUUID();
  let release: (() => Promise<void>) | undefined;
  const event = (data: Record<string, unknown>) =>
    console.info(
      JSON.stringify({ timestamp, requestId, actor: 'operator', ...data }),
    );
  try {
    if (args[0] === 'preflight') {
      const records = await db.select().from(databaseConnections);
      const failed: string[] = [];
      for (const row of records) {
        try {
          encryption.decrypt(row, `${row.projectId}:${row.id}`);
        } catch {
          failed.push(row.id);
        }
      }
      event({
        action: 'encryption-preflight',
        totalChecked: records.length,
        decryptable: records.length - failed.length,
        failedRecordIds: failed,
      });
      if (failed.length) process.exitCode = 1;
    } else if (
      args[0] === 'project' &&
      ['suspend', 'resume'].includes(args[1] ?? '')
    ) {
      const projectId = identifier('--project');
      const runtimeState = args[1] === 'suspend' ? 'suspended' : 'active';
      const found = apply
        ? await db
            .update(projects)
            .set({ runtimeState })
            .where(eq(projects.id, projectId))
            .returning({ id: projects.id })
        : await db
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, projectId));
      if (!found.length) throw new Error('Project not found');
      event({
        action: `project-${args[1]}`,
        projectId,
        runtimeState,
        outcome: apply ? 'applied' : 'dry-run',
      });
    } else if (
      args[0] === 'user' &&
      ['enable', 'disable', 'revoke-sessions'].includes(args[1] ?? '')
    ) {
      const userId = identifier('--user');
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId));
      if (!user) throw new Error('User not found');
      if (apply)
        await db.transaction(async (tx) => {
          if (args[1] !== 'revoke-sessions')
            await tx
              .update(users)
              .set({
                status: args[1] === 'enable' ? 'active' : 'disabled',
                updatedAt: new Date(),
              })
              .where(eq(users.id, userId));
          if (args[1] !== 'enable')
            await tx
              .update(platformSessions)
              .set({ revokedAt: new Date() })
              .where(eq(platformSessions.userId, userId));
        });
      event({
        action: `user-${args[1]}`,
        userId,
        outcome: apply ? 'applied' : 'dry-run',
      });
    } else if (
      args[0] === 'reconcile' &&
      ['schema', 'auth'].includes(args[1] ?? '')
    ) {
      const projectId = identifier('--project');
      release = await leases.acquire(projectId);
      event({
        action: 'reconcile',
        ...(await reconcile(
          db,
          encryption,
          projectId,
          identifier('--operation'),
          args[1] as 'schema' | 'auth',
          apply,
        )),
      });
    } else if (args[0] === 'encryption' && args[1] === 'rotate') {
      if (!flag('--maintenance-confirmed') || !flag('--backup-confirmed'))
        throw new Error('Maintenance and backup confirmations required');
      const path = process.env.NEW_CONNECTION_ENCRYPTION_KEY_FILE;
      if (!path) throw new Error('Protected new-key file required');
      if (((await stat(path)).mode & 0o077) !== 0)
        throw new Error('New-key file permissions must be 0600');
      const next = new CredentialEncryption(
        (await readFile(path, 'utf8')).trim(),
      );
      const result = await db.transaction(async (tx) => {
        const live = await tx.execute(
          sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name IN ('platform-management', 'platform-setup-leases') LIMIT 1`,
        );
        if (live.rows.length)
          throw new Error('Stop backend before key maintenance');
        const active = await tx
          .select({ id: schemaMigrations.id })
          .from(schemaMigrations)
          .where(
            inArray(schemaMigrations.status, ['applying', 'outcome_unknown']),
          )
          .limit(1);
        const auth = await tx
          .select({ id: projectAuthConfigs.id })
          .from(projectAuthConfigs)
          .where(
            inArray(projectAuthConfigs.provisioningStatus, [
              'provisioning',
              'outcome_unknown',
            ]),
          )
          .limit(1);
        if (active.length || auth.length)
          throw new Error(
            'Reconcile uncertain setup before rotating receipt/encryption keys',
          );
        const records = await tx
          .select()
          .from(databaseConnections)
          .for('update');
        for (const row of records) {
          const context = `${row.projectId}:${row.id}`;
          const encrypted = next.encrypt(
            encryption.decrypt(row, context),
            context,
          );
          next.decrypt(encrypted, context);
          if (apply)
            await tx
              .update(databaseConnections)
              .set({
                ...encrypted,
                revision: row.revision + 1,
                updatedAt: new Date(),
              })
              .where(eq(databaseConnections.id, row.id));
        }
        if (apply)
          for (const row of await tx.select().from(databaseConnections))
            next.decrypt(row, `${row.projectId}:${row.id}`);
        return records.length;
      });
      event({
        action: 'encryption-rotate',
        checked: result,
        outcome: apply ? 'applied' : 'dry-run',
      });
    } else
      throw new Error(
        'Use preflight; project suspend/resume; user enable/disable/revoke-sessions; reconcile schema/auth; encryption rotate',
      );
  } finally {
    await release?.();
    await leases.close();
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    JSON.stringify({
      action: 'operator-command',
      outcome: 'failed',
      message:
        'Operation failed safely. Check identifiers, setup state, destination policy, protected keys and maintenance prerequisites. No credentials are printed.',
    }),
  );
  process.exitCode = 1;
});
