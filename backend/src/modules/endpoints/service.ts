import { invalid } from '../schema-builder/errors.js';
import { operations, type EndpointInput, type EndpointRepository } from './types.js';
export class EndpointService {
  constructor(private readonly repository: EndpointRepository) {}
  list(projectId: string, ownerId: string) { return this.repository.list(projectId, ownerId); }
  get(projectId: string, ownerId: string, tableId: string) { return this.repository.get(projectId, ownerId, tableId); }
  save(projectId: string, ownerId: string, tableId: string, input: EndpointInput) {
    if (new Set(input.enabledOperations).size !== input.enabledOperations.length || input.enabledOperations.some((op) => !operations.includes(op))) throw invalid('Invalid enabled operations');
    return this.repository.save(projectId, ownerId, tableId, input);
  }
}
