import { randomUUID } from 'node:crypto';
import { boundedBody } from './body-limit';
import { isIP } from 'node:net';
import {
  allowedRequest,
  backendOrigin,
  requestToken,
  sessionCookie,
} from './auth-config';
export async function authHandler(request: Request, action: string) {
  const requestId = randomUUID();
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-request-id': requestId,
  });
  const result = (status: number, body: unknown) =>
    Response.json(
      status >= 400
        ? {
            ...(body as Record<string, unknown>),
            code: 'AUTH_REQUEST_FAILED',
            requestId: headers.get('x-request-id'),
          }
        : body,
      { status, headers },
    );
  if (
    !['signup', 'login', 'logout'].includes(action) ||
    request.method !== 'POST'
  )
    return result(404, { message: 'Not found' });
  try {
    if (!allowedRequest(request))
      return result(403, { message: 'Same-origin request required' });
    const upstreamHeaders = new Headers({ 'x-request-id': requestId });
    let body: string | undefined;
    if (action === 'logout') {
      const token = requestToken(request);
      if (!token) {
        headers.set('set-cookie', sessionCookie('', true));
        return result(200, { ok: true });
      }
      upstreamHeaders.set('authorization', `Bearer ${token}`);
    } else {
      if (
        request.headers.get('content-type')?.split(';')[0]?.trim() !==
        'application/json'
      )
        return result(400, { message: 'JSON required' });
      body = await boundedBody(request, 4096);
      if (Buffer.byteLength(body) > 4096)
        return result(413, { message: 'Request too large' });
      upstreamHeaders.set('content-type', 'application/json');
    }
    // Optional deployment contract: ingress overwrites this single-IP header and
    // blocks direct access. Never relay arbitrary X-Forwarded-For chains.
    const ipHeader = process.env.DASHBOARD_TRUSTED_CLIENT_IP_HEADER;
    if (ipHeader) {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(ipHeader) ||
        ['host', 'origin', 'cookie', 'authorization'].includes(ipHeader)
      )
        throw new Error('Invalid trusted IP header');
      const ip = request.headers.get(ipHeader) ?? '';
      if (!isIP(ip)) throw new Error('Missing trusted ingress IP');
      upstreamHeaders.set('x-forwarded-for', ip);
    }
    const response = await fetch(`${backendOrigin()}/internal/auth/${action}`, {
      method: 'POST',
      headers: upstreamHeaders,
      body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    headers.set(
      'x-request-id',
      response.headers.get('x-request-id') ?? requestId,
    );
    const retry = response.headers.get('retry-after');
    if (retry) headers.set('retry-after', retry);
    if (action === 'logout' && (response.ok || response.status === 401)) {
      headers.set('set-cookie', sessionCookie('', true));
      return result(200, { ok: true });
    }
    if (!response.ok)
      return result(response.status, {
        message:
          response.status === 401
            ? 'Invalid email or password'
            : response.status === 429
              ? 'Too many authentication attempts. Try again later.'
              : 'Authentication request failed',
      });
    const data = await response.json();
    if (action === 'signup')
      return result(202, {
        message: 'Continue to sign in with your email and password.',
      });
    if (
      typeof data.sessionToken !== 'string' ||
      !/^ps_[A-Za-z0-9_-]{43}$/.test(data.sessionToken) ||
      typeof data.user?.id !== 'string' ||
      typeof data.user?.email !== 'string'
    )
      throw new Error('Invalid auth response');
    headers.set('set-cookie', sessionCookie(data.sessionToken));
    return result(200, { user: { id: data.user.id, email: data.user.email } });
  } catch (error) {
    if (error instanceof RangeError)
      return result(413, { message: 'Request too large' });
    return result(503, {
      message:
        action === 'logout'
          ? 'Logout could not be confirmed. Please retry.'
          : 'Authentication service unavailable. Please retry.',
    });
  }
}
