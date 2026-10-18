import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { PlatformDatabase } from '../../database/platform-db/client.js';
import { users, platformSessions } from '../../database/platform-db/schema.js';
import type { PlatformAuthRepository } from './types.js';
export class PostgresPlatformAuthRepository implements PlatformAuthRepository {
  constructor(private readonly db: PlatformDatabase) {}
  async createUser(email: string, passwordHash: string) {
    await this.db.insert(users).values({ email, passwordHash, status: 'active' }).onConflictDoNothing();
  }
  async findUser(email: string) {
    const [user] = await this.db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    return user;
  }
  async createSession(userId: string, tokenHash: string, createdAt: Date, expiresAt: Date) {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.status, 'active'))).for('share');
      if (!user) return false;
      await tx.insert(platformSessions).values({ userId, tokenHash, createdAt, expiresAt });
      return true;
    });
  }
  async findSession(tokenHash: string) {
    const [row] = await this.db.select({ session: platformSessions, user: users }).from(platformSessions)
      .innerJoin(users, eq(users.id, platformSessions.userId)).where(eq(platformSessions.tokenHash, tokenHash)).limit(1);
    return row && { id: row.session.id, user: row.user, expiresAt: row.session.expiresAt, revokedAt: row.session.revokedAt };
  }
  async revokeSession(sessionId: string, now: Date) {
    await this.db.update(platformSessions).set({ revokedAt: now }).where(eq(platformSessions.id, sessionId));
  }
  async cleanup(before: Date, limit: number) {
    const stale = this.db.select({ id: platformSessions.id }).from(platformSessions)
      .where(or(lt(platformSessions.expiresAt, before), lt(platformSessions.revokedAt, before))).orderBy(platformSessions.expiresAt).limit(limit);
    await this.db.delete(platformSessions).where(inArray(platformSessions.id, stale));
  }
}
