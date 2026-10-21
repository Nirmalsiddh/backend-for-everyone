import type { AuthService } from '../modules/project-auth/service.js';
import { parseInclude, invalidInclude, includeUnavailable, metadataChanged } from './include.js';
import { authorizeRead, ownerColumn } from './authorization.js';
import { CredentialEncryption } from '../security/encryption.js';
import type { ConnectionConfig } from '../modules/database-connections/types.js';
import { hashKey } from '../modules/api-keys/service.js';
import type { Operation } from '../modules/endpoints/types.js';
import type { RuntimeExecutor, RuntimePrincipal, RuntimeRepository } from './types.js';
import { badRequest, notFound, RuntimeError, unauthorized, unavailable } from './errors.js';
import { validateBody, validateId, validateList } from './validation.js';
import { deleteRow, insertRow, selectById, selectList, serializeRow, updateRow } from './queries.js';
export class RuntimeService {
  constructor(private readonly repository: RuntimeRepository, private readonly encryption: CredentialEncryption, private readonly executor: RuntimeExecutor, private readonly auth?: AuthService) {}
  async authenticate(slug: string, authorization: string | undefined) {
    if (authorization?.startsWith('Bearer us_') && this.auth) return this.auth.authenticate(slug, authorization);
    const match = /^Bearer (pk_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!match) throw unauthorized();
    const identity = await this.repository.authenticate(slug, hashKey(match[1]!));
    if (!identity) throw unauthorized();
    return identity;
  }
  async execute(identity: RuntimePrincipal, resource: string, operation: Operation, id: string | undefined, body: unknown,
    query: Record<string, unknown>, onTarget: (endpointId: string, resource: string) => void = () => {}) {
    const includes = parseInclude(query);
    if (includes.length && !['get', 'list'].includes(operation)) throw invalidInclude();
    const ordinaryQuery = { ...query };
    delete ordinaryQuery.include;
    const isUser = 'kind' in identity && identity.kind === 'user';
    if ('scope' in identity && identity.scope === 'read' && !['list', 'get'].includes(operation)) throw new RuntimeError(403, 'INSUFFICIENT_SCOPE', 'API key does not permit writes');
    const target = await this.repository.resolve(identity.projectId, resource, includes);
    if (!target || !target.enabledOperations.includes(operation)) {
      if (includes.length) throw invalidInclude();
      throw notFound();
    }
    onTarget(target.endpointId, target.resourceName ?? target.applied?.definition.name ?? 'unresolved');
    if (target.blocked || !target.applied) throw unavailable();
    const definition = target.applied.definition;
    if (/^(platform_|internal_|pg_|schema_)/.test(definition.name)) throw notFound();
    const policy = target.policies?.[operation] ?? { mode: 'key_only' as const };
    const authorization = authorizeRead(definition, policy, identity);
    if (!authorization.compatible) throw unauthorized();
    const owner = ownerColumn(definition, policy);
    const ownership = authorization.ownership;
    if (isUser && identity.context.connection.id !== target.connection.id) throw unavailable();
    if (operation === 'update' && body && typeof body === 'object' && !Array.isArray(body)) {
      const protectedColumns = Object.values(target.policies ?? {}).map((candidate) => ownerColumn(definition, candidate)).filter((name): name is string => !!name);
      if (protectedColumns.some((name) => Object.hasOwn(body, name))) throw badRequest();
    }
    let input = body;
    if (owner && ['create', 'update'].includes(operation) && body && typeof body === 'object' && !Array.isArray(body)) {
      if (Object.hasOwn(body, owner)) throw badRequest();
      if (operation === 'create' && isUser) input = { ...body, [owner]: identity.userId };
    }
    if (operation !== 'list' && Object.keys(ordinaryQuery).length) throw badRequest();
    if (['get', 'update', 'delete'].includes(operation)) validateId(id ?? '');
    if (['list', 'get', 'delete'].includes(operation) && body !== undefined) throw badRequest();
    const list = operation === 'list' ? validateList(definition, ordinaryQuery) : undefined;
    const validated = ['create', 'update'].includes(operation) ? validateBody(definition, input, operation === 'create') : undefined;
    const compiled = operation === 'list' ? selectList(definition, list!, ownership) : operation === 'get' ? selectById(definition, id!, ownership)
      : operation === 'create' ? insertRow(definition, validated!) : operation === 'update' ? updateRow(definition, id!, validated!, ownership) : deleteRow(definition, id!, ownership);
    const expandedIncludes = includes.map((name) => {
      const field = definition.fields.find((candidate) => candidate.name === name);
      if (!field?.relationship || field.type !== 'uuid') throw invalidInclude();
      const related = target.relatedTargets?.[field.relationship.tableId];
      if (!related || !related.applied || related.blocked ||
          related.projectId !== target.projectId || related.connection.id !== target.connection.id ||
          !related.enabledOperations.includes('get')) throw includeUnavailable();
      if (/^(platform_|internal_|pg_|schema_)/.test(related.applied.definition.name) ||
          related.applied.definition.schema !== definition.schema) throw unavailable();
      const authorization = authorizeRead(related.applied.definition, related.policies?.get ?? { mode: 'key_only' }, identity);
      if (!authorization.compatible) throw includeUnavailable();
      return { name, applied: related.applied, ownership: authorization.ownership };
    });
    const expansion = includes.length ? {
      includes: expandedIncludes, limit: list?.limit,
      fence: async () => {
        try {
          const current = await this.repository.resolve(identity.projectId, resource, includes);
          if (!target.fingerprint || current?.fingerprint !== target.fingerprint) throw metadataChanged();
        } catch { throw metadataChanged(); }
      },
    } : undefined;
    const connection = target.connection;
    const config = this.encryption.decrypt<ConnectionConfig>(connection, `${connection.projectId}:${connection.id}`);
    if (config.schema !== definition.schema) throw unavailable();
    const rows = await this.executor(config, target.applied, compiled, isUser ? { context: identity.context, tokenHash: identity.tokenHash, userId: identity.userId, role: identity.role } : undefined, expansion);
    if (list) return { body: { data: rows.slice(0, list.limit).map((row) => ({ ...serializeRow(definition, row), ...(expansion ? { _related: row._related } : {}) })),
      pagination: { limit: list.limit, offset: list.offset, hasMore: rows.length > list.limit } }, rowCount: Math.min(rows.length, list.limit) };
    if (!rows[0]) throw notFound();
    return { body: operation === 'delete' ? undefined : { ...serializeRow(definition, rows[0]), ...(expansion ? { _related: rows[0]._related } : {}) }, rowCount: 1 };
  }
}
