import { createHash, randomBytes } from 'node:crypto';
import { PasswordError, validatePassword, type PasswordHasher } from '../../security/passwords.js';
import { PlatformRateLimiter } from './rate-limit.js';
import { PlatformAuthError, unauthorized, userDto, type PlatformAuthRepository } from './types.js';
export const platformTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const invalid = () => new PlatformAuthError(400, 'INVALID_REQUEST', 'Invalid email or password format');
export class PlatformAuthService {
  constructor(private readonly repository: PlatformAuthRepository, private readonly passwords: PasswordHasher,
    private readonly limiter = new PlatformRateLimiter(), private readonly now = Date.now) {}
  private credentials(body: { email: string; password: string }, signup: boolean) {
    const email = body.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.includes('\0')) throw invalid();
    try { validatePassword(body.password, signup ? 15 : 1); } catch { throw invalid(); }
    return { email, password: body.password };
  }
  private async hashing<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof PasswordError) throw new PlatformAuthError(error.capacity ? 503 : 400, error.capacity ? 'AUTH_CAPACITY_EXHAUSTED' : 'INVALID_REQUEST', error.message);
      throw error;
    }
  }
  async signup(body: { email: string; password: string }, ip: string) {
    const { email, password } = this.credentials(body, true);
    this.limiter.check('signup', ip, email);
    const hash = await this.hashing(() => this.passwords.hash(password));
    await this.repository.createUser(email, hash);
    return { message: 'Continue to sign in with your email and password.' };
  }
  async login(body: { email: string; password: string }, ip: string) {
    const { email, password } = this.credentials(body, false);
    this.limiter.check('login', ip, email);
    const user = await this.repository.findUser(email);
    const valid = user?.passwordHash
      ? await this.hashing(() => this.passwords.verify(user.passwordHash!, password))
      : (await this.hashing(() => this.passwords.dummyVerify(password)), false);
    const failure = () => new PlatformAuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    if (!user || !valid || user.status !== 'active') throw failure();
    const sessionToken = `ps_${randomBytes(32).toString('base64url')}`;
    const createdAt = new Date(this.now());
    if (!await this.repository.createSession(user.id, platformTokenHash(sessionToken), createdAt, new Date(createdAt.getTime() + 86400000))) throw failure();
    return { user: userDto(user), sessionToken };
  }
  async authenticate(authorization: string | undefined) {
    const match = /^Bearer (ps_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!match) throw unauthorized();
    const session = await this.repository.findSession(platformTokenHash(match[1]!));
    if (!session || session.revokedAt || session.expiresAt.getTime() <= this.now() || session.user.status !== 'active') throw unauthorized();
    return { principal: { userId: session.user.id, sessionId: session.id }, user: userDto(session.user) };
  }
  async logout(sessionId: string) { await this.repository.revokeSession(sessionId, new Date(this.now())); }
  async cleanup() { await this.repository.cleanup(new Date(this.now() - 7 * 86400000), 500); }
}
