import type { FieldDefinition } from '../schema-builder/types.js';
import type { Operation, OperationPolicy } from '../endpoints/types.js';
import type { Dependency, WorkflowDefinition } from '../workflows/types.js';
export type {
  JsonSchema,
  ApiOperation,
  OpenApiDocument,
  ApiResponse,
} from '../../../../shared/openapi.js';
export interface DocsSnapshot {
  project: { slug: string };
  blocked: boolean;
  resources: {
    name: string;
    relationshipDelete?: boolean;
    includes?: { name: string; referenceName: string; fields: FieldDefinition[]; policy: OperationPolicy }[];
    fields: FieldDefinition[] | null;
    operations: Operation[];
    policies: Partial<Record<Operation, OperationPolicy>>;
  }[];
  auth?: {
    enabled: boolean;
    signupEnabled: boolean;
    provisioningStatus: string;
    sessionLifetimeSeconds: number;
  };
  workflows: {
    path: string;
    definition: WorkflowDefinition | null;
    dependencies: Dependency[];
  }[];
  tables: {
    id: string;
    name?: string;
    connectionId?: string;
    appliedRevision: number | null;
    applied: boolean;
    fields?: FieldDefinition[] | null;
  }[];
}
export interface DocsRepository {
  snapshot(
    projectId: string,
    ownerId: string,
    scope?: { workflows: boolean },
  ): Promise<DocsSnapshot | undefined>;
}
