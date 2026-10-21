import {
  fieldTypes,
  operations,
  comparisonOperators,
  responseStatuses,
} from '../../../shared/public-contracts.js';
import type { PublicPolicy } from '../../../shared/public-contracts.js';
export type Project = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  runtimeState?: 'active' | 'suspended';
};
export type FieldType = (typeof fieldTypes)[number];
export type Field = {
  backfillIntent?: { kind: 'literal'; value: unknown };
  relationship?: { tableId: string; onDelete: 'restrict' };
  id?: string;
  name: string;
  type: FieldType;
  nullable?: boolean;
  unique?: boolean;
  options?: { length?: number; precision?: number; scale?: number };
  default?:
    | { kind: 'literal'; value: unknown }
    | { kind: 'current_timestamp' }
    | null;
};
export type ManagedIndex = { id?: string; specificationVersion?: 1; fieldIds: string[]; unique: boolean };
export type Table = {
  appliedPhysicalRevision?: number | null;
  indexes?: ManagedIndex[];
  id: string;
  name: string;
  draftRevision: number;
  appliedRevision: number | null;
  fields: Field[];
  applyStatus?: {
    status: 'applying' | 'applied' | 'failed' | 'outcome_unknown';
    migrationId: string;
    errorCode: string | null;
    completedAt: string | null;
  } | null;
  appliedDefinition: { definition: { name: string; fields: Field[]; indexes?: ManagedIndex[] } } | null;
};
export { operations };
export type Operation = (typeof operations)[number];
export type Policy = PublicPolicy;
export type Endpoint = {
  id: string;
  tableId: string;
  resourceName: string;
  enabledOperations: Operation[];
  policies?: Partial<Record<Operation, Policy>>;
  revision: number;
};
export type Connection = {
  revision?: number;
  id: string;
  label: string;
  identity?: {
    host: string;
    port: number;
    database: string;
    username: string;
    schema: string;
    ssl: boolean;
  };
  replacement?: { eligible: boolean; blockers: string[] };
  lastTestStatus: string;
  lastTestedAt: string | null;
};
export type Auth = {
  enabled: boolean;
  signupEnabled: boolean;
  sessionLifetimeSeconds: number;
  revision: number;
  provisioningStatus: string;
  blocked?: boolean;
};
export type KeyMetadata = {
  createdAt?: string;
  id: string;
  name: string;
  keyPrefix: string;
  scope: string;
  revokedAt: string | null;
};
export type Value =
  | { kind: 'literal'; value: unknown }
  | {
      kind: 'reference';
      source: 'request' | 'auth' | 'step';
      path: string[];
      stepId?: string;
    }
  | { kind: 'object'; fields: Record<string, Value> }
  | { kind: 'array'; items: Value[] };
export type InputField = {
  type: 'uuid' | 'string' | 'integer' | 'boolean';
  required?: boolean;
  nullable?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
};
export type Step = { id: string; name: string } & (
  | {
      type: 'query';
      tableId: string;
      access: Policy;
      select: string[];
      idValue: Value;
      forUpdate?: boolean;
      onMissing: 'null' | '404';
    }
  | {
      type: 'insert';
      tableId: string;
      access: Policy;
      select: string[];
      values: Record<string, Value>;
    }
  | {
      type: 'update';
      tableId: string;
      access: Policy;
      select: string[];
      idValue: Value;
      assignments: {
        operation: 'set' | 'decrement';
        fieldId: string;
        value: Value;
        guard?: 'gte_value';
      }[];
      onNoMatch: 404 | 409 | 422;
    }
  | { type: 'delete'; tableId: string; access: Policy; idValue: Value }
  | {
      type: 'condition';
      operator: (typeof comparisonOperators)[number];
      left: Value;
      right?: Value;
      then: Step[];
      else: Step[];
    }
  | {
      type: 'response';
      status: (typeof responseStatuses)[number];
      body?: Value;
    }
);
export type Definition = {
  input: Record<string, InputField>;
  auth: 'key_only' | 'authenticated';
  steps: Step[];
};
export type Workflow = {
  id: string;
  path: string;
  enabled: boolean;
  draftDefinition: Definition;
  draftRevision: number;
  publishedVersionId: string | null;
  publishedDefinition?: Definition | null;
  readiness?: { state: string; reasons: string[] };
};
export type Preview = {
  definitionHash: string;
  draftRevision: number;
  requiredScope: string;
  stepCount: number;
  databaseStepCount: number;
  schemaDependencies: { tableId: string; appliedRevision: number }[];
  operations?: {
    stepId: string;
    type: string;
    tableId: string;
    access: Policy;
  }[];
};
