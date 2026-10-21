import { randomUUID } from 'node:crypto';
export const operations = ['crud.list', 'crud.get', 'crud.create', 'crud.update', 'crud.delete', 'auth.signup', 'auth.login', 'auth.me', 'auth.logout', 'workflow.execute'] as const;
export type Operation = typeof operations[number];
export interface EventContext {
  projectId?: string;
  category: 'crud' | 'auth' | 'workflow' | 'unresolved';
  operation: Operation | null;
  resource: string | null;
  principal: 'project_key' | 'app_user' | 'anonymous';
  errorCode: string | null;
  responseBytes: number | null;
  started: bigint;
  recorded: boolean;
}
export interface RequestEvent {
  id: string; projectId: string; requestId: string; completedAt: string;
  eventVersion: 1; routeCategory: EventContext['category']; operation: Operation | null;
  resource: string | null; method: string; status: number; errorCode: string | null;
  durationUs: number; responseBytes: number | null; principalKind: EventContext['principal'];
}
export function buildEvent(context: EventContext, requestId: string, method: string, status: number): Readonly<RequestEvent> | undefined {
  if (!context.projectId || context.recorded || method === 'OPTIONS') return;
  // Fail closed if an internal producer violates the fixed scalar contract.
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if (!uuid.test(context.projectId) || !uuid.test(requestId) || !/^[A-Z]{1,16}$/.test(method) ||
    !Number.isInteger(status) || status < 100 || status > 599 ||
    (context.resource !== null && (typeof context.resource !== 'string' || !/^[a-z][a-z0-9_/-]{0,99}$/.test(context.resource))) ||
    (context.errorCode !== null && !/^[A-Z][A-Z0-9_]{0,79}$/.test(context.errorCode))) return;
  context.recorded = true;
  return Object.freeze({ id: randomUUID(), projectId: context.projectId, requestId,
    completedAt: new Date().toISOString(), eventVersion: 1, routeCategory: context.category,
    operation: context.operation, resource: context.resource, method, status,
    errorCode: context.errorCode, durationUs: Math.min(Number.MAX_SAFE_INTEGER, Number((process.hrtime.bigint() - context.started) / 1000n)),
    responseBytes: context.responseBytes, principalKind: context.principal });
}
export interface EventSink { enqueue(event: Readonly<RequestEvent>): void }
