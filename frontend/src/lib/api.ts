import type { ApiErrorBody } from '../../../shared/public-contracts.js';
export class ApiError extends Error implements ApiErrorBody {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/management/${path}`, {
    method,
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.code ?? 'REQUEST_FAILED',
      data.message ?? 'Request failed',
      response.headers.get('x-request-id') ?? undefined,
    );
  return data as T;
}
