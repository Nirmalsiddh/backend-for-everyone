export interface Project {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  runtimeState?: string;
  createdAt: Date;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
}

export interface ProjectRepository {
  listOwned(ownerId: string, limit: number, offset: number): Promise<Project[]>;
  create(ownerId: string, input: CreateProjectInput): Promise<Project>;
  findOwnedById(id: string, ownerId: string): Promise<Project | undefined>;
}
