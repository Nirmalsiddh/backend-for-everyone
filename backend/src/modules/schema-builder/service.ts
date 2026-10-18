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
    );
    return {
      planHash: plan.hash,
      draftRevision: plan.revision,
      operation: plan.operation,
      sql: plan.statements.join('\n'),
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
    const plan = generatePlan(table);
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
      catalog = await this.executor(config, plan, table.appliedDefinition);
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
      // The durable applying record blocks retries even if the platform is unavailable.
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
