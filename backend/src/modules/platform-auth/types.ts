export interface PlatformUser { id: string; email: string; passwordHash: string | null; status: string }
export interface PlatformUserDto { id: string; email: string }
export interface PlatformPrincipal { userId: string; sessionId: string }
export interface PlatformSession { id: string; user: PlatformUser; expiresAt: Date; revokedAt: Date | null }
export interface PlatformAuthRepository {
  createUser(email: string, passwordHash: string): Promise<void>;
  findUser(email: string): Promise<PlatformUser | undefined>;
  createSession(userId: string, tokenHash: string, createdAt: Date, expiresAt: Date): Promise<boolean>;
  findSession(tokenHash: string): Promise<PlatformSession | undefined>;
  revokeSession(sessionId: string, now: Date): Promise<void>;
  cleanup(before: Date, limit: number): Promise<void>;
}
export class PlatformAuthError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string, public readonly retryAfter?: number) { super(message); }
}
export const unauthorized = () => new PlatformAuthError(401, 'UNAUTHORIZED', 'Valid platform credentials required');
export const userDto = (user: PlatformUser): PlatformUserDto => ({ id: user.id, email: user.email });
