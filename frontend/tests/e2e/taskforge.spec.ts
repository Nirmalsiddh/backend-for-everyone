import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { signupLogin } from './platform-account';

// Uses only the existing harness's explicitly supplied dedicated disposable DBs.
// Do not capture screenshots containing the one-time API key.
test.use({ screenshot: 'off', trace: 'off', video: 'off' });
test('Taskforge creates storage and CRUD, then creates and lists a real task', async ({ page }) => {
  await signupLogin(page);
  const suffix = randomUUID().slice(0, 8);
  await page.getByLabel('Name', { exact: true }).fill('Taskforge ' + suffix);
  await page.getByLabel('Slug', { exact: true }).fill('taskforge-' + suffix);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page).toHaveURL(/projects\/[a-f0-9-]{36}$/);
  const base = new URL(page.url()).pathname;
  await page.goto(base + '/guided');
  await expect(page.getByRole('alert').filter({ hasText: 'Connect your database' })).toContainText('Connect your database');
  await page.getByRole('link', { name: 'Open Database Settings' }).click();
  const database = new URL(process.env.E2E_CUSTOMER_DATABASE_URL!);
  for (const [label, value] of Object.entries({
    Label: 'Disposable Taskforge', Host: database.hostname, Port: database.port || '5432',
    Database: database.pathname.slice(1), Username: decodeURIComponent(database.username),
    Password: decodeURIComponent(database.password), Schema: process.env.E2E_CUSTOMER_SCHEMA!,
  })) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel('Use SSL with certificate verification').uncheck();
  await page.getByRole('button', { name: 'Test and save', exact: true }).click();
  await expect(page.getByText(/Last connection check: success/)).toBeVisible();
  await page.goto(base + '/guided');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const appliedResponse = page.waitForResponse((response) => response.url().endsWith('/apply') && response.request().method() === 'POST');
  const configuredResponse = page.waitForResponse((response) => response.url().endsWith('/api') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Create Backend', exact: true }).click();
  const applied = await appliedResponse;
  expect(applied.ok()).toBe(true);
  expect((await applied.json()).status).toBe('applied');
  const configured = await configuredResponse;
  expect(configured.ok()).toBe(true);
  expect((await configured.json()).enabledOperations.sort()).toEqual(['create', 'delete', 'get', 'list', 'update']);
  await expect(page.getByRole('heading', { name: 'Backend Ready ✓', exact: true })).toBeVisible();
  let writesAfterReload = 0;
  const countWrites = (request: import('@playwright/test').Request) => {
    if (request.url().includes('/api/management/') && request.method() !== 'GET') writesAfterReload++;
  };
  page.on('request', countWrites);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Backend Ready ✓', exact: true })).toBeVisible();
  expect(writesAfterReload).toBe(0);
  page.off('request', countWrites);
  const createHref = await page.getByRole('link', { name: 'Test Create Task' }).getAttribute('href');
  const listHref = await page.getByRole('link', { name: 'Test View Tasks' }).getAttribute('href');
  const keyResponse = page.waitForResponse((response) => response.url().endsWith('/api-keys') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create demo API key', exact: true }).click();
  const generated = await keyResponse;
  expect(generated.status()).toBe(201);
  expect((await generated.json()).scope).toBe('read_write');
  await expect(page.getByRole('dialog')).toBeVisible();
  const key = await page.getByTestId('new-key').innerText();
  const assertKeyNotStored = async () => {
    const stored = await page.evaluate((secret) =>
      [...Object.values(localStorage), ...Object.values(sessionStorage), document.cookie]
        .some((value) => value.includes(secret)), key);
    expect(stored).toBe(false);
  };
  await assertKeyNotStored();
  await page.getByRole('button', { name: 'Close and clear secret' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await assertKeyNotStored();
  let createdId = '';
  for (const [href, status] of [[createHref!, 'HTTP 201'], [listHref!, 'HTTP 200']]) {
    await page.goto(href);
    await page.getByRole('combobox', { name: 'Credential mode', exact: true }).selectOption('key');
    await page.getByLabel('Runtime credential', { exact: true }).fill(key);
    if (status === 'HTTP 201') await page.getByLabel('JSON request body', { exact: true }).fill(JSON.stringify({ title: 'Finish assignment', completed: false }));
    await page.getByRole('button', { name: 'Send request', exact: true }).click();
    await expect(page.getByTestId('response-status')).toHaveText(status);
    await expect(page.getByTestId('response-body')).toContainText('Finish assignment');
    const result = JSON.parse((await page.getByTestId('response-body').innerText()).trim());
    if (status === 'HTTP 201') {
      expect(typeof result.id).toBe('string');
      expect(result.completed).toBe(false);
      createdId = result.id;
    } else {
      expect(result.data.some((task: { id: string; title: string; completed: boolean }) =>
        task.id === createdId && task.title === 'Finish assignment' && task.completed === false)).toBe(true);
    }
    await assertKeyNotStored();
  }
  writesAfterReload = 0;
  page.on('request', countWrites);
  await page.goto(base + '/guided');
  await expect(page.getByRole('heading', { name: 'Backend Ready ✓', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Backend Ready ✓', exact: true })).toBeVisible();
  expect(writesAfterReload).toBe(0);
  await assertKeyNotStored();
  page.off('request', countWrites);
});
