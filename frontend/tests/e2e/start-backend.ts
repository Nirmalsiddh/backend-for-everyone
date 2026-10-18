import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
const require = createRequire(
  new URL('../../../backend/package.json', import.meta.url),
);
const { Client } = require('pg');
const platform = process.env.E2E_PLATFORM_DATABASE_URL!;
const customer = process.env.E2E_CUSTOMER_DATABASE_URL!;
for (const value of [platform, customer]) {
  const url = new URL(value);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^\/dashboard_e2e_[a-z_]+_test$/.test(url.pathname)
  )
    throw new Error(
      'E2E requires dedicated local dashboard_e2e_*_test databases',
    );
}
if (platform === customer)
  throw new Error('Separate platform/customer databases required');
const schema = process.env.E2E_CUSTOMER_SCHEMA!;
if (!/^demo_[a-f0-9]{12}$/.test(schema)) throw new Error('Invalid test schema');
const customerClient = new Client({ connectionString: customer });
await customerClient.connect();
await customerClient.query('CREATE SCHEMA "' + schema + '"');
await customerClient.end();
const backend = new URL('../../../backend/', import.meta.url);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PLATFORM_DATABASE_URL: platform,
  PORT: '3010',
  HOST: '127.0.0.1',
  NODE_ENV: 'test',
};
const migrate = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'src/database/platform-db/migrate.ts'],
  { cwd: backend, env, stdio: 'inherit' },
);
if (migrate.status !== 0) process.exit(1);
const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  cwd: backend,
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
