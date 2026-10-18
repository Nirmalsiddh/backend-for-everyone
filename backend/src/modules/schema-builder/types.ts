import type { ConnectionConfig } from '../database-connections/types.js';

import type { fieldTypes } from '../../../../shared/public-contracts.js';
export type FieldType = (typeof fieldTypes)[number];
export type FieldDefault =
  { kind: 'literal'; value: unknown } | { kind: 'current_timestamp' };
export interface FieldInput {
  id?: string;
  name: string;
  type: FieldType;
  options?: { length?: number; precision?: number; scale?: number };
  nullable?: boolean;
  unique?: boolean;
  default?: FieldDefault;
}
export interface FieldDefinition {
  id: string;
  name: string;
  position: number;
  type: FieldType;
  options: { length?: number; precision?: number; scale?: number };
  nullable: boolean;
  unique: boolean;
  default: FieldDefault | null;
}
export interface Definition {
  schema: string;
  name: string;
  fields: FieldDefinition[];
}
export interface AppliedDefinition {
  definition: Definition;
  catalog: unknown;
}
export interface TableRecord {
  id: string;
  projectId: string;
  connectionId: string;
  schemaName: string;
  name: string;
  draftRevision: number;
  appliedRevision: number | null;
  appliedDefinition: AppliedDefinition | null;
  createdAt: Date;
  updatedAt: Date;
  fields: FieldDefinition[];
  applyStatus?: {
    status: MigrationStatus;
    migrationId: string;
    errorCode: string | null;
    completedAt: Date | null;
  } | null;
}
export interface DraftInput {
  name: string;
  fields: FieldInput[];
}
export interface Plan {
  hash: string;
  revision: number;
  definition: Definition;
  statements: string[];
  operation: 'create_table' | 'add_columns';
}
export type MigrationStatus =
  'applying' | 'applied' | 'failed' | 'outcome_unknown';
export interface SchemaRepository {
  list(projectId: string, ownerId: string): Promise<TableRecord[]>;
  get(
    projectId: string,
    ownerId: string,
    tableId: string,
  ): Promise<TableRecord>;
  create(
    projectId: string,
    ownerId: string,
    input: DraftInput,
    target: {
      connectionId: string;
      encryptedConfig: string;
      schemaName: string;
    },
  ): Promise<TableRecord>;
  update(
    projectId: string,
    ownerId: string,
    tableId: string,
    revision: number,
    input: DraftInput,
  ): Promise<TableRecord>;
  delete(projectId: string, ownerId: string, tableId: string): Promise<void>;
  begin(
    projectId: string,
    ownerId: string,
    tableId: string,
    plan: Plan,
  ): Promise<string>;
  finish(
    projectId: string,
    ownerId: string,
    tableId: string,
    migrationId: string,
    plan: Plan,
    status: Exclude<MigrationStatus, 'applying'>,
    catalog: unknown,
    errorCode: string | null,
  ): Promise<void>;
}
export type SchemaExecutor = (
  config: ConnectionConfig,
  plan: Plan,
  applied: AppliedDefinition | null,
) => Promise<unknown>;
