import type { SessionGuard, UserPrincipal } from '../modules/project-auth/types.js';
import type { AppliedDefinition } from '../modules/schema-builder/types.js';
import type { ConnectionConfig, ConnectionRecord } from '../modules/database-connections/types.js';
import type { Operation, OperationPolicy } from '../modules/endpoints/types.js';
import type { KeyScope } from '../modules/api-keys/types.js';
export interface RuntimeIdentity { projectId: string; keyId: string; scope: KeyScope }
export type RuntimePrincipal = RuntimeIdentity | UserPrincipal;
export interface RuntimeTarget {
  policies?: Partial<Record<Operation, OperationPolicy>>;
  endpointId: string; projectId: string; enabledOperations: Operation[];
  applied: AppliedDefinition | null; connection: ConnectionRecord; blocked: boolean;
}
export interface RuntimeRepository {
  authenticate(slug: string, keyHash: string): Promise<RuntimeIdentity | undefined>;
  resolve(projectId: string, resource: string): Promise<RuntimeTarget | undefined>;
}
export interface Query { text: string; values: unknown[] }
export interface ListOptions { limit: number; offset: number; sort: string; direction: 'ASC' | 'DESC'; filters: { field: string; value: unknown }[] }
export type RuntimeExecutor = (config: ConnectionConfig, applied: AppliedDefinition, query: Query, guard?: SessionGuard) => Promise<Record<string, unknown>[]>;
