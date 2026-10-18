import type { EncryptedPayload } from '../../security/encryption.js';

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  schema: string;
  ssl: boolean;
}

export interface ConnectionInput extends ConnectionConfig {
  label: string;
}

export type TestStatus = 'success' | 'failed';

export interface ConnectionRecord extends EncryptedPayload {
  id: string;
  projectId: string;
  label: string;
  lastTestStatus: TestStatus;
  lastTestedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ConnectionTester = (config: ConnectionConfig) => Promise<void>;

export interface ConnectionRepository {
  replacementStatus?(
    projectId: string,
    ownerId: string,
  ): Promise<{ eligible: boolean; blockers: string[] }>;
  findOwned(
    projectId: string,
    ownerId: string,
  ): Promise<ConnectionRecord | undefined>;
  create(record: ConnectionRecord, ownerId: string): Promise<ConnectionRecord>;
  replace(
    record: ConnectionRecord,
    ownerId: string,
    expectedConfig: string,
  ): Promise<ConnectionRecord | undefined>;
  markTest(
    record: ConnectionRecord,
    ownerId: string,
    status: TestStatus,
    at: Date,
  ): Promise<ConnectionRecord | undefined>;
  deleteOwned(projectId: string, ownerId: string): Promise<boolean>;
}
