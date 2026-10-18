import type { ConnectionRecord } from '../database-connections/types.js';
import type { SchemaClient } from '../../database/customer-db/schema-executor.js';
export type Role = 'user' | 'admin';
export type ProvisioningStatus = 'unprovisioned' | 'provisioning' | 'ready' | 'failed' | 'outcome_unknown';
export interface AuthConfig {
  id: string; projectId: string; connectionId: string; enabled: boolean; signupEnabled: boolean;
  provisioningStatus: ProvisioningStatus; authSchemaVersion: number; authUsersTableName: string; authSessionsTableName: string;
  sessionLifetimeSeconds: number; revision: number; createdAt: Date; updatedAt: Date; catalog: unknown;
}
export interface AuthInput { enabled: boolean; signupEnabled: boolean; sessionLifetimeSeconds: number; expectedRevision: number }
export interface AuthContext { config: AuthConfig; connection: ConnectionRecord; blocked: boolean }
export interface SafeUser { id: string; email: string; role: Role }
export interface LoginUser extends SafeUser { passwordHash: string; status: string }
export interface UserPrincipal { kind: 'user'; projectId: string; userId: string; role: Role; sessionId: string; tokenHash: string; context: AuthContext }
export interface AuthRepository {
  configure(projectId: string, ownerId: string, input: AuthInput): Promise<AuthConfig>;
  getOwned(projectId: string, ownerId: string): Promise<AuthContext>;
  bySlug(slug: string): Promise<AuthContext | undefined>;
  begin(projectId: string, ownerId: string, revision: number): Promise<AuthContext>;
  finish(projectId: string, ownerId: string, revision: number, status: 'ready' | 'failed' | 'outcome_unknown', catalog: unknown): Promise<void>;
}
export interface PasswordHasher { hash(password: string): Promise<string>; verify(hash: string, password: string): Promise<boolean>; dummyVerify(password: string): Promise<void> }
export interface AuthStore {
  provision(context: AuthContext): Promise<unknown>;
  signup(context: AuthContext, email: string, hash: string): Promise<SafeUser>;
  findUser(context: AuthContext, email: string): Promise<LoginUser | undefined>;
  login(context: AuthContext, user: LoginUser, tokenHash: string): Promise<void>;
  session(context: AuthContext, tokenHash: string): Promise<{ user: SafeUser; sessionId: string }>;
  logout(context: AuthContext, tokenHash: string): Promise<void>;
  setRole(context: AuthContext, userId: string, role: Role): Promise<SafeUser>;
}
export interface SessionGuard { context: AuthContext; tokenHash: string; userId: string; role: Role }
export type AuthClient = SchemaClient;
