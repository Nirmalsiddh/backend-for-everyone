import type { ApiErrorBody } from '../../../shared/public-contracts.js';
export class ApiError extends Error implements ApiErrorBody {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public retryAfter?: number,
    public operation?: string,
    public projectId?: string,
    public timestamp = new Date().toISOString(),
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/management/${path}`, {
      method,
      cache: 'no-store',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'RESPONSE_UNCONFIRMED',
      'Response could not be confirmed',
      undefined,
      undefined,
      `${path} ${method}`,
      path.split('/')[1],
    );
  }
  let data;
  try {
    data = response.status === 204 ? undefined : await response.json();
  } catch {
    throw new ApiError(
      response.status,
      'RESPONSE_UNCONFIRMED',
      'Response could not be confirmed',
      response.headers.get('x-request-id') ?? undefined,
      undefined,
      `${path} ${method}`,
      path.split('/')[1],
    );
  }
  if (response.status === 401 && typeof window !== 'undefined')
    window.location.assign('/login');
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.code ?? 'REQUEST_FAILED',
      data.message ?? 'Request failed',
      response.headers.get('x-request-id') ?? undefined,
      Number(response.headers.get('retry-after')) || undefined,
      `${path} ${method}`,
      path.split('/')[1],
    );
  return data as T;
}
