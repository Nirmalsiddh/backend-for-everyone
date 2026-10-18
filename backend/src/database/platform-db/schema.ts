import type { WorkflowDefinition, Dependency } from '../../modules/workflows/types.js';
import type { ProvisioningStatus } from '../../modules/project-auth/types.js';
import type { OperationPolicy } from '../../modules/endpoints/types.js';
import type { Operation } from '../../modules/endpoints/types.js';
import type { KeyScope } from '../../modules/api-keys/types.js';
import type { AppliedDefinition, Definition, FieldDefault, FieldType, MigrationStatus } from '../../modules/schema-builder/types.js';
import { sql } from 'drizzle-orm';
import { boolean as booleanColumn, check, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 254 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('users_email_unique').on(sql`lower(${table.email})`),
]);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  check('projects_name_valid', sql`char_length(btrim(${table.name})) > 0 AND ${table.name} = btrim(${table.name})`),
  check('projects_slug_valid', sql`${table.slug} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(${table.slug}) >= 3`),
]);

export const databaseConnections = pgTable('database_connections', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().unique().references(() => projects.id, { onDelete: 'cascade' }),
  label: varchar('label', { length: 100 }).notNull(),
  encryptedConfig: text('encrypted_config').notNull(),
  encryptionIv: varchar('encryption_iv', { length: 24 }).notNull(),
  encryptionTag: varchar('encryption_tag', { length: 24 }).notNull(),
  encryptionVersion: integer('encryption_version').notNull(),
  lastTestStatus: varchar('last_test_status', { length: 16 }).$type<'success' | 'failed'>().notNull(),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  check('database_connections_test_status', sql`${table.lastTestStatus} IN ('success', 'failed')`),
  check('database_connections_encryption_version', sql`${table.encryptionVersion} = 1`),
]);

export const schemaTables = pgTable('schema_tables', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  connectionId: uuid('connection_id').notNull().references(() => databaseConnections.id, { onDelete: 'restrict' }),
  schemaName: varchar('schema_name', { length: 63 }).notNull(),
  name: varchar('name', { length: 63 }).notNull(),
  draftRevision: integer('draft_revision').notNull().default(1),
  appliedRevision: integer('applied_revision'),
  appliedDefinition: jsonb('applied_definition').$type<AppliedDefinition>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('schema_tables_id_project_unique').on(table.id, table.projectId),
  uniqueIndex('schema_tables_target_unique').on(table.connectionId, table.schemaName, table.name),
  check('schema_tables_name_valid', sql`${table.name} ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'`),
  check('schema_tables_revisions_valid', sql`${table.draftRevision} > 0 AND (${table.appliedRevision} IS NULL OR (${table.appliedRevision} > 0 AND ${table.appliedRevision} <= ${table.draftRevision}))`),
  check('schema_tables_applied_pair', sql`(${table.appliedRevision} IS NULL) = (${table.appliedDefinition} IS NULL)`),
]);

export const schemaFields = pgTable('schema_fields', {
  id: uuid('id').primaryKey(),
  tableId: uuid('table_id').notNull().references(() => schemaTables.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 63 }).notNull(),
  position: integer('position').notNull(),
  type: varchar('type', { length: 16 }).$type<FieldType>().notNull(),
  options: jsonb('type_options').$type<{ length?: number; precision?: number; scale?: number }>().notNull(),
  nullable: booleanColumn('nullable').notNull(),
  unique: booleanColumn('unique').notNull(),
  default: jsonb('default_value').$type<FieldDefault>(),
}, (table) => [
  uniqueIndex('schema_fields_name_unique').on(table.tableId, table.name),
  uniqueIndex('schema_fields_position_unique').on(table.tableId, table.position),
  check('schema_fields_position_valid', sql`${table.position} >= 0`),
  check('schema_fields_name_valid', sql`${table.name} ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND ${table.name} <> 'id'`),
  check('schema_fields_type_valid', sql`${table.type} IN ('text', 'varchar', 'integer', 'bigint', 'decimal', 'boolean', 'uuid', 'date', 'timestamp', 'jsonb')`),
  check('schema_fields_default_valid', sql`${table.default} IS NULL OR (jsonb_typeof(${table.default}) = 'object' AND ${table.default}->>'kind' IN ('literal', 'current_timestamp'))`),
]);

export const schemaMigrations = pgTable('schema_migrations', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  tableId: uuid('table_id').notNull().references(() => schemaTables.id, { onDelete: 'cascade' }),
  draftRevision: integer('draft_revision').notNull(),
  planHash: varchar('plan_hash', { length: 64 }).notNull(),
  definition: jsonb('definition').$type<Definition>().notNull(),
  status: varchar('status', { length: 24 }).$type<MigrationStatus>().notNull(),
  errorCode: varchar('error_code', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  uniqueIndex('schema_migrations_one_active_project').on(table.projectId).where(sql`${table.status} IN ('applying', 'outcome_unknown')`),
  check('schema_migrations_status_valid', sql`${table.status} IN ('applying', 'applied', 'failed', 'outcome_unknown')`),
]);

export const endpoints = pgTable('endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  tableId: uuid('table_id').notNull().unique(),
  resourceName: varchar('resource_name', { length: 63 }).notNull(),
  enabledOperations: jsonb('enabled_operations').$type<Operation[]>().notNull(),
  policies: jsonb('policies').$type<Partial<Record<Operation, OperationPolicy>>>().notNull().default({}),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.tableId, table.projectId], foreignColumns: [schemaTables.id, schemaTables.projectId] }).onDelete('cascade'),
  uniqueIndex('endpoints_project_resource_unique').on(table.projectId, table.resourceName),
  check('endpoints_revision_valid', sql`${table.revision} > 0`),
  check('endpoints_operations_valid', sql`jsonb_typeof(${table.enabledOperations}) = 'array' AND ${table.enabledOperations} <@ '["list","get","create","update","delete"]'::jsonb`),
]);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
  keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
  scope: varchar('scope', { length: 16 }).$type<KeyScope>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  check('api_keys_scope_valid', sql`${table.scope} IN ('read', 'read_write')`),
  check('api_keys_hash_valid', sql`${table.keyHash} ~ '^[a-f0-9]{64}$'`),
  check('api_keys_name_valid', sql`char_length(btrim(${table.name})) > 0`),
]);

export const projectAuthConfigs = pgTable('project_auth_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().unique().references(() => projects.id, { onDelete: 'restrict' }),
  connectionId: uuid('connection_id').notNull().references(() => databaseConnections.id, { onDelete: 'restrict' }),
  enabled: booleanColumn('enabled').notNull(),
  signupEnabled: booleanColumn('signup_enabled').notNull(),
  provisioningStatus: varchar('provisioning_status', { length: 24 }).$type<ProvisioningStatus>().notNull().default('unprovisioned'),
  authSchemaVersion: integer('auth_schema_version').notNull().default(1),
  authUsersTableName: varchar('auth_users_table_name', { length: 63 }).notNull(),
  authSessionsTableName: varchar('auth_sessions_table_name', { length: 63 }).notNull(),
  sessionLifetimeSeconds: integer('session_lifetime_seconds').notNull().default(86400),
  catalog: jsonb('catalog'),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  check('project_auth_status_valid', sql`${table.provisioningStatus} IN ('unprovisioned', 'provisioning', 'ready', 'failed', 'outcome_unknown')`),
  check('project_auth_lifetime_valid', sql`${table.sessionLifetimeSeconds} BETWEEN 300 AND 604800`),
  check('project_auth_revision_valid', sql`${table.revision} > 0 AND ${table.authSchemaVersion} = 1`),
  check('project_auth_names_valid', sql`${table.authUsersTableName} = 'platform_auth_users_' || replace(${table.projectId}::text, '-', '') AND ${table.authSessionsTableName} = 'platform_auth_sessions_' || replace(${table.projectId}::text, '-', '')`),
]);

export const workflowEndpoints = pgTable('workflow_endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  connectionId: uuid('connection_id').notNull().references(() => databaseConnections.id, { onDelete: 'restrict' }),
  path: varchar('path', { length: 63 }).notNull(),
  method: varchar('method', { length: 8 }).$type<'POST'>().notNull().default('POST'),
  enabled: booleanColumn('enabled').notNull().default(false),
  draftDefinition: jsonb('draft_definition').$type<WorkflowDefinition>().notNull(),
  draftRevision: integer('draft_revision').notNull().default(1),
  publishedVersionId: uuid('published_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('workflow_project_path_unique').on(table.projectId, table.path),
  check('workflow_method_valid', sql`${table.method} = 'POST'`),
  check('workflow_path_valid', sql`${table.path} ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND ${table.path} <> 'auth'`),
  check('workflow_revision_valid', sql`${table.draftRevision} > 0`),
  check('workflow_definition_size', sql`octet_length(${table.draftDefinition}::text) <= 65536`),
]);
export const workflowVersions = pgTable('workflow_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowEndpointId: uuid('workflow_endpoint_id').notNull().references(() => workflowEndpoints.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  definition: jsonb('definition').$type<WorkflowDefinition>().notNull(),
  definitionHash: varchar('definition_hash', { length: 64 }).notNull(),
  schemaDependencies: jsonb('schema_dependencies').$type<Dependency[]>().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('workflow_versions_number_unique').on(table.workflowEndpointId, table.version),
  uniqueIndex('workflow_versions_id_endpoint_unique').on(table.id, table.workflowEndpointId),
  check('workflow_version_valid', sql`${table.version} > 0 AND ${table.definitionHash} ~ '^[a-f0-9]{64}$'`),
]);
