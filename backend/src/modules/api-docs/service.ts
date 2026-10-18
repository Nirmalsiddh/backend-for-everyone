import { ProjectError } from '../projects/service.js';
import type { DocsRepository, DocsSnapshot, OpenApiDocument } from './types.js';
import { crud } from './crud.js';
import { authOperations } from './auth.js';
import { workflow } from './workflows.js';
import { errorSchema, uuid } from './schemas.js';
export const unavailable = () =>
  new ProjectError(
    503,
    'API_DOCS_UNAVAILABLE',
    'Deployed API metadata is temporarily unavailable; review deployment state and published workflows.',
  );
export function generate(
  snapshot: DocsSnapshot,
  origin: string,
): OpenApiDocument {
  if (
    snapshot.blocked ||
    snapshot.resources.some(
      (r) =>
        r.operations.length &&
        (!r.fields || /^(platform_|internal_|pg_|schema_)/.test(r.name)),
    ) ||
    (snapshot.auth?.enabled && snapshot.auth.provisioningStatus !== 'ready')
  )
    throw unavailable();
  for (const r of snapshot.resources.filter((r) => r.operations.length))
    for (const p of Object.values(r.policies))
      if (
        p.mode === 'owner' &&
        !r.fields?.some((f) => f.id === p.ownerFieldId && f.type === 'uuid')
      )
        throw unavailable();
  for (const w of snapshot.workflows)
    if (
      !w.definition ||
      w.dependencies.some(
        (d) =>
          !snapshot.tables.some(
            (t) =>
              t.id === d.tableId &&
              t.applied &&
              t.appliedRevision === d.appliedRevision,
          ),
      )
    )
      throw unavailable();
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: `${snapshot.project.slug} API`,
      version: '1.0.0',
      description:
        'Generated deployed runtime contract. Database availability is checked at request time. Dashboard sign-in does not authenticate runtime calls.',
    },
    servers: [{ url: `${origin}/api/${snapshot.project.slug}` }],
    paths: {},
    components: {
      schemas: { RuntimeError: errorSchema, UUID: uuid },
      securitySchemes: {
        ApplicationSession: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Opaque application session',
          description:
            'Authorization: Bearer <application-session-token>. Obtained from application login.',
        },
        ProjectApiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Opaque project API key',
          description:
            'Authorization: Bearer <project-api-key>. Read or read_write scope is enforced per operation.',
        },
      },
    },
  };
  const operations = [
    ...snapshot.resources.filter((r) => r.operations.length).flatMap(crud),
    ...(snapshot.auth?.enabled ? authOperations(snapshot.auth) : []),
    ...snapshot.workflows.map((w) => workflow(w.path, w.definition!)),
  ].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  const ids = new Set<string>();
  for (const item of operations) {
    if (
      ids.has(item.operation.operationId) ||
      doc.paths[item.path]?.[item.method]
    )
      throw unavailable();
    ids.add(item.operation.operationId);
    (doc.paths[item.path] ??= {})[item.method] = item.operation;
  }
  return doc;
}
export class DocsService {
  constructor(
    private readonly repository: DocsRepository,
    private readonly origin: string,
  ) {}
  async get(projectId: string, ownerId: string) {
    const snapshot = await this.repository.snapshot(projectId, ownerId);
    if (!snapshot)
      throw new ProjectError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    return generate(snapshot, this.origin);
  }
}
