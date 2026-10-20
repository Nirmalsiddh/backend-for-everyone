import type { AppliedDefinition } from '../schema-builder/types.js';
import type { OperationPolicy } from '../endpoints/types.js';
import type { ConnectionRecord } from '../database-connections/types.js';
export type Value =
  | { kind: 'literal'; value: unknown }
  | { kind: 'reference'; source: 'request' | 'auth'; path: string[] }
  | { kind: 'reference'; source: 'step'; stepId: string; path: string[] }
  | { kind: 'object'; fields: Record<string, Value> }
  | { kind: 'array'; items: Value[] };
export interface InputField {
  type: 'uuid' | 'string' | 'integer' | 'boolean';
  required?: boolean;
  nullable?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}
interface BaseStep {
  id: string;
  name: string;
}
interface DatabaseStep extends BaseStep {
  tableId: string;
  access: OperationPolicy;
}
export type Step =
  | (DatabaseStep & {
      type: 'query';
      select: string[];
      idValue: Value;
      forUpdate?: boolean;
      onMissing: 'null' | '404';
    })
  | (DatabaseStep & {
      type: 'insert';
      values: Record<string, Value>;
      select: string[];
    })
  | (DatabaseStep & {
      type: 'update';
      idValue: Value;
      assignments: {
        operation: 'set' | 'decrement';
        fieldId: string;
        value: Value;
        guard?: 'gte_value';
      }[];
      select: string[];
      onNoMatch: 404 | 409 | 422;
    })
  | (DatabaseStep & { type: 'delete'; idValue: Value })
  | (BaseStep & {
      type: 'condition';
      operator:
        | 'equals'
        | 'not_equals'
        | 'greater_than'
        | 'greater_or_equal'
        | 'less_than'
        | 'less_or_equal'
        | 'is_null'
        | 'is_not_null';
      left: Value;
      right?: Value;
      then: Step[];
      else: Step[];
    })
  | (BaseStep & {
      type: 'response';
      status: 200 | 201 | 204 | 400 | 403 | 404 | 409 | 422;
      body?: Value;
    });
export interface WorkflowDefinition {
  input: Record<string, InputField>;
  auth: 'key_only' | 'authenticated';
  steps: Step[];
}
export interface Dependency {
  tableId: string;
  appliedRevision: number;
}
export interface WorkflowPreview {
  definitionHash: string;
  draftRevision: number;
  requiredScope: 'read' | 'read_write';
  stepCount: number;
  databaseStepCount: number;
  schemaDependencies: Dependency[];
  operations: {
    stepId: string;
    type: string;
    tableId: string;
    access: OperationPolicy;
    sqlTemplate?: string;
  }[];
}
export interface WorkflowEndpoint {
  id: string;
  projectId: string;
  connectionId: string;
  path: string;
  method: 'POST';
  enabled: boolean;
  publishedDefinition?: WorkflowDefinition | null;
  publishedDependencies?: Dependency[] | null;
  managementBlocked?: boolean;
  authBlocked?: boolean;
  draftDefinition: WorkflowDefinition;
  draftRevision: number;
  publishedVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface WorkflowVersion {
  id: string;
  workflowEndpointId: string;
  version: number;
  definition: WorkflowDefinition;
  definitionHash: string;
  schemaDependencies: Dependency[];
  publishedAt: Date;
}
export interface WorkflowTable {
  id: string;
  connectionId: string;
  appliedRevision: number | null;
  appliedDefinition: AppliedDefinition | null;
}
export interface WorkflowTarget {
  endpoint: WorkflowEndpoint;
  version: WorkflowVersion;
  connection: ConnectionRecord;
  tables: WorkflowTable[];
  blocked: boolean;
}
export interface WorkflowRepository {
  create(
    projectId: string,
    ownerId: string,
    path: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowEndpoint>;
  list(projectId: string, ownerId: string): Promise<WorkflowEndpoint[]>;
  get(
    projectId: string,
    ownerId: string,
    id: string,
  ): Promise<WorkflowEndpoint>;
  edit(
    projectId: string,
    ownerId: string,
    id: string,
    revision: number,
    definition: WorkflowDefinition,
  ): Promise<WorkflowEndpoint>;
  toggle(
    projectId: string,
    ownerId: string,
    id: string,
    revision: number,
    enabled: boolean,
  ): Promise<WorkflowEndpoint>;
  tables(projectId: string, ownerId: string): Promise<WorkflowTable[]>;
  publish(
    projectId: string,
    ownerId: string,
    id: string,
    revision: number,
    hash: string,
  ): Promise<WorkflowVersion>;
  resolve(projectId: string, path: string): Promise<WorkflowTarget | undefined>;
}
export interface WorkflowResult {
  status: number;
  body: unknown;
  workflowId: string;
  versionId: string;
  stepCount: number;
  dbOperations: number;
  terminalStepId: string;
  outcome: 'commit' | 'rollback';
}
