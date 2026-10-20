import { runtimeQuerySerializerSource } from '../../../../shared/runtime-query.js';
import type { JsonSchema } from '../api-docs/types.js';
import { generatorVersion, canonical, compareNames, type ClientContract } from './contract.js';
import { runtimeTemplate } from './runtime-template.js';
const literal = (value: unknown) => JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
export function typeOf(schema: JsonSchema, read = false): string {
  if (schema.anyOf) return schema.anyOf.map((s) => typeOf(s, read)).join(' | ');
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.map((type) => typeOf({ ...schema, type }, read)).join(' | ');
  if (schema.type === 'null') return 'null';
  if (schema.type === 'string') return 'string';
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') return `Array<${typeOf(schema.items!, read)}>`;
  if (schema.type === 'object') {
    const properties = Object.entries(schema.properties ?? {}).sort(([a],[b]) => compareNames(a, b));
    if (!properties.length) return 'Record<string, never>';
    return `{\n${properties.map(([name, property]) => `  ${literal(name)}${schema.required?.includes(name) ? '' : '?'}: ${typeOf(property, read)};`).join('\n')}\n}`;
  }
  return !read && schema.not ? 'Exclude<JsonValue, null>' : 'JsonValue';
}
export function render(contract: ClientContract) {
  const lines = ['/**\n * Generated TypeScript runtime client. Do not edit manually.\n * Requires ES2022 and standard web fetch/URL typings. No retries or token storage.\n */',
    `export const SDK_GENERATOR_VERSION = ${literal(generatorVersion)};`,
    `export const SDK_CONTRACT_HASH = ${literal(contract.hash)};`,
    `export const SDK_TABLE_REVISIONS = ${canonical(contract.tableRevisions)} as const;`,
    `export const SDK_OMITTED_OPERATIONS = ${literal(contract.resources.flatMap((r) => r.omitted.map((operation) => ({ resource: r.name, operation, reason: 'NO_WRITABLE_FIELDS' }))))} as const;`,
    runtimeTemplate, runtimeQuerySerializerSource()];
  for (const row of contract.rows) lines.push(`export type Row_${row.name} = ${typeOf(row.schema, true)};`);
  for (const resource of contract.resources) {
    const availableIncludes = new Set(resource.operations.flatMap((o) => o.parameters.find((p) => p.name === 'include')?.schema.items?.enum as string[] ?? []));
    const related = resource.relations.filter((r) => availableIncludes.has(r.name));
    lines.push(`export type Read_${resource.name} = Row_${resource.name}${related.length ? ` & { "_related"?: { ${related.map((r) => `${literal(r.name)}?: Row_${r.target} | null;`).join(' ')} } }` : ''};`);
    for (const op of resource.operations) {
      if (op.input) lines.push(`export type ${op.name === 'create' ? 'Create' : 'Update'}_${resource.name} = ${op.name === 'update' ? `AtLeastOne<${typeOf(op.input)}>` : typeOf(op.input)};`);
      if (op.name === 'list') {
        lines.push(`export type Filter_${resource.name} = {\n${op.query!.fields.map((f) => {
          const valueType = f.type === 'integer' ? 'number' : f.type === 'boolean' ? 'boolean' : 'string';
          return `  ${literal(f.name)}?: { ${f.operators.map((operator) => `${operator}?: ${operator === 'is_null' ? 'boolean' : operator === 'in' ? `${valueType}[]` : valueType};`).join(' ')} };`;
        }).join('\n')}\n};`);
      }
      if (op.name === 'list' || op.name === 'get') {
        const includes = op.parameters.find((p) => p.name === 'include')?.schema.items?.enum as string[] | undefined;
        const sort = op.parameters.find((p) => p.name === 'sort')?.schema.enum as string[] | undefined;
        if (op.name === 'get' && !includes?.length) {
          lines.push(`export type Get_${resource.name} = Record<string, never>;`);
          continue;
        }
        lines.push(`export interface ${op.name === 'list' ? 'List' : 'Get'}_${resource.name} { ${op.name === 'list' ? `filter?: Filter_${resource.name}; limit?: number; offset?: number; sort?: ${sort!.map(literal).join(' | ')}; direction?: 'asc' | 'desc';` : ''} ${includes?.length ? `include?: (${includes.map(literal).join(' | ')})[];` : ''} }`);
      }
    }
  }
  for (const auth of contract.auth) {
    if (auth.input) lines.push(`export type Auth_${auth.name}_Input = ${typeOf(auth.input)};`);
    if (auth.output) lines.push(`export type Auth_${auth.name}_Result = ${typeOf(auth.output, true)};`);
  }
  lines.push('export function createClient(config: ClientConfig) {\n  const request = transport(config);\n  return {\n    resources: {');
  for (const resource of contract.resources.filter((r) => r.operations.length)) {
    lines.push(`      [${literal(resource.name)}]: {`);
    const path = literal(encodeURIComponent(resource.name));
    for (const op of resource.operations) {
      const policy = literal(op.policy);
      const row = `Row_${resource.name}`, read = `Read_${resource.name}`;
      if (op.name === 'list') lines.push(`        list: (query: List_${resource.name} = {}, options: RequestOptions = {}) => request<ListResponse<${read}>>(${path}, 'GET', 200, ${policy}, undefined, options, queryString(query)),`);
      if (op.name === 'get') lines.push(`        get: (id: string, query: Get_${resource.name} = {}, options: RequestOptions = {}) => request<${read}>(rowPath(${path}, id), 'GET', 200, ${policy}, undefined, options, queryString(query)),`);
      if (op.name === 'create' || op.name === 'update') lines.push(`        ${op.name}: (${op.name === 'update' ? 'id: string, ' : ''}body: ${op.name === 'create' ? 'Create' : 'Update'}_${resource.name}, options: RequestOptions = {}) => request<${row}>(${op.name === 'update' ? `rowPath(${path}, id)` : path}, '${op.name === 'create' ? 'POST' : 'PATCH'}', ${op.status}, ${policy}, body, options),`);
      if (op.name === 'delete') lines.push(`        delete: (id: string, options: RequestOptions = {}) => request<void>(rowPath(${path}, id), 'DELETE', 204, ${policy}, undefined, options),`);
    }
    lines.push('      },');
  }
  lines.push('    },');
  if (contract.auth.length) {
    lines.push('    auth: {');
    for (const auth of contract.auth) lines.push(`      ${auth.name}: (${auth.input ? `body: Auth_${auth.name}_Input, ` : ''}options: RequestOptions = {}) => request<${auth.output ? `Auth_${auth.name}_Result` : 'void'}>(${literal(`auth/${auth.name}`)}, '${auth.name === 'me' ? 'GET' : 'POST'}', ${auth.status}, ${literal(auth.policy)}, ${auth.input ? 'body' : 'undefined'}, options),`);
    lines.push('    },');
  }
  lines.push('  };\n}\n');
  return lines.join('\n\n');
}
