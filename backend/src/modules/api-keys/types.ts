export type KeyScope = 'read' | 'read_write';
export interface ApiKeyMetadata {
  id: string; projectId: string; name: string; keyPrefix: string; scope: KeyScope; createdAt: Date; revokedAt: Date | null;
}
export interface ApiKeyRecord extends ApiKeyMetadata { keyHash: string }
export interface ApiKeyRepository {
  create(projectId: string, ownerId: string, key: ApiKeyRecord): Promise<ApiKeyMetadata>;
  list(projectId: string, ownerId: string): Promise<ApiKeyMetadata[]>;
  revoke(projectId: string, ownerId: string, keyId: string): Promise<void>;
}
