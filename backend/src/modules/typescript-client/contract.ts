import { createHash } from 'node:crypto';
import { crud } from '../api-docs/crud.js';
import { authOperations } from '../api-docs/auth.js';
import { fieldSchema, objectSchema, uuid } from '../api-docs/schemas.js';
import type { FieldDefinition } from '../schema-builder/types.js';
import type { DocsSnapshot, JsonSchema, ApiOperation } from '../api-docs/types.js';
import { normalizeDraft, validateIdentifier } from '../schema-builder/validation.js';
import { fieldTypes } from '../../../../shared/public-contracts.js';
import { ProjectError } from '../projects/service.js';

export const generatorVersion = '1';
export const compareNames = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const unavailable = () => new ProjectError(503, 'SDK_UNAVAILABLE',
  'The deployed CRUD/auth contract is unavailable. Review applied schema, endpoints, relationships and application authentication.');
const identifier = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
// Documentation prose/examples/default values are not SDK contract provenance.
function schemaContract(schema: JsonSchema): JsonSchema {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !['description', 'default', 'example', 'examples'].includes(key))
    .map(([key, value]) => [key, key === 'properties' ? Object.fromEntries(Object.entries(value as Record<string, JsonSchema>).map(([name, property]) => [name, schemaContract(property)])) : Array.isArray(value) ? value.map((v) => typeof v === 'object' && v !== null ? schemaContract(v as JsonSchema) : v) :
      value && typeof value === 'object' ? schemaContract(value as JsonSchema) : value]));
}
export function operationContract(operation: ApiOperation) {
  return {
    policy: operation['x-access-policy'],
    input: operation.requestBody?.content['application/json']?.schema ?? null,
    query: operation['x-runtime-query'] ?? null,
    parameters: (operation.parameters ?? []).filter((p) => ['sort', 'include'].includes(p.name)).map((p) => ({ name: p.name, schema: p.schema })),
    status: Number(Object.keys(operation.responses).find((s) => s.startsWith('2'))),
  };
}
export function buildContract(snapshot: DocsSnapshot) {
  if (snapshot.blocked || !/^[a-z][a-z0-9-]{2,62}$/.test(snapshot.project.slug) ||
    (snapshot.auth?.enabled && snapshot.auth.provisioningStatus !== 'ready')) throw unavailable();
  const tables = snapshot.tables.filter((t) => t.applied).sort((a, b) => compareNames(a.name ?? '', b.name ?? ''));
  const names = new Set<string>();
  const signatures = new WeakMap<FieldDefinition[], string>();
  function signature(fields: FieldDefinition[]) {
    let value = signatures.get(fields);
    if (value === undefined) {
      value = canonical(fields.map((f) => ({ ...f, referenceName: undefined })).sort((a,b) => compareNames(a.name, b.name)));
      signatures.set(fields, value);
    }
    return value;
  }
  for (const table of tables) {
    if (!table.name || !identifier.test(table.name) || names.has(table.name) || !table.fields || table.appliedRevision === null) throw unavailable();
    try { validateIdentifier(table.name); } catch { throw unavailable(); }
    try {
      if (table.fields.some((field) => typeof field.id !== 'string' || !field.id)) throw unavailable();
      normalizeDraft({ name: table.name, fields: table.fields.map(({ position: _position, referenceName: _reference, default: value, ...field }) => ({ ...field, ...(value ? { default: value } : {}) })) }, table.fields);
    } catch { throw unavailable(); }
    names.add(table.name);
    const fields = new Set(['id']);
    for (const field of table.fields) {
      if (!identifier.test(field.name) || fields.has(field.name)) throw unavailable();
      try { validateIdentifier(field.name); } catch { throw unavailable(); }
      if (!fieldTypes.includes(field.type)) throw unavailable();
      fields.add(field.name);
      if (field.relationship && (field.type !== 'uuid' || !tables.some((target) => target.id === field.relationship!.tableId))) throw unavailable();
    }
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(table: (typeof tables)[number]) {
    if (visiting.has(table.id)) throw unavailable();
    if (visited.has(table.id)) return;
    visiting.add(table.id);
    for (const field of table.fields!) if (field.relationship) {
      const target = tables.find((candidate) => candidate.id === field.relationship!.tableId)!;
      if (target.connectionId !== table.connectionId) throw unavailable();
      visit(target);
    }
    visiting.delete(table.id); visited.add(table.id);
  }
  tables.forEach(visit);
  const resources = [...snapshot.resources].sort((a, b) => compareNames(a.name, b.name)).map((resource) => {
    const table = tables.find((t) => t.name === resource.name);
    if (!table || !resource.fields || signature(resource.fields) !==
      signature(table.fields!)) throw unavailable();
    if (new Set(resource.operations).size !== resource.operations.length || resource.operations.some((op) => !['list','get','create','update','delete'].includes(op))) throw unavailable();
    for (const policy of Object.values(resource.policies)) {
      if (!['key_only','authenticated','owner'].includes(policy.mode)) throw unavailable();
      if (policy.mode === 'owner' && !resource.fields.some((f) => f.id === policy.ownerFieldId && f.type === 'uuid' && !f.relationship)) throw unavailable();
    }
    for (const op of resource.operations) if ((resource.policies[op]?.mode ?? 'key_only') !== 'key_only' && !snapshot.auth?.enabled) throw unavailable();
    if (new Set((resource.includes ?? []).map((i) => i.name)).size !== (resource.includes ?? []).length) throw unavailable();
    for (const include of resource.includes ?? []) {
      const field = resource.fields.find((f) => f.name === include.name);
      const target = tables.find((t) => t.id === field?.relationship?.tableId);
      if (!target || target.name !== include.referenceName || signature(include.fields) !== signature(target.fields!)) throw unavailable();
    }
    const operations = crud({ ...resource, includes: [...(resource.includes ?? [])].sort((a,b) => compareNames(a.name, b.name)) }, { compact: true }).map((item) => {
      const name = item.operation.operationId.slice(`crud_${resource.name}_`.length);
      const policy = resource.policies[name as keyof typeof resource.policies];
      return { name, ...operationContract(item.operation), ...(policy?.mode === 'owner' ? { ownership: { field: resource.fields!.find((f) => f.id === policy.ownerFieldId)!.name, allowAdmin: policy.allowAdmin } } : {}) };
    });
    const omitted = operations.filter((o) => o.name === 'update' && !Object.keys(o.input?.properties ?? {}).length).map((o) => o.name);
    return { name: resource.name, operations: operations.filter((o) => !omitted.includes(o.name)), omitted,
      relations: (resource.includes ?? []).map((i) => ({ name: i.name, target: i.referenceName })).sort((a,b) => compareNames(a.name, b.name)) };
  });
  if (new Set(resources.map((r) => r.name)).size !== resources.length) throw unavailable();
  const rows = tables.map((t) => ({ name: t.name!, schema: objectSchema({ id: uuid,
    ...Object.fromEntries([...t.fields!].sort((a,b) => compareNames(a.name, b.name)).map((f) => [f.name, fieldSchema(f)])) }, ['id', ...t.fields!.map((f) => f.name).sort()]) }));
  const auth = snapshot.auth?.enabled ? authOperations(snapshot.auth).map((item) => ({ name: item.path.slice(6), ...operationContract(item.operation),
    output: item.operation.responses[Object.keys(item.operation.responses).find((s) => s.startsWith('2'))!]?.content?.['application/json']?.schema ?? null })) : [];
  const contract = schemaContract({ rows, resources, auth });
  const hash = createHash('sha256').update(canonical(contract)).digest('hex');
  return { rows, resources, auth, hash, tableRevisions: Object.fromEntries(tables.map((t) => [t.name!, t.appliedRevision!])) };
}
export type ClientContract = ReturnType<typeof buildContract>;
