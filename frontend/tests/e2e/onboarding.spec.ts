import { test, expect } from '@playwright/test';
import { signupLogin } from './platform-account';
import { randomUUID } from 'node:crypto';
let onboardingCookies:
  | Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>>
  | undefined;
test('new developer completes Tasks quickstart using visible guidance', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  page.on('dialog', (d) => d.accept());
  const suffix = randomUUID().slice(0, 8);
  await signupLogin(page);
  onboardingCookies = await context.cookies();
  await page.getByLabel('Name', { exact: true }).fill('Quickstart ' + suffix);
  await page.getByLabel('Slug', { exact: true }).fill('quickstart-' + suffix);
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page).toHaveURL(/projects\/[a-f0-9-]{36}$/);
  const overview = new URL(page.url()).pathname;
  const next = page.getByRole('region', { name: 'Next action' });
  await expect(next.getByRole('link')).toHaveText('Connect PostgreSQL');
  await next.getByRole('link').click();
  const db = new URL(process.env.E2E_CUSTOMER_DATABASE_URL!);
  for (const [label, value] of Object.entries({
    Label: 'Disposable',
    Host: db.hostname,
    Port: db.port || '5432',
    Database: db.pathname.slice(1),
    Username: decodeURIComponent(db.username),
    Password: decodeURIComponent(db.password),
    Schema: process.env.E2E_CUSTOMER_SCHEMA!,
  }))
    await page.getByLabel(label, { exact: true }).fill(value);
  await page
    .getByLabel('Use SSL with certificate verification', { exact: true })
    .uncheck();
  await page
    .getByRole('button', { name: 'Test and save', exact: true })
    .click();
  await expect(page.getByText(/Last connection check: success/)).toBeVisible();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(next.getByRole('link')).toHaveText('Create your first table');
  await next.getByRole('link').click();
  let mutations = 0;
  const count = (r: import('@playwright/test').Request) => {
    if (r.url().includes('/api/management/') && r.method() !== 'GET')
      mutations++;
  };
  page.on('request', count);
  await page
    .getByRole('button', { name: 'Start with a Tasks example', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Use user-owned tasks', exact: true })
    .click();
  await expect(page.getByLabel('Table name', { exact: true })).toHaveValue(
    'tasks',
  );
  await expect(
    page.getByText(/Add the ownership UUID field before the first Apply/),
  ).toBeVisible();
  expect(mutations).toBe(0);
  page.off('request', count);
  await page
    .getByRole('button', { name: 'Create table draft', exact: true })
    .click();
  await expect(page).toHaveURL(/schema\/[a-f0-9-]{36}$/);
  await page
    .getByRole('button', { name: 'Preview changes', exact: true })
    .click();
  await page.getByRole('button', { name: 'Apply schema', exact: true }).click();
  await expect(
    page.getByText('Saved draft · Current database schema: Applied', {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'App authentication', exact: true })
    .click();
  await page.getByLabel('Enable application login', { exact: true }).check();
  await page.getByLabel('Allow signup (optional)', { exact: true }).check();
  await page
    .getByRole('button', { name: 'Save auth configuration', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Create authentication tables', exact: true })
    .click();
  await expect(page.getByText(/Authentication status: Ready/)).toBeVisible();
  await page.getByRole('link', { name: 'APIs', exact: true }).click();
  await page
    .getByRole('button', { name: 'Select all operations', exact: true })
    .click();
  const bulk = page.getByRole('group', {
    name: 'Apply one policy to enabled operations',
    exact: true,
  });
  await bulk
    .getByRole('combobox', { name: 'Policy', exact: true })
    .selectOption('owner');
  await bulk
    .getByRole('combobox', { name: 'Owner field', exact: true })
    .selectOption({ label: 'owner_id' });
  await bulk
    .getByRole('button', {
      name: 'Apply policy to enabled operations',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Save tasks API', exact: true })
    .click();
  await expect(
    page.getByText('tasks API configuration saved', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(next.getByRole('link')).toContainText('Playground');
  await expect(
    page.getByText('Configured — test your API.', { exact: true }).first(),
  ).toBeVisible();
  await next.getByRole('link').click();
  const endpoint = page.getByRole('combobox', {
    name: 'Endpoint',
    exact: true,
  });
  const body = page.getByLabel('JSON request body', { exact: true });
  const account = {
    email: `app-${suffix}@example.test`,
    password: 'onboarding-password-long-123',
  };
  await endpoint.selectOption('auth:signup');
  await page
    .getByRole('combobox', { name: 'Credential mode', exact: true })
    .selectOption('none');
  await body.fill(JSON.stringify(account));
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByTestId('response-status')).toHaveText('HTTP 201');
  await endpoint.selectOption('auth:login');
  await body.fill(JSON.stringify(account));
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByTestId('response-status')).toHaveText('HTTP 200');
  const token = await page
    .getByLabel('Runtime credential', { exact: true })
    .inputValue();
  const create = endpoint.locator('option').filter({ hasText: /^POST tasks$/ });
  await endpoint.selectOption((await create.getAttribute('value'))!);
  await body.fill(JSON.stringify({ title: 'First task' }));
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByTestId('response-status')).toHaveText('HTTP 201');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(
    page.getByText('Your API is ready to try in your application.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Tested during this visit', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText('Optional: Workflows', { exact: true }),
  ).toBeVisible();
  await next.getByRole('link').click();
  const article = page.locator('article').filter({
    has: page.getByRole('heading', { name: 'POST /tasks', exact: true }),
  });
  await article.getByText('Integration examples', { exact: true }).click();
  await article
    .getByRole('button', { name: /^Copy JavaScript example/ })
    .click();
  const snippet = await page.evaluate(() => navigator.clipboard.readText());
  expect(snippet).toContain('<APPLICATION_SESSION_TOKEN>');
  expect(snippet).not.toContain(token);
  expect(snippet).not.toContain('First task');
  await article
    .getByRole('link', { name: 'Try in Playground', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Send request', exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId('response-status')).toHaveCount(0);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL(overview);
  await page.reload();
  await expect(
    page.getByText('Your API is ready to try in your application.', {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Next action' }).getByRole('link'),
  ).toContainText('Playground');
});

test('Tasks chooser preserves unsaved edits when overwrite is declined', async ({
  page,
}) => {
  if (onboardingCookies) {
    await page.context().addCookies(onboardingCookies);
    await page.goto('/projects');
  } else await signupLogin(page);
  const suffix = randomUUID().slice(0, 8);
  await page.getByLabel('Name', { exact: true }).fill('Preset ' + suffix);
  await page.getByLabel('Slug', { exact: true }).fill('preset-' + suffix);
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page).toHaveURL(/projects\/[a-f0-9-]{36}$/);
  await page
    .getByRole('complementary')
    .getByRole('link', { name: 'Tables & fields', exact: true })
    .click();
  await page.getByLabel('Table name', { exact: true }).fill('unsaved_work');
  let mutations = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/management/') && r.method() !== 'GET')
      mutations++;
  });
  await page
    .getByRole('button', { name: 'Start with a Tasks example', exact: true })
    .click();
  page.once('dialog', (d) => d.dismiss());
  await page
    .getByRole('button', { name: 'Use user-owned tasks', exact: true })
    .click();
  await expect(page.getByLabel('Table name', { exact: true })).toHaveValue(
    'unsaved_work',
  );
  page.once('dialog', (d) => d.accept());
  await page
    .getByRole('button', { name: 'Use server-controlled tasks', exact: true })
    .click();
  await expect(page.getByLabel('Table name', { exact: true })).toHaveValue(
    'tasks',
  );
  await expect(page.getByLabel('Field name', { exact: true })).toHaveCount(2);
  expect(mutations).toBe(0);
});
