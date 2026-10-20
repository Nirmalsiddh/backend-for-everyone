import { test, expect } from '@playwright/test';
import { signupLogin, login } from './platform-account';
import { randomUUID } from 'node:crypto';
test('managed indexes and requiredness preserve APIs, persist after reload, and retain relationship expansion', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  if (process.env.E2E_PLATFORM_ACCOUNT_EMAIL) await login(page, process.env.E2E_PLATFORM_ACCOUNT_EMAIL);
  else await signupLogin(page);
  const suffix = randomUUID().slice(0, 8);
  await page.getByLabel('Name', { exact: true }).fill('Indexes ' + suffix);
  await page.getByLabel('Slug', { exact: true }).fill('indexes-' + suffix);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page).toHaveURL(/projects\/[a-f0-9-]{36}$/);
  const project = new URL(page.url()).pathname;
  const url = new URL(process.env.E2E_CUSTOMER_DATABASE_URL!);
  await page.goto(project + '/database');
  for (const [label, value] of Object.entries({ Label: 'Disposable indexes', Host: url.hostname, Port: url.port || '5432', Database: url.pathname.slice(1), Username: decodeURIComponent(url.username), Password: decodeURIComponent(url.password), Schema: process.env.E2E_CUSTOMER_SCHEMA! })) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel('Use SSL with certificate verification').uncheck();
  await page.getByRole('button', { name: 'Test and save', exact: true }).click();
  await expect(page.getByText(/Last connection check: success/)).toBeVisible();
  async function field(name: string, type: string) {
    await page.getByRole('button', { name: 'Add field', exact: true }).click();
    const row = page.locator('fieldset').filter({ has: page.getByRole('textbox', { name: 'Field name', exact: true }) }).last();
    await row.getByLabel('Field name', { exact: true }).fill(name); await row.getByRole('combobox', { name: 'Type', exact: true }).selectOption(type); return row;
  }
  async function previewApply() {
    await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply schema', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Apply schema', exact: true }).click();
  }
  async function createApply() {
    await page.getByRole('button', { name: 'Create table draft', exact: true }).click();
    await expect(page).toHaveURL(/schema\/[a-f0-9-]{36}$/); await previewApply();
    await expect(page.getByText('Saved draft · Current database schema: Applied', { exact: true })).toBeVisible();
  }
  await page.goto(project + '/schema'); await page.getByLabel('Table name', { exact: true }).fill('index_customers'); await field('name', 'text'); await createApply();
  await page.goto(project + '/schema'); await page.getByLabel('Table name', { exact: true }).fill('products_indexes');
  await field('category', 'integer'); await field('sku', 'uuid'); await field('title', 'text');
  const reference = await field('customer_id', 'reference'); await reference.getByLabel('Target table').selectOption({ label: 'index_customers' });
  await createApply(); const tablePath = new URL(page.url()).pathname;
  await expect(page.getByText(/customer_id · automatic relationship index/)).toBeVisible();
  await page.goto(project + '/apis');
  for (const name of ['index_customers', 'products_indexes']) {
    const card = page.locator('section').filter({ has: page.getByRole('button', { name: `Save ${name} API`, exact: true }) }).last();
    await card.getByRole('button', { name: 'Select all operations', exact: true }).click();
    await card.getByRole('button', { name: `Save ${name} API`, exact: true }).click();
    await expect(page.getByText(`${name} API configuration saved`, { exact: true })).toBeVisible();
  }
  await page.goto(project + '/keys'); await page.getByLabel('Name', { exact: true }).fill('Index acceptance'); await page.getByRole('combobox', { name: 'Scope', exact: true }).selectOption('read_write');
  await page.getByRole('button', { name: 'Generate key', exact: true }).click(); const key = (await page.getByTestId('new-key').innerText()).trim(); await page.getByRole('button', { name: 'Close and clear secret' }).click();
  async function choose(pattern: RegExp) {
    const select = page.getByRole('combobox', { name: 'Endpoint', exact: true }); const option = select.locator('option').filter({ hasText: pattern }); await select.selectOption((await option.getAttribute('value'))!);
    await page.getByRole('combobox', { name: 'Credential mode', exact: true }).selectOption('key'); await page.getByLabel('Runtime credential', { exact: true }).fill(key);
  }
  async function send(body: object | undefined, status: number) {
    if (body) await page.getByLabel('JSON request body', { exact: true }).fill(JSON.stringify(body));
    await page.getByRole('button', { name: 'Send request', exact: true }).click(); await expect(page.getByTestId('response-status')).toHaveText('HTTP ' + status);
    return JSON.parse(await page.getByTestId('response-body').innerText());
  }
  await page.goto(project + '/playground'); await choose(/^POST index_customers$/); const customer = await send({ name: 'Example' }, 201);
  await choose(/^POST products_indexes$/); const records = [];
  for (let index = 0; index < 3; index++) records.push(await send({ category: 7, sku: randomUUID(), title: null, customer_id: customer.id }, 201));
  await page.goto(tablePath); await page.getByRole('button', { name: 'Add index', exact: true }).click();
  await page.getByRole('combobox', { name: 'Index 1 field 1', exact: true }).selectOption({ label: 'category' }); await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Schema draft saved', { exact: true })).toBeVisible(); await previewApply(); await expect(page.getByText('Schema applied', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('combobox', { name: 'Index 1 field 1', exact: true })).toBeDisabled();
  await page.goto(project + '/playground'); await choose(/^GET products_indexes$/);
  await page.getByRole('button', { name: 'Add filter', exact: true }).click(); await page.getByLabel('Field 1', { exact: true }).selectOption('category'); await page.getByLabel('Value 1', { exact: true }).fill('7'); await page.getByRole('checkbox', { name: 'customer_id', exact: true }).check();
  const listed = await send(undefined, 200); expect(listed.data).toHaveLength(3); expect(listed.data[0]._related.customer_id.name).toBe('Example');
  await page.goto(tablePath); await page.getByRole('button', { name: 'Add index', exact: true }).click(); await page.getByLabel('Unique index 2', { exact: true }).check();
  await page.getByRole('combobox', { name: 'Index 2 field 1', exact: true }).selectOption({ label: 'sku' }); await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Schema draft saved', { exact: true })).toBeVisible(); await previewApply(); await expect(page.getByText('Schema applied', { exact: true })).toBeVisible();
  await page.goto(project + '/playground'); await choose(/^POST products_indexes$/); const conflict = await send({ sku: records[0].sku }, 409); expect(conflict.code).toBe('VALUE_CONFLICT'); expect(JSON.stringify(conflict)).not.toContain(records[0].sku);
  await page.goto(tablePath); await page.getByLabel('Make title required · All existing rows must already have a value.').check(); await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Schema draft saved', { exact: true })).toBeVisible(); await previewApply(); await expect(page.getByRole('alert').filter({ hasText: 'SCHEMA_DATA_INVALID' })).toBeVisible();
  await page.goto(project + '/playground'); await choose(/^PATCH products_indexes/);
  for (const record of records) { await page.getByLabel('Record UUID', { exact: true }).fill(record.id); await send({ title: 'Filled' }, 200); }
  await page.goto(tablePath); await previewApply(); await expect(page.getByText('Schema applied', { exact: true })).toBeVisible();
  await page.goto(project + '/playground'); await choose(/^POST products_indexes$/); await send({}, 400); await send({ title: null }, 400); await send({ title: 'New' }, 201);
  await page.goto(project + '/docs'); await expect(page.getByText(/products_indexes/).first()).toBeVisible();
  await page.goto(tablePath); await page.reload(); await expect(page.getByRole('combobox', { name: 'Index 2 field 1', exact: true })).toBeDisabled();
});
