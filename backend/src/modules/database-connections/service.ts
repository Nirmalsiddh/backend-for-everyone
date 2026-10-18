import { randomUUID } from 'node:crypto';
import type { ProjectService } from '../projects/service.js';
import { CredentialEncryption } from '../../security/encryption.js';
import { ConnectionError } from './errors.js';
import type {
  ConnectionConfig,
  ConnectionInput,
  ConnectionRecord,
  ConnectionRepository,
  ConnectionTester,
} from './types.js';

function publicMetadata(record: ConnectionRecord) {
  return {
    id: record.id,
    projectId: record.projectId,
    label: record.label,
    lastTestStatus: record.lastTestStatus,
    lastTestedAt: record.lastTestedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const missing = () =>
  new ConnectionError(
    404,
    'CONNECTION_NOT_FOUND',
    'Database connection not found',
  );
const changed = () =>
  new ConnectionError(
    409,
    'CONNECTION_CHANGED',
    'Database connection changed; retry the operation',
  );

export class ConnectionService {
  constructor(
    private readonly projects: ProjectService,
    private readonly repository: ConnectionRepository,
    private readonly encryption: CredentialEncryption,
    private readonly tester: ConnectionTester,
  ) {}

  private async owned(projectId: string, ownerId: string) {
    const project = await this.projects.getById(ownerId, projectId);
    return project.id;
  }

  private async required(projectId: string, ownerId: string) {
    const canonicalId = await this.owned(projectId, ownerId);
    const record = await this.repository.findOwned(canonicalId, ownerId);
    if (!record) throw missing();
    return record;
  }

  async get(projectId: string, ownerId: string) {
    const record = await this.required(projectId, ownerId);
    const config = this.encryption.decrypt<ConnectionConfig>(
      record,
      `${record.projectId}:${record.id}`,
    );
    const { host, port, database, username, schema, ssl } = config;
    return {
      ...publicMetadata(record),
      identity: { host, port, database, username, schema, ssl },
      replacement: (await this.repository.replacementStatus?.(
        projectId,
        ownerId,
      )) ?? { eligible: true, blockers: [] },
    };
  }

  async save(
    projectId: string,
    ownerId: string,
    input: ConnectionInput,
    replace: boolean,
  ) {
    const canonicalId = await this.owned(projectId, ownerId);
    const existing = await this.repository.findOwned(canonicalId, ownerId);
    if (replace && !existing) throw missing();
    if (!replace && existing) {
      throw new ConnectionError(
        409,
        'CONNECTION_EXISTS',
        'Project already has a database connection',
      );
    }
    const { label, ...config } = input;
    // No platform writes until the candidate credentials pass both checks.
    await this.tester(config);
    const id = existing?.id ?? randomUUID();
    const now = new Date();
    const record: ConnectionRecord = {
      id,
      projectId: canonicalId,
      label: label.trim(),
      ...this.encryption.encrypt(config, `${canonicalId}:${id}`),
      lastTestStatus: 'success',
      lastTestedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (replace && existing) {
      const saved = await this.repository.replace(
        record,
        ownerId,
        existing.encryptedConfig,
      );
      if (!saved) throw changed();
      return publicMetadata(saved);
    }
    return publicMetadata(await this.repository.create(record, ownerId));
  }

  async test(projectId: string, ownerId: string) {
    const record = await this.required(projectId, ownerId);
    const config = this.encryption.decrypt<ConnectionConfig>(
      record,
      `${record.projectId}:${record.id}`,
    );
    try {
      await this.tester(config);
    } catch (error) {
      // Match the encrypted configuration so a stale test cannot mark replacement credentials failed.
      await this.repository.markTest(record, ownerId, 'failed', new Date());
      throw error;
    }
    const saved = await this.repository.markTest(
      record,
      ownerId,
      'success',
      new Date(),
    );
    if (!saved) throw changed();
    return publicMetadata(saved);
  }

  async delete(projectId: string, ownerId: string) {
    const canonicalId = await this.owned(projectId, ownerId);
    if (!(await this.repository.deleteOwned(canonicalId, ownerId)))
      throw missing();
  }
}
