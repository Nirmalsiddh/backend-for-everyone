// Static developer-authored source. No schema names are interpolated into this template.
export const runtimeTemplate = `
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type AtLeastOne<T> = { [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>> }[keyof T];
export interface RequestOptions { signal?: AbortSignal }
export interface ClientConfig {
  /** Runtime project root, for example https://api.example.test/api/my-project */
  baseUrl: string;
  apiKey?: string;
  getSessionToken?: () => string | undefined | Promise<string | undefined>;
}
export interface ListResponse<T> { data: T[]; pagination: { limit: number; offset: number; hasMore: boolean } }
export class ApiError extends Error {
  readonly name = 'ApiError';
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly requestId?: string) { super(message); }
}
export class TransportError extends Error {
  readonly name = 'TransportError';
  constructor() { super('The response could not be confirmed. A write may have completed.'); }
}
export class ProtocolError extends Error {
  readonly name = 'ProtocolError';
  constructor(public readonly status: number, public readonly requestId?: string) { super('Unexpected runtime response. A write may have completed.'); }
}
type WireFilter = { field: string } & ({ operator: 'in'; values: string[] } | { operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_null' | 'legacy_eq'; value: string });
type WireQuery = { limit?: number | string; offset?: number | string; sort?: string; direction?: string; filters?: WireFilter[]; includes?: string[] };
type QueryOptions = { filter?: object; limit?: number; offset?: number; sort?: string; direction?: 'asc' | 'desc'; include?: string[] };
function queryString(options: QueryOptions = {}): string {
  const filters: WireFilter[] = [];
  for (const [field, operators] of Object.entries(options.filter ?? {})) {
    if (!operators || typeof operators !== 'object' || Array.isArray(operators)) throw new TypeError('Invalid filter');
    for (const [operator, value] of Object.entries(operators)) {
      if (operator === 'in') {
        if (!Array.isArray(value) || value.length < 1 || value.length > 25 || !value.every((v: unknown) => typeof v === 'string' || typeof v === 'number' && Number.isInteger(v))) throw new TypeError('IN requires 1–25 scalar values');
        filters.push({ field, operator, values: value.map(String) });
      } else {
        if (!['eq','neq','gt','gte','lt','lte','is_null'].includes(operator) || !['string','number','boolean'].includes(typeof value)) throw new TypeError('Invalid filter');
        filters.push({ field, operator: operator as Exclude<WireFilter['operator'], 'in'>, value: String(value) });
      }
    }
  }
  if (filters.length > 5) throw new TypeError('Maximum five filter clauses');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new TypeError('Invalid limit');
  if (options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0 || options.offset > 10000)) throw new TypeError('Invalid offset');
  if (options.include && (options.include.length > 2 || new Set(options.include).size !== options.include.length)) throw new TypeError('Maximum two unique includes');
  return serializeRuntimeQuery({ ...options, filters, ...(options.include ? { includes: options.include } : {}) });
}
function rowPath(resource: string, id: string): string {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new TypeError('Invalid row ID');
  return resource + '/' + encodeURIComponent(id);
}
function transport(config: ClientConfig) {
  const root = new URL(config.baseUrl);
  if (!['http:','https:'].includes(root.protocol) || root.search || root.hash || root.username || root.password) throw new TypeError('Invalid runtime baseUrl');
  root.pathname = root.pathname.replace(/\\/+$/, '') + '/';
  return async <T>(path: string, method: string, status: number, policy: string, body: unknown, options: RequestOptions = {}, query = ''): Promise<T> => {
    const headers: Record<string, string> = {};
    if (policy !== 'public') {
      const token = policy === 'key_only' ? config.apiKey : await config.getSessionToken?.();
      const prefix = policy === 'key_only' ? 'pk_' : 'us_';
      if (!token || !token.startsWith(prefix) || !/^(pk_|us_)[A-Za-z0-9_-]{43}$/.test(token)) throw new TypeError('Missing or invalid runtime credential for this operation');
      headers.Authorization = 'Bearer ' + token;
    }
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined) headers['Content-Type'] = 'application/json';
    const url = new URL(path, root);
    url.search = query;
    let response: Response;
    try {
      response = await fetch(url, { method, headers, ...(serialized === undefined ? {} : { body: serialized }),
        ...(options.signal ? { signal: options.signal } : {}), credentials: 'omit', redirect: 'error' });
    } catch { throw new TransportError(); }
    const requestId = response.headers.get('x-request-id') ?? undefined;
    if (!response.ok) {
      let error: unknown;
      try { error = await response.json(); } catch { /* Never expose upstream HTML. */ }
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && 'message' in error && typeof error.message === 'string') {
        const id = 'requestId' in error && typeof error.requestId === 'string' ? error.requestId : requestId;
        throw new ApiError(response.status, error.code, error.message, id);
      }
      throw new ApiError(response.status, 'HTTP_ERROR', 'Runtime request failed', requestId);
    }
    if (response.status !== status) throw new ProtocolError(response.status, requestId);
    if (status === 204) return undefined as T;
    try { return await response.json() as T; } catch { throw new ProtocolError(response.status, requestId); }
  };
}
`;
