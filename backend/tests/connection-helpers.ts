import type { ConnectionRecord, ConnectionRepository } from '../src/modules/database-connections/types.js';
import type { ProjectRepository } from '../src/modules/projects/types.js';
import { ConnectionError } from '../src/modules/database-connections/errors.js';

export const connectionInput = {
  label: 'Customer database', host: 'db.example.test', port: 5432,
  database: 'customer', username: 'customer_user', password: 'private-customer-password',
  schema: 'public', ssl: true,
};

export function memoryConnectionRepository(projects: ProjectRepository): ConnectionRepository {
  const rows = new Map<string, ConnectionRecord>();
  const owned = async (id: string, owner: string) => !!await projects.findOwnedById(id, owner);
  return {
    async findOwned(projectId, ownerId) {
      return await owned(projectId, ownerId) ? rows.get(projectId) : undefined;
    },
    async create(record, ownerId) {
      if (!await owned(record.projectId, ownerId)) throw new Error('Forbidden');
      if (rows.has(record.projectId)) throw new ConnectionError(409, 'CONNECTION_EXISTS', 'Project already has a database connection');
      rows.set(record.projectId, structuredClone(record));
      return record;
    },
    async replace(record, ownerId, expectedConfig) {
      const old = rows.get(record.projectId);
      if (!await owned(record.projectId, ownerId) || old?.encryptedConfig !== expectedConfig) return undefined;
      rows.set(record.projectId, structuredClone(record));
      return record;
    },
    async markTest(record, ownerId, status, at) {
      const old = rows.get(record.projectId);
      if (!await owned(record.projectId, ownerId) || old?.encryptedConfig !== record.encryptedConfig) return undefined;
      const updated = { ...old, lastTestStatus: status, lastTestedAt: at, updatedAt: at };
      rows.set(record.projectId, updated);
      return updated;
    },
    async deleteOwned(projectId, ownerId) {
      return await owned(projectId, ownerId) && rows.delete(projectId);
    },
  };
}
