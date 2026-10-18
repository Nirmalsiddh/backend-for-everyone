export function dashboardOrigin() {
  const value = process.env.DASHBOARD_ORIGIN ?? '';
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid dashboard origin');
  return url;
}
export function cookieSettings() {
  const origin = dashboardOrigin();
  const local = process.env.DASHBOARD_COOKIE_MODE === 'local-http';
  if (local && (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Local cookie mode requires localhost HTTP');
  if (!local && origin.protocol !== 'https:') throw new Error('Secure cookie mode requires HTTPS');
  return { name: local ? 'platform_session' : '__Host-platform_session', secure: !local };
}
export function backendOrigin() {
  const value = process.env.BACKEND_ORIGIN ?? '';
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid backend origin');
  return value;
}
export function allowedRequest(request: Request) {
  const canonical = dashboardOrigin();
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (host !== canonical.host) return false;
  if (['GET', 'HEAD'].includes(request.method)) return true;
  return request.headers.get('origin') === canonical.origin && request.headers.get('sec-fetch-site') !== 'cross-site';
}
export function requestToken(request: Request) {
  const name = cookieSettings().name;
  const values = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const token = values[0]!.slice(name.length + 1);
  return /^ps_[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
export function sessionCookie(token: string, clear = false) {
  const { name, secure } = cookieSettings();
  return `${name}=${clear ? '' : token}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${clear ? 0 : 86400}`;
}
