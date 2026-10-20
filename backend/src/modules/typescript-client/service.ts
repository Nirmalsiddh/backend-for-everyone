import type { DocsRepository } from '../api-docs/types.js';
import { ProjectError } from '../projects/service.js';
import { buildContract, generatorVersion } from './contract.js';
import { render } from './render.js';
export class TypeScriptClientService {
  constructor(private readonly repository: DocsRepository) {}
  async get(projectId: string, ownerId: string) {
    const snapshot = await this.repository.snapshot(projectId, ownerId, { workflows: false });
    if (!snapshot) throw new ProjectError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    const contract = buildContract(snapshot);
    return { filename: `${snapshot.project.slug}-client.ts`, generatorVersion,
      contractHash: contract.hash, tableRevisions: contract.tableRevisions, source: render(contract) };
  }
}
