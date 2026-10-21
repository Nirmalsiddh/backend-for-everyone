export interface RequestEvent {
  id: string; requestId: string; completedAt: string; eventVersion: number;
  routeCategory: string; operation: string | null; resource: string | null;
  method: string; status: number; errorCode: string | null; durationMs: number;
  responseBytes: number | null; principalKind: string;
}
export interface Counts { recordedRequests: number; '2xx': number; '3xx': number; '4xx': number; '5xx': number }
export interface Summary extends Counts {
  window: string; asOf: string; p50DurationMs: number | null; p95DurationMs: number | null;
  topOperations: (Counts & { resource: string | null; operation: string | null; p95DurationMs: number | null })[];
  topErrorCodes: { errorCode: string; count: number }[];
}
export interface EventPage { items: RequestEvent[]; nextCursor: string | null }
export const eventFields = ['id','requestId','completedAt','eventVersion','routeCategory','operation','resource','method','status','errorCode','durationMs','responseBytes','principalKind'];
export const countFields = ['recordedRequests','2xx','3xx','4xx','5xx'];
export function validRequestId(value: string) { return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value); }
export function observabilityQueryAllowed(path: string, keys: string[]) {
  if (/^projects\/[a-f0-9-]{36}\/observability\/summary$/.test(path)) return keys.every((key) => key === 'window');
  if (/^projects\/[a-f0-9-]{36}\/observability\/requests$/.test(path)) return keys.every((key) => ['window','operation','resource','statusClass','failuresOnly','limit','cursor'].includes(key));
  return false;
}
