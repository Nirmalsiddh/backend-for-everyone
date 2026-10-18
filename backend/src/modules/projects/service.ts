import type { CreateProjectInput, ProjectRepository } from './types.js';

export class ProjectError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  async list(ownerId: string, limit: number, offset: number) {
    const rows = await this.repository.listOwned(ownerId, limit + 1, offset);
    return {
      items: rows.slice(0, limit),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }

  create(ownerId: string, input: CreateProjectInput) {
    return this.repository.create(ownerId, {
      ...input,
      name: input.name.trim(),
    });
  }

  async getById(ownerId: string, id: string) {
    const project = await this.repository.findOwnedById(id, ownerId);
    if (!project)
      throw new ProjectError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    return project;
  }
}
