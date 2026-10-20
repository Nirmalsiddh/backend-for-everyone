import type { ApiOperation, OpenApiDocument } from '../../../shared/openapi.js';
export type { OpenApiDocument };
export function docOperations(doc: OpenApiDocument) {
  return Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      path,
      method,
      operation,
    })),
  );
}
export function operationById(doc: OpenApiDocument, id: string) {
  return docOperations(doc).find((o) => o.operation.operationId === id);
}
export function playgroundHref(projectId: string, operation: ApiOperation) {
  return `/projects/${projectId}/playground?operationId=${encodeURIComponent(operation.operationId)}`;
}
export function downloadDocument(doc: OpenApiDocument) {
  const blob = new Blob([JSON.stringify(doc, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  const slug = doc.servers[0]?.url.split('/').at(-1) ?? 'project';
  link.download = `${slug}-openapi.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function includeOptions(operation?: ApiOperation): string[] {
  const choices = operation?.parameters?.find((parameter) => parameter.in === 'query' && parameter.name === 'include')?.schema.items?.enum;
  return Array.isArray(choices) ? choices.filter((name): name is string => typeof name === 'string') : [];
}
export function includeQuery(names: string[]) {
  const query = new URLSearchParams();
  if (names.length) query.set('include', names.join(','));
  return query.toString();
}
