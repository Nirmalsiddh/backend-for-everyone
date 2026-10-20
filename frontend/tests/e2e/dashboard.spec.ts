import { signupLogin } from './platform-account';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('complete dashboard product flow on disposable PostgreSQL', async ({
  page,
}) => {
  page.on('dialog', (dialog) => dialog.accept());
  const suffix = randomUUID().slice(0, 8);
  const password = 'dashboard-e2e-password-123456';
  const customer = new URL(process.env.E2E_CUSTOMER_DATABASE_URL!);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const browserResponses: string[] = [];
  page.on('response', async (response) => {
    if (response.url().includes('/api/management/')) {
      try {
        browserResponses.push(await response.text());
      } catch {}
    }
  });
  async function clickSave(button: Locator) {
    const response = page.waitForResponse(
      (r) =>
        r.url().includes('/api/management/') &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.request().method()),
    );
    await button.click();
    const result = await response;
    expect(
      result.status(),
      result.status() >= 300
        ? await result.text()
        : 'Management request succeeded',
    ).toBeLessThan(300);
  }
  const platformEmail = await signupLogin(page);
  await expect(page.getByText(platformEmail, { exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Dashboard ' + suffix);
  await page.getByLabel('Slug', { exact: true }).fill('demo-' + suffix);
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page).toHaveURL(/projects\/[a-f0-9-]{36}$/);
  const projectUrl = new URL(page.url()).pathname;
  const go = async (path: string) => {
    await page.goto(projectUrl + '/' + path);
  };
  await go('database');
  for (const [label, value] of Object.entries({
    Label: 'Disposable PostgreSQL',
    Host: customer.hostname,
    Port: customer.port || '5432',
    Database: customer.pathname.slice(1),
    Username: decodeURIComponent(customer.username),
    Password: decodeURIComponent(customer.password),
    Schema: process.env.E2E_CUSTOMER_SCHEMA!,
  }))
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel('Use SSL with certificate verification').uncheck();
  await clickSave(
    page.getByRole('button', { name: 'Test and save', exact: true }),
  );
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByText(/Last connection check: success/)).toBeVisible();
  await clickSave(
    page.getByRole('button', { name: 'Retest saved connection' }),
  );
  await go('schema');
  await page.getByLabel('Table name', { exact: true }).fill('products');
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  let field = page
    .locator('fieldset:not(.mutation-boundary)')
    .filter({
      has: page.getByRole('textbox', { name: 'Field name', exact: true }),
    })
    .first();
  await field.getByLabel('Field name', { exact: true }).fill('title');
  await field.getByLabel('Required', { exact: true }).check();
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  field = page
    .locator('fieldset:not(.mutation-boundary)')
    .filter({
      has: page.getByRole('textbox', { name: 'Field name', exact: true }),
    })
    .nth(1);
  await field.getByLabel('Field name', { exact: true }).fill('owner_id');
  await field
    .getByRole('combobox', { name: 'Type', exact: true })
    .selectOption('uuid');
  await page.getByRole('button', { name: 'Create table draft' }).click();
  await expect(page).toHaveURL(/schema\/[a-f0-9-]{36}$/);
  await clickSave(
    page.getByRole('button', { name: 'Preview changes', exact: true }),
  );
  await page
    .getByText('Advanced details: generated SQL and revision', { exact: true })
    .click();
  await expect(page.getByText(/CREATE TABLE/)).toBeVisible();
  await clickSave(
    page.getByRole('button', { name: 'Apply schema', exact: true }),
  );
  await expect(
    page.getByText('Saved draft · Current database schema: Applied', {
      exact: true,
    }),
  ).toBeVisible();
  await go('apis');
  for (const op of ['list', 'get', 'create', 'update', 'delete'])
    await page.getByLabel('Enable ' + op, { exact: true }).check();
  await clickSave(page.getByRole('button', { name: 'Save products API' }));
  await go('keys');
  await page.getByLabel('Name', { exact: true }).fill('Demo key');
  await page
    .getByRole('combobox', { name: 'Scope', exact: true })
    .selectOption('read_write');
  await clickSave(
    page.getByRole('button', { name: 'Generate key', exact: true }),
  );
  const key = (await page.getByTestId('new-key').innerText()).trim();
  expect(key).toMatch(/^pk_/);
  await page.getByRole('button', { name: 'Close and clear secret' }).click();
  await expect(page.getByTestId('new-key')).toHaveCount(0);
  await go('playground');
  async function choose(match: RegExp) {
    const option = page
      .getByRole('combobox', { name: 'Endpoint', exact: true })
      .locator('option')
      .filter({ hasText: match })
      .first();
    await expect(option).toHaveCount(1);
    await page
      .getByRole('combobox', { name: 'Endpoint', exact: true })
      .selectOption((await option.getAttribute('value')) ?? '');
  }
  async function credentials(mode: string, token: string) {
    await page
      .getByRole('combobox', { name: 'Credential mode', exact: true })
      .selectOption(mode);
    if (mode !== 'none')
      await page.getByLabel('Runtime credential', { exact: true }).fill(token);
  }
  async function send(status: number, body?: unknown) {
    if (body !== undefined)
      await page
        .getByLabel('JSON request body', { exact: true })
        .fill(JSON.stringify(body));
    await page
      .getByRole('button', { name: 'Send request', exact: true })
      .click();
    await expect(page.getByTestId('response-status')).toHaveText(
      'HTTP ' + status,
    );
    await expect(
      page.locator('p').filter({ hasText: /^Request ID: / }),
    ).not.toHaveText('Request ID: unavailable');
    const text = await page.getByTestId('response-body').innerText();
    return text === 'Empty response' ? null : JSON.parse(text);
  }
  await choose(/^POST products$/);
  await credentials('key', key);
  const product = await send(201, { title: 'Initial product' });
  expect(product.id).toBeTruthy();
  await go('auth');
  await page.getByLabel('Enable application login', { exact: true }).check();
  await page.getByLabel('Allow signup (optional)', { exact: true }).check();
  await clickSave(
    page.getByRole('button', { name: 'Save auth configuration' }),
  );
  await clickSave(
    page.getByRole('button', { name: 'Create authentication tables' }),
  );
  await expect(page.getByText(/Authentication status: Ready/)).toBeVisible();
  await go('playground');
  for (const name of ['alice', 'bob']) {
    await choose(/^POST auth\/signup$/);
    await credentials('none', '');
    await send(201, { email: `${name}-${suffix}@example.test`, password });
  }
  async function login(name: string) {
    await choose(/^POST auth\/login$/);
    await credentials('none', '');
    const result = await send(200, {
      email: `${name}-${suffix}@example.test`,
      password,
    });
    result.token = await page
      .getByLabel('Runtime credential', { exact: true })
      .inputValue();
    expect(result.token).toMatch(/^us_/);
    return result;
  }
  const alice = await login('alice');
  const bob = await login('bob');
  await go('apis');
  for (const op of ['list', 'get', 'create', 'update', 'delete']) {
    const row = page
      .locator('fieldset:not(.mutation-boundary)')
      .filter({ has: page.getByLabel('Enable ' + op, { exact: true }) });
    await row
      .getByRole('combobox', { name: 'Policy', exact: true })
      .selectOption('owner');
    await row
      .getByRole('combobox', { name: 'Owner field', exact: true })
      .selectOption({ label: 'owner_id' });
  }
  await clickSave(page.getByRole('button', { name: 'Save products API' }));
  await go('playground');
  await choose(/^POST products$/);
  await credentials('session', alice.token);
  const owned = await send(201, { title: 'Alice private' });
  expect(owned.owner_id).toBe(alice.user.id);
  await choose(/^POST products$/);
  await credentials('session', bob.token);
  const bobOwned = await send(201, { title: 'Bob private' });
  expect(bobOwned.owner_id).toBe(bob.user.id);
  await choose(/^GET products\/:id$/);
  await page.getByLabel('Record UUID', { exact: true }).fill(owned.id);
  await send(404);
  await choose(/^PATCH products\/:id$/);
  await page.getByLabel('Record UUID', { exact: true }).fill(owned.id);
  await send(404, { title: 'stolen' });
  await choose(/^DELETE products\/:id$/);
  await page.getByLabel('Record UUID', { exact: true }).fill(owned.id);
  await send(404);
  await choose(/^GET products$/);
  const bobs = await send(200);
  expect(JSON.stringify(bobs)).not.toContain('Alice private');
  // Keep list key-only for observing the workflow transaction independently of owner CRUD.
  await go('apis');
  const listRow = page
    .locator('fieldset:not(.mutation-boundary)')
    .filter({ has: page.getByLabel('Enable list', { exact: true }) });
  await listRow
    .getByRole('combobox', { name: 'Policy', exact: true })
    .selectOption('key_only');
  await clickSave(page.getByRole('button', { name: 'Save products API' }));
  await go('workflows');
  await page.getByLabel('Path slug', { exact: true }).fill('accept-order');
  await page
    .getByRole('button', { name: 'Create workflow', exact: true })
    .click();
  await expect(page).toHaveURL(/workflows\/[a-f0-9-]{36}$/);
  const workflowUrl = new URL(page.url()).pathname;
  await page.getByLabel('Input name', { exact: true }).fill('accept');
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Input type', exact: true })
    .selectOption('boolean');
  const root = page.getByTestId('steps-depth-0');
  await root
    .locator(':scope > fieldset')
    .first()
    .getByRole('button', { name: 'Remove step', exact: true })
    .click();
  await root
    .getByRole('combobox', { name: 'New step type', exact: true })
    .selectOption('insert');
  await root.getByRole('button', { name: 'Add step', exact: true }).click();
  const insert = root.locator(':scope > fieldset').first();
  await insert.getByLabel('Step name', { exact: true }).fill('write_product');
  await insert
    .getByRole('combobox', { name: 'Managed table', exact: true })
    .selectOption({ label: 'products' });
  await insert.getByLabel('Set title (required)', { exact: true }).check();
  await insert
    .getByLabel('title literal', { exact: true })
    .fill('Workflow committed');
  await root
    .getByRole('combobox', { name: 'New step type', exact: true })
    .selectOption('condition');
  await root.getByRole('button', { name: 'Add step', exact: true }).click();
  const condition = root.locator(':scope > fieldset').nth(1);
  await condition
    .getByLabel('Step name', { exact: true })
    .first()
    .fill('accept_condition');
  await condition
    .getByRole('combobox', { name: 'Left source', exact: true })
    .selectOption('reference');
  await condition
    .getByRole('combobox', { name: 'Left reference', exact: true })
    .selectOption({ label: 'Request: accept' });
  const right = condition
    .locator('.card')
    .filter({
      has: page.getByRole('combobox', { name: 'Right source', exact: true }),
    })
    .first();
  await right
    .getByRole('combobox', { name: 'Literal type', exact: true })
    .selectOption('boolean');
  await right
    .getByRole('combobox', { name: 'Right literal', exact: true })
    .selectOption('true');
  const branches = condition.getByTestId('steps-depth-1');
  await branches
    .nth(0)
    .getByRole('combobox', { name: 'Response status', exact: true })
    .selectOption('201');
  await branches
    .nth(1)
    .getByRole('combobox', { name: 'Response status', exact: true })
    .selectOption('422');
  const rejectedBody = branches
    .nth(1)
    .locator('.card')
    .filter({
      has: page.getByRole('combobox', {
        name: 'Response body source',
        exact: true,
      }),
    })
    .first();
  await rejectedBody
    .getByRole('combobox', { name: 'Response body source', exact: true })
    .selectOption('literal');
  await rejectedBody
    .getByLabel('Response body literal', { exact: true })
    .fill('Business rejected');
  await clickSave(
    page.getByRole('button', { name: 'Save workflow draft', exact: true }),
  );
  await clickSave(
    page.getByRole('button', { name: 'Preview workflow', exact: true }),
  );
  await clickSave(
    page.getByRole('button', { name: 'Publish workflow', exact: true }),
  );
  await clickSave(
    page.getByRole('button', { name: 'Enable workflow', exact: true }),
  );
  await go('docs');
  await expect(
    page.getByRole('heading', { name: 'API documentation', exact: true }),
  ).toBeVisible();
  const exported = await page.request.get(
    `/api/management${projectUrl}/openapi`,
  );
  expect(exported.status()).toBe(200);
  const openapi = await exported.json();
  expect(openapi.openapi).toBe('3.1.0');
  expect(openapi.servers[0].url).toContain('/api/demo-');
  expect(openapi.paths['/accept-order'].post.responses['201']).toBeTruthy();
  expect(openapi.paths['/accept-order'].post.responses['422']).toBeTruthy();
  expect(openapi.paths['/auth/login'].post).toBeTruthy();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download openapi.json' }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/-openapi.json$/);
  let runtimeRequests = 0;
  const countRuntime = (request: import('@playwright/test').Request) => {
    if (request.url().includes('/api/runtime/')) runtimeRequests++;
  };
  page.on('request', countRuntime);
  await page
    .locator('article')
    .filter({
      has: page.getByRole('heading', {
        name: 'POST /accept-order',
        exact: true,
      }),
    })
    .getByRole('link', { name: 'Try in Playground' })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Endpoint', exact: true }),
  ).toHaveValue(/^workflow:/);
  await expect(
    page.getByLabel('JSON request body', { exact: true }),
  ).toHaveValue(/"accept": false/);
  await expect(
    page.getByRole('combobox', { name: 'Credential mode', exact: true }),
  ).toHaveValue('key');
  expect(runtimeRequests).toBe(0);
  await expect(page.getByTestId('response-status')).toHaveCount(0);
  page.off('request', countRuntime);
  await page.goto(projectUrl + '/playground?operationId=workflow_missing');
  await expect(
    page.getByRole('alert').filter({ hasText: 'no longer available' }),
  ).toContainText('no longer available');
  await expect(
    page.getByRole('button', { name: 'Send request', exact: true }),
  ).toBeDisabled();
  await go('playground');
  await credentials('key', key);
  await choose(/^GET products$/);
  const before = await send(200);
  const rows = (v: any) => (Array.isArray(v) ? v : (v.data ?? v.rows));
  await choose(/^POST accept-order/);
  await send(201, { accept: true });
  await choose(/^GET products$/);
  const after = await send(200);
  expect(rows(after).length).toBe(rows(before).length + 1);
  await choose(/^POST accept-order/);
  expect(await send(422, { accept: false })).toBe('Business rejected');
  await choose(/^GET products$/);
  const rejected = await send(200);
  expect(rows(rejected).length).toBe(rows(after).length);
  await go('keys');
  await clickSave(page.getByRole('button', { name: 'Revoke', exact: true }));
  await go('playground');
  await choose(/^GET products$/);
  await credentials('key', key);
  await send(401);
  await page.goto(workflowUrl);
  await expect(
    page.getByText('Draft matches published version', { exact: true }),
  ).toBeVisible();
  await clickSave(
    page.getByRole('button', { name: 'Disable workflow', exact: true }),
  );
  await go('playground');
  await expect(
    page
      .getByRole('combobox', { name: 'Endpoint', exact: true })
      .locator('option')
      .filter({ hasText: 'POST accept-order' }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('combobox', { name: 'Credential mode', exact: true }),
  ).toHaveValue('none');
  await expect(
    page.getByLabel('Runtime credential', { exact: true }),
  ).toHaveCount(0);
  await go('keys');
  await page.reload();
  await expect(page.getByText('Demo key', { exact: true })).toBeVisible();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(page.getByTestId('new-key')).toHaveCount(0);
  await go('database');
  await page.reload();
  await expect(page.getByText(/Last connection check: success/)).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await go('schema');
  await expect(
    page.getByRole('link', { name: 'products', exact: true }),
  ).toBeVisible();
  await go('workflows');
  await expect(
    page.getByRole('link', { name: 'POST /accept-order', exact: true }),
  ).toBeVisible();
  const responses = browserResponses.join('\n');
  expect(responses).not.toMatch(/ps_[A-Za-z0-9_-]{43}/);
  expect(responses).not.toContain(decodeURIComponent(customer.password));
  expect(responses).not.toMatch(
    /"(?:encryptedConfig|passwordHash|tokenHash|keyHash|catalog)"/,
  );
  expect(errors).toEqual([]);
});
