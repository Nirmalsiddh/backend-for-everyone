import { test, expect } from '@playwright/test';
import { signupLogin, login } from './platform-account';
import { randomUUID } from 'node:crypto';

test('Reference editor creates enforced managed relationships with raw UUID Playground requests', async ({
  page,
}) => {
  page.on('dialog', (d) => d.accept());
  const existingEmail = process.env.E2E_PLATFORM_ACCOUNT_EMAIL;
  if (existingEmail) await login(page, existingEmail);
  else await signupLogin(page);
  const suffix = randomUUID().slice(0, 8);
  await page
    .getByLabel('Name', { exact: true })
    .fill('Relationships ' + suffix);
  await page
    .getByLabel('Slug', { exact: true })
    .fill('relationships-' + suffix);
  await page
    .getByRole('button', { name: 'Create project', exact: true })
    .click();
  await expect(page).toHaveURL(/projects\/[a-f0-9-]{36}$/);
  const project = new URL(page.url()).pathname;
  const db = new URL(process.env.E2E_CUSTOMER_DATABASE_URL!);
  await page.goto(project + '/database');
  for (const [label, value] of Object.entries({
    Label: 'Disposable relationships',
    Host: db.hostname,
    Port: db.port || '5432',
    Database: db.pathname.slice(1),
    Username: decodeURIComponent(db.username),
    Password: decodeURIComponent(db.password),
    Schema: process.env.E2E_CUSTOMER_SCHEMA!,
  }))
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel('Use SSL with certificate verification').uncheck();
  await page
    .getByRole('button', { name: 'Test and save', exact: true })
    .click();
  await expect(page.getByText(/Last connection check: success/)).toBeVisible();
  async function field(name: string, type: string, required: boolean) {
    await page.getByRole('button', { name: 'Add field', exact: true }).click();
    const row = page
      .locator('fieldset')
      .filter({
        has: page.getByRole('textbox', { name: 'Field name', exact: true }),
      })
      .last();
    await row.getByLabel('Field name', { exact: true }).fill(name);
    await row
      .getByRole('combobox', { name: 'Type', exact: true })
      .selectOption(type);
    if (required) await row.getByLabel('Required', { exact: true }).check();
    return row;
  }
  async function saveApply() {
    await page
      .getByRole('button', { name: 'Create table draft', exact: true })
      .click();
    await expect(page).toHaveURL(/schema\/[a-f0-9-]{36}$/);
    await page
      .getByRole('button', { name: 'Preview changes', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Apply schema', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Apply schema', exact: true })
      .click();
    await expect(
      page.getByText('Saved draft · Current database schema: Applied', {
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.goto(project + '/schema');
  await page.getByLabel('Table name', { exact: true }).fill('customers');
  await field('name', 'text', true);
  await saveApply();
  await page.goto(project + '/schema');
  await page.getByLabel('Table name', { exact: true }).fill('orders');
  const reference = await field('customer_id', 'reference', true);
  await expect(reference.getByLabel('Target table')).toBeEnabled();
  await reference
    .getByLabel('Target table')
    .selectOption({ label: 'customers' });
  await expect(
    reference.getByText('Delete behavior: Prevent deletion while referenced'),
  ).toBeVisible();
  await expect(reference.getByLabel('Unique', { exact: true })).toBeDisabled();
  await expect(
    reference.getByRole('combobox', { name: 'Default', exact: true }),
  ).toBeDisabled();
  await field('total', 'decimal', true);
  await page
    .getByRole('button', { name: 'Create table draft', exact: true })
    .click();
  await expect(page).toHaveURL(/schema\/[a-f0-9-]{36}$/);
  await page
    .getByRole('button', { name: 'Preview changes', exact: true })
    .click();
  await expect(page.getByText(/Reference to customers.id/)).toBeVisible();
  await page.getByRole('button', { name: 'Apply schema', exact: true }).click();
  await expect(
    page.getByText('Saved draft · Current database schema: Applied', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Target table')).toBeDisabled();
  await page.goto(project + '/apis');
  for (const name of ['customers', 'orders']) {
    const card = page
      .locator('section')
      .filter({
        has: page.getByRole('button', {
          name: `Save ${name} API`,
          exact: true,
        }),
      })
      .last();
    await card
      .getByRole('button', { name: 'Select all operations', exact: true })
      .click();
    await card
      .getByRole('button', { name: `Save ${name} API`, exact: true })
      .click();
    await expect(
      page.getByText(`${name} API configuration saved`, { exact: true }),
    ).toBeVisible();
  }
  await page.goto(project + '/keys');
  await page
    .getByLabel('Name', { exact: true })
    .fill('Relationship acceptance');
  await page
    .getByRole('combobox', { name: 'Scope', exact: true })
    .selectOption('read_write');
  await page.getByRole('button', { name: 'Generate key', exact: true }).click();
  const key = (await page.getByTestId('new-key').innerText()).trim();
  await page.getByRole('button', { name: 'Close and clear secret' }).click();
  await page.goto(project + '/playground');
  async function choose(pattern: RegExp) {
    const select = page.getByRole('combobox', {
      name: 'Endpoint',
      exact: true,
    });
    const option = select.locator('option').filter({ hasText: pattern });
    await select.selectOption((await option.getAttribute('value'))!);
    await page
      .getByRole('combobox', { name: 'Credential mode', exact: true })
      .selectOption('key');
    await page.getByLabel('Runtime credential', { exact: true }).fill(key);
  }
  async function send(body: object | undefined, status: number) {
    if (body)
      await page
        .getByLabel('JSON request body', { exact: true })
        .fill(JSON.stringify(body));
    await page
      .getByRole('button', { name: 'Send request', exact: true })
      .click();
    await expect(page.getByTestId('response-status')).toHaveText(
      'HTTP ' + status,
    );
  }
  await choose(/^POST customers$/);
  await send({ name: 'Example customer' }, 201);
  const response = page.getByTestId('response-body');
  const customerId = JSON.parse(await response.innerText()).id as string;
  await choose(/^POST orders$/);
  await expect(
    page
      .locator('p')
      .filter({ hasText: /References customers.id/ })
      .first(),
  ).toBeVisible();
  await send({ customer_id: customerId, total: '12.50' }, 201);
  await send({ customer_id: randomUUID(), total: '12.50' }, 409);
  await expect(page.getByText(/RELATIONSHIP_CONFLICT/).first()).toBeVisible();
  await choose(/^DELETE customers/);
  await page.getByLabel('Record UUID', { exact: true }).fill(customerId);
  await send(undefined, 409);
  await choose(/^GET orders$/);
  await page.getByRole('button', { name: 'Add filter', exact: true }).click();
  await page.getByLabel('Field 1', { exact: true }).selectOption('customer_id');
  await page.getByLabel('Value 1', { exact: true }).fill(customerId);
  await send(undefined, 200);
  const ordinary = JSON.parse(await response.innerText());
  expect(ordinary.data[0]).not.toHaveProperty('_related');
  await page.getByRole('checkbox', { name: 'customer_id', exact: true }).check();
  await send(undefined, 200);
  const expanded = JSON.parse(await response.innerText());
  expect(expanded.data[0]._related.customer_id).toEqual({ id: customerId, name: 'Example customer' });
  await page.goto(project + '/docs');
  await expect(
    page
      .locator('p')
      .filter({ hasText: /References customers.id/ })
      .first(),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Try in Playground' }).first().click();
  await expect(page.getByTestId('response-status')).toHaveCount(0);
});
