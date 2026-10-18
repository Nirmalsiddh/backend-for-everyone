import { previewWorkflow } from './validation.js';
import type {
  WorkflowDefinition,
  WorkflowRepository,
  WorkflowEndpoint,
} from './types.js';
function dto(w: WorkflowEndpoint) {
  return {
    id: w.id,
    path: w.path,
    enabled: w.enabled,
    draftDefinition: w.draftDefinition,
    draftRevision: w.draftRevision,
    publishedVersionId: w.publishedVersionId,
    publishedDefinition: w.publishedDefinition ?? null,
  };
}
export class WorkflowService {
  constructor(private readonly repository: WorkflowRepository) {}
  async create(
    projectId: string,
    ownerId: string,
    path: string,
    definition: WorkflowDefinition,
  ) {
    return dto(
      await this.repository.create(projectId, ownerId, path, definition),
    );
  }
  async list(projectId: string, ownerId: string) {
    return Promise.all(
      (await this.repository.list(projectId, ownerId)).map((w) =>
        this.get(projectId, ownerId, w.id),
      ),
    );
  }
  async get(projectId: string, ownerId: string, id: string) {
    const w = await this.repository.get(projectId, ownerId, id);
    const tables = await this.repository.tables(projectId, ownerId);
    const stale = (w.publishedDependencies ?? []).some(
      (d) =>
        !tables.some(
          (t) => t.id === d.tableId && t.appliedRevision === d.appliedRevision,
        ),
    );
    const reasons = [
      ...(stale
        ? ['Applied schema changed; preview and republish this workflow']
        : []),
      ...(w.managementBlocked
        ? ['Schema apply is active or requires operator review']
        : []),
    ];
    return {
      ...dto(w),
      readiness: {
        state: !w.publishedVersionId
          ? 'unpublished'
          : reasons.length
            ? 'blocked'
            : w.enabled
              ? 'enabled'
              : 'disabled',
        reasons,
      },
    };
  }
  async edit(
    projectId: string,
    ownerId: string,
    id: string,
    revision: number,
    definition: WorkflowDefinition,
  ) {
    return dto(
      await this.repository.edit(projectId, ownerId, id, revision, definition),
    );
  }
  async toggle(
    projectId: string,
    ownerId: string,
    id: string,
    revision: number,
    enabled: boolean,
  ) {
    return dto(
      await this.repository.toggle(projectId, ownerId, id, revision, enabled),
    );
  }
  async preview(projectId: string, ownerId: string, id: string) {
    const workflow = await this.repository.get(projectId, ownerId, id);
    const preview = previewWorkflow(
      workflow.draftDefinition,
      workflow.draftRevision,
      await this.repository.tables(projectId, ownerId),
      workflow.connectionId,
    );
    return {
      ...preview,
      operations: preview.operations.map(
        ({ sqlTemplate: _sql, ...operation }) => operation,
      ),
    };
  }
  publish(
    projectId: string,
    ownerId: string,
    id: string,
    revision: number,
    hash: string,
  ) {
    return this.repository.publish(projectId, ownerId, id, revision, hash);
  }
}
