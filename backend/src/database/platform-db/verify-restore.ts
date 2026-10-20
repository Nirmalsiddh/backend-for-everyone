import { containRestore } from '../../operations/containment.js';
// Isolated recovery verification only: never contacts a customer database.
import { createPlatformDatabase } from './client.js';
import { CredentialEncryption } from '../../security/encryption.js';
import { sql } from 'drizzle-orm';
import { users, projects, databaseConnections } from './schema.js';
import { createReadiness } from './readiness.js';
async function main() {
  if (process.env.CONFIRM_ISOLATED_RESTORE !== 'yes')
    throw new Error('Isolated restore confirmation required');
  const url = process.env.PLATFORM_DATABASE_URL ?? '';
  const { db, pool } = createPlatformDatabase(url);
  const readiness = createReadiness(url);
  try {
    await readiness.check();
    // Containment must survive later validation failure, including a lost encryption key.
    const containment = await containRestore(db);
    const encryption = new CredentialEncryption(
      process.env.CONNECTION_ENCRYPTION_KEY ?? '',
    );
    const userCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(users);
    const projectCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(projects);
    const connections = await db.select().from(databaseConnections);
    for (const connection of connections) {
      encryption.decrypt(
        connection,
        `${connection.projectId}:${connection.id}`,
      );
    }
    console.info({
      users: Number(userCount[0]!.count),
      projects: Number(projectCount[0]!.count),
      decryptedConnections: connections.length,
      ...containment,
    });
  } finally {
    await readiness.close();
    await pool.end();
  }
}
main().catch(() => {
  console.error(
    'Restore verification failed; check isolated database, migration version and encryption key.',
  );
  process.exitCode = 1;
});
