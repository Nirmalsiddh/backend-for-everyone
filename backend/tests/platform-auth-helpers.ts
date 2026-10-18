import { randomUUID } from 'node:crypto';
import { platformTokenHash } from '../src/modules/platform-auth/service.js';
import type { PlatformAuthRepository, PlatformUser, PlatformSession } from '../src/modules/platform-auth/types.js';
export const fixtureToken = 'ps_' + 'a'.repeat(43);
export function memoryPlatformAuthRepository(ownerId?: string) {
  const users = new Map<string, PlatformUser>();
  const sessions = new Map<string, PlatformSession>();
  if (ownerId) {
    const user = { id: ownerId, email: `${ownerId}@example.test`, status: 'active', passwordHash: null };
    users.set(user.email, user);
    sessions.set(platformTokenHash(fixtureToken), { id: randomUUID(), user, expiresAt: new Date(Date.now() + 86400000), revokedAt: null });
  }
  const repository: PlatformAuthRepository = {
    async createUser(email, passwordHash) { if (!users.has(email)) users.set(email, { id: randomUUID(), email, passwordHash, status: 'active' }); },
    async findUser(email) { return users.get(email); },
    async createSession(userId, hash, _createdAt, expiresAt) {
      const user = [...users.values()].find((u) => u.id === userId && u.status === 'active');
      if (!user) return false;
      sessions.set(hash, { id: randomUUID(), user, expiresAt, revokedAt: null }); return true;
    },
    async findSession(hash) { return sessions.get(hash); },
    async revokeSession(id, now) { const session = [...sessions.values()].find((s) => s.id === id); if (session) session.revokedAt = now; },
    async cleanup(before, limit) {
      let removed = 0;
      for (const [hash, s] of sessions) if (removed < limit && (s.expiresAt < before || (s.revokedAt && s.revokedAt < before))) { sessions.delete(hash); removed++; }
    },
  };
  return { ...repository, users, sessions };
}
