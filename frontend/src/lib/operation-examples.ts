import { serializeRuntimeQuery, type PublicFilter } from '../../../shared/runtime-query.js';
import type { OpenApiDocument } from './api-docs';
import { includeOptions, operationById } from './api-docs';
const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const literal = (v: unknown) =>
  JSON.stringify(v)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
export function operationExamples(doc: OpenApiDocument, operationId: string, includes: string[] = [], queryExample: 'ordinary' | 'legacy' | 'range' | 'in' | 'null' = 'ordinary') {
  const match = operationById(doc, operationId);
  if (!match || !doc.servers[0]?.url) return null;
  const { path, method, operation } = match;
  const selected = includes.filter((name) => includeOptions(operation).includes(name)).slice(0, 2);
  const fields = operation['x-runtime-query']?.fields ?? [];
  const filters: PublicFilter[] = [];
  const candidate = fields.find((field) => queryExample === 'range' ? field.operators.includes('gte') : queryExample === 'in' ? field.operators.includes('in') : queryExample === 'null' ? field.operators.includes('is_null') : field.type === 'text' || field.type === 'varchar') ?? (queryExample === 'legacy' ? fields[0] : undefined);
  const exampleScalar = (type: string) => type === 'uuid' ? '00000000-0000-4000-8000-000000000000' : type === 'date' ? '2026-10-18' : type === 'timestamp' ? '2026-10-18T12:00:00.123456Z' : ['integer', 'bigint', 'decimal'].includes(type) ? '0' : 'x';
  if (candidate && queryExample !== 'ordinary') {
    if (queryExample === 'in') filters.push({ field: candidate.name, operator: 'in', values: [exampleScalar(candidate.type)] });
    else filters.push({ field: candidate.name, operator: queryExample === 'range' ? 'gte' : queryExample === 'null' ? 'is_null' : 'legacy_eq', value: queryExample === 'null' ? 'true' : exampleScalar(candidate.type) });
  }
  const query = serializeRuntimeQuery({ includes: selected, filters });
  const url =
    doc.servers[0].url.replace(/\/$/, '') +
    path.replace(/\{[^}]+\}/g, '<RECORD_ID>') + (query ? '?' + query : '');
  const schemes = operation.security.flatMap((s) => Object.keys(s));
  if (schemes.some((s) => !['ProjectApiKey', 'ApplicationSession'].includes(s)))
    return null;
  const headers: Record<string, string> = {};
  if (schemes.length)
    headers.Authorization = `Bearer ${schemes.includes('ProjectApiKey') ? '<PROJECT_API_KEY>' : '<APPLICATION_SESSION_TOKEN>'}`;
  const media = operation.requestBody?.content['application/json'];
  if (
    method === 'patch' &&
    media &&
    !Object.keys(media.schema.properties ?? {}).length
  )
    return null;
  // The generated deployed document supplies synthetic examples; never use form values or responses.
  const body = media ? (media.example ?? {}) : undefined;
  if (media) headers['Content-Type'] = 'application/json';
  const curl = [
    `curl -X ${method.toUpperCase()} ${shell(url)}`,
    ...Object.entries(headers).map(([k, v]) => `  -H ${shell(`${k}: ${v}`)}`),
    ...(media ? [`  --data-raw ${shell(JSON.stringify(body))}`] : []),
  ].join(' \\\n');
  const options = [
    `  method: ${literal(method.toUpperCase())},`,
    ...(Object.keys(headers).length
      ? [
          `  headers: ${JSON.stringify(headers, null, 2).replaceAll('\n', '\n  ')},`,
        ]
      : []),
    ...(media ? [`  body: JSON.stringify(${literal(body)}),`] : []),
  ];
  const javascript = `const response = await fetch(${JSON.stringify(url)}, {\n${options.join('\n')}\n});\n\nif (!response.ok) {\n  throw new Error(\`Request failed: \${response.status}\`);\n}\n\nconst result = response.status === 204\n  ? null\n  : await response.json();`;
  return { curl, javascript };
}
