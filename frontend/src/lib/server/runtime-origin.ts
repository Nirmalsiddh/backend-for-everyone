export function publicRuntimeOrigin(source: NodeJS.ProcessEnv = process.env) {
  const value = source.PUBLIC_RUNTIME_ORIGIN ?? '';
  if (!value && source.NODE_ENV !== 'production') return 'http://127.0.0.1:3000';
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid public runtime origin');
  if (source.DASHBOARD_COOKIE_MODE !== 'local-http' && url.protocol !== 'https:') throw new Error('Public runtime origin must use HTTPS');
  return url.origin;
}
