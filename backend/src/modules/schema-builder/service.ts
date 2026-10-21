import { v4Preview } from './evolution-v4.js';
import { inspectReferenceTargets } from '../../database/customer-db/reference-targets.js';
import { DestinationError } from '../../security/customer-destination.js';
import { schemaTableDto } from './dto.js';
import type { ConnectionRepository } from '../database-connections/types.js';
import { CredentialEncryption } from '../../security/encryption.js';
import type { ConnectionConfig } from '../database-connections/types.js';
import { conflict, SchemaError } from './errors.js';
import { generatePlan } from './plan.js';
import { normalizeDraft } from './validation.js';
import type { DraftInput, SchemaExecutor, SchemaRepository } from './types.js';

export class SchemaService {
  constructor(
    private readonly repository: SchemaRepository,
    private readonly connections: ConnectionRepository,
    private readonly encryption: CredentialEncryption,
    private readonly executor: SchemaExecutor,
  ) {}
  async list(projectId: string, ownerId: string) {
    return (await this.repository.list(projectId, ownerId)).map(schemaTableDto);
  }
  async targets(projectId: string, ownerId: string) {
    const tables = await this.repository.list(projectId, ownerId);
    if (
      tables.some((t) =>
        ['applying', 'outcome_unknown'].includes(t.applyStatus?.status ?? ''),
      )
    )
      throw conflict(
        'Resolve schema operations before checking reference targets',
      );
    const connection = await this.connections.findOwned(projectId, ownerId);
    if (!connection) throw conflict('A saved database connection is required');
    const config = this.encryption.decrypt<ConnectionConfig>(
      connection,
      `${connection.projectId}:${connection.id}`,
    );
    return inspectReferenceTargets(
      config,
      tables.filter((t) => t.connectionId === connection.id),
    );
  }
  async get(projectId: string, ownerId: string, tableId: string) {
    return schemaTableDto(
      await this.repository.get(projectId, ownerId, tableId),
    );
  }
  async create(projectId: string, ownerId: string, input: DraftInput) {
    const connection = await this.connections.findOwned(projectId, ownerId);
    if (!connection) {
      await this.repository.list(projectId, ownerId);
      throw conflict('A saved database connection is required');
    }
    normalizeDraft(input);
    const config = this.encryption.decrypt<ConnectionConfig>(
      connection,
      `${connection.projectId}:${connection.id}`,
    );
    return schemaTableDto(
      await this.repository.create(projectId, ownerId, input, {
        connectionId: connection.id,
        encryptedConfig: connection.encryptedConfig,
        schemaName: config.schema,
      }),
    );
  }
  async update(
    projectId: string,
    ownerId: string,
    tableId: string,
    revision: number,
    input: DraftInput,
  ) {
    return schemaTableDto(
      await this.repository.update(
        projectId,
        ownerId,
        tableId,
        revision,
        input,
      ),
    );
  }
  delete(projectId: string, ownerId: string, tableId: string) {
    return this.repository.delete(projectId, ownerId, tableId);
  }
  async preview(projectId: string, ownerId: string, tableId: string) {
    const plan = generatePlan(
      await this.repository.get(projectId, ownerId, tableId),
      await this.repository.list(projectId, ownerId),
    );
    if (plan.dependencies?.length) {
      const connection = await this.connections.findOwned(projectId, ownerId);
      if (!connection) throw conflict('Database connection is unavailable');
      const config = this.encryption.decrypt<ConnectionConfig>(
        connection,
        `${connection.projectId}:${connection.id}`,
      );
      await inspectReferenceTargets(
        config,
        plan.managedTables ?? [],
        plan.dependencies.map((d) => d.tableId),
      );
    }
    return {
      planHash: plan.hash,
      draftRevision: plan.revision,
      operation: plan.operation,
      ...(plan.version === 4 ? { version: 4, actions: v4Preview(plan) } : plan.evolution ? { actions: plan.evolution.actions.map((action) => action.kind === 'set_not_null' ? { kind: action.kind, field: plan.definition.fields.find((field) => field.id === action.fieldId)!.name } : { kind: action.kind, fields: action.index.fieldIds.map((id) => plan.definition.fields.find((field) => field.id === id)!.name) }) } : {}),
      relationships: plan.definition.fields
        .filter((f) => f.relationship)
        .map((f) => ({
          field: f.name,
          target: plan.dependencies!.find(
            (d) => d.tableId === f.relationship!.tableId,
          )!.definition.name,
          nullable: f.nullable,
        })),
      sql: plan.version === 4 ? '' : plan.statements.join('\n'),
    };
  }
  async apply(
    projectId: string,
    ownerId: string,
    tableId: string,
    revision: number,
    hash: string,
  ) {
    const table = await this.repository.get(projectId, ownerId, tableId);
    const plan = generatePlan(
      table,
      await this.repository.list(projectId, ownerId),
    );
    if (revision !== plan.revision || hash !== plan.hash)
      throw conflict('Draft revision or preview plan changed');
    const connection = await this.connections.findOwned(projectId, ownerId);
    if (!connection || connection.id !== table.connectionId)
      throw conflict('Database connection changed');
    const config = this.encryption.decrypt<ConnectionConfig>(
      connection,
      `${connection.projectId}:${connection.id}`,
    );
    if (config.schema !== table.schemaName)
      throw conflict('Database target changed');
    const migrationId = await this.repository.begin(
      projectId,
      ownerId,
      tableId,
      plan,
    );
    let catalog: unknown;
    try {
      catalog = await this.executor(
        config,
        { ...plan, receipt: { projectId, operationId: migrationId } },
        table.appliedDefinition,
      );
    } catch (error) {
      const safe =
        error instanceof DestinationError
          ? new SchemaError(error.statusCode, error.code, error.message)
          : error instanceof SchemaError
            ? error
            : new SchemaError(
                422,
                'SCHEMA_APPLY_FAILED',
                'Customer schema operation failed',
              );
      const status =
        safe.code === 'SCHEMA_OUTCOME_UNKNOWN' ? 'outcome_unknown' : 'failed';
      await this.repository.finish(
        projectId,
        ownerId,
        tableId,
        migrationId,
        plan,
        status,
        null,
        safe.code,
      );
      throw new SchemaError(
        safe.statusCode,
        safe.code,
        `${safe.message}; migration ${migrationId}`,
      );
    }
    try {
      await this.repository.finish(
        projectId,
        ownerId,
        tableId,
        migrationId,
        plan,
        'applied',
        catalog,
        null,
      );
    } catch {
      if (plan.version === 4) await this.repository.finish(
        projectId, ownerId, tableId, migrationId, plan, 'outcome_unknown', null, 'SCHEMA_OUTCOME_UNKNOWN',
      ).catch(() => {});
      // If the platform is unavailable, the durable applying record still blocks retries.
      throw new SchemaError(
        503,
        'SCHEMA_OUTCOME_UNKNOWN',
        `Customer commit succeeded but metadata finalization failed; reconcile migration ${migrationId}`,
      );
    }
    return {
      migrationId,
      status: 'applied',
      table: schemaTableDto(
        await this.repository.get(projectId, ownerId, tableId),
      ),
    };
  }
}
