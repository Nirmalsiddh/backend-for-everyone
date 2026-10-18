import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
if (
  !process.env.E2E_PLATFORM_DATABASE_URL ||
  !process.env.E2E_CUSTOMER_DATABASE_URL
)
  throw new Error(
    'Explicit disposable E2E_PLATFORM_DATABASE_URL and E2E_CUSTOMER_DATABASE_URL required',
  );
process.env.E2E_MANAGEMENT_TOKEN ??= randomBytes(32).toString('hex');
process.env.MANAGEMENT_API_TOKEN = process.env.E2E_MANAGEMENT_TOKEN;
process.env.MANAGEMENT_USER_ID = '99999999-9999-4999-8999-999999999999';
process.env.E2E_ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
process.env.CONNECTION_ENCRYPTION_KEY = process.env.E2E_ENCRYPTION_KEY;
process.env.E2E_CUSTOMER_SCHEMA ??= 'demo_' + randomBytes(6).toString('hex');
process.env.BACKEND_ORIGIN = 'http://127.0.0.1:3010';
process.env.DASHBOARD_ALLOWED_HOSTS = '127.0.0.1:3011,localhost:3011';
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  timeout: 180000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:3011',
    headless: true,
    actionTimeout: 15000,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  webServer: [
    {
      command: 'node --import tsx tests/e2e/start-backend.ts',
      url: 'http://127.0.0.1:3010/internal/projects',
      timeout: 60000,
      reuseExistingServer: false,
    },
    {
      command:
        'npm run build && npx next start --hostname 127.0.0.1 --port 3011',
      url: 'http://127.0.0.1:3011/projects',
      timeout: 180000,
      reuseExistingServer: false,
    },
  ],
});
