import type { OpenApiDocument } from './api-docs';
import { includeOptions, includeQuery, operationById } from './api-docs';
const shell = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const literal = (v: unknown) =>
  JSON.stringify(v)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
export function operationExamples(doc: OpenApiDocument, operationId: string, includes: string[] = []) {
  const match = operationById(doc, operationId);
  if (!match || !doc.servers[0]?.url) return null;
  const { path, method, operation } = match;
  const selected = includes.filter((name) => includeOptions(operation).includes(name)).slice(0, 2);
  const query = includeQuery(selected);
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
