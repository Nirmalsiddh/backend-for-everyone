import { readFile, stat } from 'node:fs/promises';
async function main() {
  const path = process.env.SMOKE_CONFIG;
  if (!path || (await stat(path)).mode & 0o077) throw Error();
  const config = JSON.parse(await readFile(path, 'utf8'));
  const app = new URL(config.appOrigin).origin,
    api = new URL(config.apiOrigin).origin;
  if (!app.startsWith('https:') || !api.startsWith('https:')) throw Error();
  const call = (origin, path, options = {}) =>
    fetch(origin + path, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
  for (const path of ['/internal', '/internal/projects', '/health/ready'])
    if ((await call(api, path)).status !== 404) throw Error();
  if ((await call(app, '/health/ready')).status !== 200) throw Error();
  const response = await call(app, '/api/auth/login', {
    method: 'POST',
    headers: { origin: app, 'content-type': 'application/json' },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  if (response.status !== 200) throw Error();
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie?.startsWith('__Host-platform_session=')) throw Error();
  if (
    (await call(app, '/api/management/projects', { headers: { cookie } }))
      .status !== 200
  )
    throw Error();
  const isolated = await call(
    api,
    '/api/nonexistent-project/nonexistent-resource',
  );
  if (![401, 404].includes(isolated.status)) throw Error();
  await call(app, '/api/auth/logout', {
    method: 'POST',
    headers: { origin: app, cookie },
  });
  console.info(
    'Authenticated maintenance smoke passed; no product data was created.',
  );
}
main().catch(() => {
  console.error(
    'Deployment smoke gate failed; keep maintenance enabled and inspect sanitized service logs.',
  );
  process.exitCode = 1;
});
