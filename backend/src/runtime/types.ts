import type { SessionGuard, UserPrincipal } from '../modules/project-auth/types.js';
import type { AppliedDefinition } from '../modules/schema-builder/types.js';
import type { ConnectionConfig, ConnectionRecord } from '../modules/database-connections/types.js';
import type { Operation, OperationPolicy } from '../modules/endpoints/types.js';
import type { Ownership } from './authorization.js';
import type { KeyScope } from '../modules/api-keys/types.js';
export interface RuntimeIdentity { projectId: string; keyId: string; scope: KeyScope }
export type RuntimePrincipal = RuntimeIdentity | UserPrincipal;
export interface RuntimeTarget {
  fingerprint?: string;
  relatedTargets?: Record<string, RuntimeTarget>;
  policies?: Partial<Record<Operation, OperationPolicy>>;
  endpointId: string; projectId: string; enabledOperations: Operation[];
  applied: AppliedDefinition | null; connection: ConnectionRecord; blocked: boolean;
}
export interface RuntimeRepository {
  authenticate(slug: string, keyHash: string): Promise<RuntimeIdentity | undefined>;
  resolve(projectId: string, resource: string, includes?: string[]): Promise<RuntimeTarget | undefined>;
}
export interface Query { text: string; values: unknown[] }
export interface ListOptions { limit: number; offset: number; sort: string; direction: 'ASC' | 'DESC'; filters: { field: string; value: unknown }[] }
export interface ExpandedRead {
  includes: { name: string; applied: AppliedDefinition; ownership?: Ownership | undefined }[];
  limit?: number | undefined;
  fence: () => Promise<void>;
}
export type RuntimeExecutor = (config: ConnectionConfig, applied: AppliedDefinition, query: Query, guard?: SessionGuard, expansion?: ExpandedRead) => Promise<Record<string, unknown>[]>;
