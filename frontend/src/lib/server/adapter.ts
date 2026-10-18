import { operationFor } from './operations';
import { randomUUID } from 'node:crypto';
import { pick } from './dto';
export { projectDto, tableDto } from './dto';
export function supported(path: string, method: string, runtime = false) {
  return !!operationFor(path, method, runtime);
}
export function managementDto(path: string, method: string, data: unknown) {
  const op = operationFor(path, method);
  if (!op) throw new Error('Unsupported operation');
  return op.project(data, method);
}
function sameOrigin(request: Request, url: URL) {
  try {
    const origin = new URL(request.headers.get('origin') ?? '');
    return (
      origin.origin === request.headers.get('origin') &&
      origin.host === (request.headers.get('host') ?? url.host) &&
      origin.protocol === url.protocol
    );
  } catch {
    return false;
  }
}
export async function adapter(
  request: Request,
  segments: string[],
  runtime = false,
) {
  const path = segments.join('/');
  const requestId = randomUUID();
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-request-id': requestId,
  });
  const fail = (status: number, code: string, message: string) =>
    Response.json({ code, message }, { status, headers });
  if (!supported(path, request.method, runtime))
    return fail(404, 'NOT_FOUND', 'Unsupported dashboard operation');
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  const allowed = (
    process.env.DASHBOARD_ALLOWED_HOSTS ??
    '127.0.0.1:3001,localhost:3001,127.0.0.1:3011,localhost:3011,localhost'
  )
    .split(',')
    .map((v) => v.trim());
  if (!allowed.includes(host))
    return fail(403, 'HOST_REJECTED', 'Dashboard host is not permitted');
  if (
    request.method !== 'GET' &&
    (!sameOrigin(request, url) ||
      request.headers.get('sec-fetch-site') === 'cross-site')
  )
    return fail(403, 'ORIGIN_REJECTED', 'Same-origin request required');
  let origin: string;
  try {
    origin = process.env.BACKEND_ORIGIN ?? '';
    const target = new URL(origin);
    if (
      target.origin !== origin ||
      target.username ||
      target.password ||
      !['http:', 'https:'].includes(target.protocol) ||
      (!runtime && !process.env.MANAGEMENT_API_TOKEN)
    )
      throw new Error();
  } catch {
    return fail(
      503,
      'DASHBOARD_CONFIGURATION_INVALID',
      'Dashboard server configuration is invalid; contact the operator',
    );
  }
  let phase: 'transport' | 'contract' = 'transport';
  try {
    const target = new URL(origin ?? '');
    if (
      target.origin !== origin ||
      target.username ||
      target.password ||
      !['http:', 'https:'].includes(target.protocol)
    )
      throw new Error('Invalid origin');
    const upstreamHeaders = new Headers();
    if (runtime) {
      const credential = request.headers.get('authorization');
      if (credential) upstreamHeaders.set('authorization', credential);
    } else {
      const token = process.env.MANAGEMENT_API_TOKEN;
      if (!token) throw new Error('Missing token');
      upstreamHeaders.set('authorization', `Bearer ${token}`);
    }
    const query = url.searchParams;
    if (
      !runtime &&
      [...query.keys()].some(
        (k) => path !== 'projects' || !['limit', 'offset'].includes(k),
      )
    )
      return fail(400, 'INVALID_REQUEST', 'Unsupported query parameter');
    let body: string | undefined;
    if (!['GET', 'HEAD'].includes(request.method)) {
      body = await request.text();
      if (Buffer.byteLength(body, 'utf8') > 65536)
        return fail(413, 'INVALID_REQUEST', 'Request is too large');
      if (body) {
        if (
          !request.headers.get('content-type')?.startsWith('application/json')
        )
          return fail(400, 'INVALID_REQUEST', 'JSON required');
        upstreamHeaders.set('content-type', 'application/json');
      } else body = undefined;
    }
    const response = await fetch(
      `${origin}/${runtime ? 'api' : 'internal'}/${path}${url.search}`,
      {
        method: request.method,
        headers: upstreamHeaders,
        body,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      },
    );
    headers.set(
      'x-request-id',
      response.headers.get('x-request-id') ?? requestId,
    );
    for (const key of ['retry-after', 'location', 'www-authenticate']) {
      const v = response.headers.get(key);
      if (v) headers.set(key, v);
    }
    if (response.status === 204)
      return new Response(null, { status: 204, headers });
    phase = 'contract';
    const text = await response.text();
    if (runtime) {
      if (!text)
        return new Response(null, { status: response.status, headers });
      // Fastify owns sanitization of runtime errors. Business responses are arbitrary JSON.
      const data: unknown = JSON.parse(text);
      return Response.json(data, { status: response.status, headers });
    }
    const data = JSON.parse(text);
    if (!response.ok)
      return Response.json(pick(data, ['code', 'message', 'requestId']), {
        status: response.status,
        headers,
      });
    return Response.json(
      runtime ? data : managementDto(path, request.method, data),
      { status: response.status, headers },
    );
  } catch (error) {
    return fail(
      error instanceof Error && error.name === 'TimeoutError' ? 504 : 503,
      phase === 'contract'
        ? 'BACKEND_CONTRACT_MISMATCH'
        : 'BACKEND_UNAVAILABLE',
      phase === 'contract'
        ? 'Backend returned an unexpected response; contact the operator'
        : 'Backend is unavailable; review status before retrying a write',
    );
  }
}
