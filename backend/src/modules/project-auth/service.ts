import { randomBytes, createHash } from 'node:crypto';
import {
  RuntimeError,
  badRequest,
  unauthorized,
  unavailable,
} from '../../runtime/errors.js';
import { validateId } from '../../runtime/validation.js';
import type {
  AuthContext,
  AuthInput,
  AuthRepository,
  AuthStore,
  PasswordHasher,
  Role,
  UserPrincipal,
} from './types.js';
import { validatePassword } from './passwords.js';
import { AuthRateLimiter } from './rate-limit.js';
export const tokenHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function sessionToken(authorization: string | undefined) {
  const match = /^Bearer (us_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
  if (!match) throw unauthorized();
  return match[1]!;
}
export function credentials(body: unknown, signup = true) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, 'email') ||
    !Object.hasOwn(body, 'password')
  )
    throw badRequest();
  const record = body as { email: unknown; password: unknown };
  if (typeof record.email !== 'string' || record.email.length > 300)
    throw badRequest();
  const email = record.email.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.includes('\0')
  )
    throw badRequest();
  validatePassword(record.password, signup ? 15 : 1);
  return { email, password: record.password };
}
export function authMetadata(context: AuthContext) {
  const c = context.config;
  return {
    id: c.id,
    projectId: c.projectId,
    authUsersTableName: c.authUsersTableName,
    authSessionsTableName: c.authSessionsTableName,
    authSchemaVersion: c.authSchemaVersion,
    enabled: c.enabled,
    signupEnabled: c.signupEnabled,
    sessionLifetimeSeconds: c.sessionLifetimeSeconds,
    revision: c.revision,
    provisioningStatus: c.provisioningStatus,
    blocked: context.blocked,
  };
}
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly store: AuthStore,
    private readonly passwords: PasswordHasher,
    private readonly limiter = new AuthRateLimiter(),
  ) {}
  async get(projectId: string, ownerId: string) {
    return authMetadata(await this.repository.getOwned(projectId, ownerId));
  }
  async configure(projectId: string, ownerId: string, input: AuthInput) {
    await this.repository.configure(projectId, ownerId, input);
    return this.get(projectId, ownerId);
  }
  async provision(projectId: string, ownerId: string, revision: number) {
    const context = await this.repository.begin(projectId, ownerId, revision);
    let catalog: unknown;
    try {
      catalog = await this.store.provision(context);
    } catch (error) {
      const uncertain =
        error instanceof RuntimeError && error.code === 'AUTH_OUTCOME_UNKNOWN';
      try {
        await this.repository.finish(
          projectId,
          ownerId,
          context.config.revision,
          uncertain ? 'outcome_unknown' : 'failed',
          null,
        );
      } catch {
        throw new RuntimeError(
          503,
          'AUTH_OUTCOME_UNKNOWN',
          'Auth provisioning requires operator review',
        );
      }
      throw new RuntimeError(
        uncertain ? 503 : 422,
        uncertain ? 'AUTH_OUTCOME_UNKNOWN' : 'AUTH_PROVISION_FAILED',
        'Auth provisioning could not be completed',
      );
    }
    try {
      await this.repository.finish(
        projectId,
        ownerId,
        context.config.revision,
        'ready',
        catalog,
      );
    } catch {
      throw new RuntimeError(
        503,
        'AUTH_OUTCOME_UNKNOWN',
        'Auth provisioning requires operator review',
      );
    }
    return this.get(projectId, ownerId);
  }
  private async context(slug: string) {
    const context = await this.repository.bySlug(slug);
    if (!context || !context.config.enabled) throw unauthorized();
    if (context.blocked || context.config.provisioningStatus !== 'ready')
      throw unavailable();
    return context;
  }
  async signup(slug: string, body: unknown, ip: string) {
    const context = await this.context(slug);
    if (!context.config.signupEnabled)
      throw new RuntimeError(403, 'SIGNUP_DISABLED', 'Signup is disabled');
    const { email, password } = credentials(body);
    this.limiter.check(context.config.projectId, 'signup', ip, email);
    const hash = await this.passwords.hash(password);
    try {
      return await this.store.signup(context, email, hash);
    } catch (error) {
      if (error instanceof RuntimeError && error.statusCode !== 409)
        throw error;
      throw new RuntimeError(
        409,
        'ACCOUNT_CREATION_FAILED',
        'Unable to create account',
      );
    }
  }
  async login(slug: string, body: unknown, ip: string) {
    const context = await this.context(slug);
    const { email, password } = credentials(body, false);
    this.limiter.check(context.config.projectId, 'login', ip, email);
    const user = await this.store.findUser(context, email);
    const valid = user
      ? await this.passwords.verify(user.passwordHash, password)
      : (await this.passwords.dummyVerify(password), false);
    if (!user || !valid || user.status !== 'active')
      throw new RuntimeError(
        401,
        'INVALID_CREDENTIALS',
        'Invalid email or password',
      );
    const token = `us_${randomBytes(32).toString('base64url')}`;
    await this.store.login(context, user, tokenHash(token));
    return {
      token,
      expiresIn: context.config.sessionLifetimeSeconds,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }
  async authenticate(
    slug: string,
    authorization: string | undefined,
  ): Promise<UserPrincipal> {
    const token = sessionToken(authorization);
    const context = await this.context(slug);
    const hash = tokenHash(token);
    const session = await this.store.session(context, hash);
    return {
      kind: 'user',
      projectId: context.config.projectId,
      userId: session.user.id,
      role: session.user.role,
      sessionId: session.sessionId,
      tokenHash: hash,
      context,
    };
  }
  async me(slug: string, authorization: string | undefined) {
    const context = await this.context(slug);
    return (
      await this.store.session(context, tokenHash(sessionToken(authorization)))
    ).user;
  }
  async logout(slug: string, authorization: string | undefined) {
    const context = await this.context(slug);
    await this.store.logout(context, tokenHash(sessionToken(authorization)));
  }
  async setRole(
    projectId: string,
    ownerId: string,
    userId: string,
    role: Role,
  ) {
    validateId(userId);
    if (!['user', 'admin'].includes(role)) throw badRequest();
    const context = await this.repository.getOwned(projectId, ownerId);
    if (context.config.provisioningStatus !== 'ready' || context.blocked)
      throw unavailable();
    return this.store.setRole(context, userId, role);
  }
}
