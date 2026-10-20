import type { PlatformDatabase } from '../database/platform-db/client.js';
import {
  apiKeys,
  platformSessions,
  projects,
} from '../database/platform-db/schema.js';
export async function containRestore(db: PlatformDatabase) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const contained = await tx
      .update(projects)
      .set({ runtimeState: 'suspended' })
      .returning({ id: projects.id });
    await tx.update(platformSessions).set({ revokedAt: now });
    await tx.update(apiKeys).set({ revokedAt: now });
    return {
      projectsSuspended: contained.length,
      platformSessionsInvalidated: true,
      restoredKeysRevoked: true,
    };
  });
}
