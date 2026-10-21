import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { signupLogin, login } from './platform-account';

test('safe field evolution persists intent, rolls back NULL failure, and aligns runtime, OpenAPI and SDK', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  if (process.env.E2E_PLATFORM_ACCOUNT_EMAIL) await login(page, process.env.E2E_PLATFORM_ACCOUNT_EMAIL); else await signupLogin(page);
  async function request(path: string, method = 'GET', body?: unknown) {
    return page.evaluate(async ({ path, method, body }) => {
      const response = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    }, { path, method, body });
  }
  async function call(path: string, method = 'GET', body?: unknown) { const response = await request(path, method, body); expect(response.status, JSON.stringify(response.body)).toBeLessThan(300); return response.body; }
  const suffix = randomUUID().slice(0, 8);
  const project = await call('/api/management/projects', 'POST', { name: 'Evolution ' + suffix, slug: 'evolution-' + suffix });
  const base = '/api/management/projects/' + project.id;
  const url = new URL(process.env.E2E_CUSTOMER_DATABASE_URL!);
  await call(base + '/database-connection', 'POST', { label: 'Evolution fixture', host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), schema: process.env.E2E_CUSTOMER_SCHEMA, ssl: false });
  const table = await call(base + '/schema/tables', 'POST', { name: 'evolution_records', fields: [{ name: 'status', type: 'text' }, { name: 'category', type: 'integer' }] });
  const path = base + '/schema/tables/' + table.id;
  async function apply() { const preview = await call(path + '/preview', 'POST'); return request(path + '/apply', 'POST', { expectedDraftRevision: preview.draftRevision, planHash: preview.planHash }); }
  expect((await apply()).status).toBe(200);
  await call(path + '/api', 'PUT', { enabledOperations: ['create', 'get', 'list', 'update'], expectedAppliedRevision: 1, expectedConfigRevision: 0 });
  const key = (await call(base + '/api-keys', 'POST', { name: 'Evolution fixture', scope: 'read_write' })).key;
  async function create(body: object) {
    const response = await page.request.post('http://127.0.0.1:3010/api/' + project.slug + '/evolution_records', { headers: { authorization: 'Bearer ' + key }, data: body });
    return { status: response.status(), body: await response.json() };
  }
  expect((await create({ status: null, category: 1 })).status).toBe(201);
  const kept = await create({ status: 'kept', category: 2 }); expect(kept.status).toBe(201);
  const before = await call(base + '/sdk/typescript');
  await page.goto('/projects/' + project.id + '/schema/' + table.id);
  const statusRow = page.locator('fieldset').filter({ has: page.getByRole('textbox', { name: 'Field name', exact: true }) }).first();
  await statusRow.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Schema draft saved', { exact: true })).toBeVisible();
  expect((await call(base + '/sdk/typescript')).source).toBe(before.source);
  expect((await apply()).body.code).toBe('SCHEMA_DATA_INVALID');
  expect((await call(base + '/sdk/typescript')).source).toBe(before.source);
  await page.reload();
  await page.getByLabel('Fill existing NULL values with', { exact: true }).check();
  await page.getByLabel('Fill value', { exact: true }).fill('legacy');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect(page.getByText('Schema draft saved', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByLabel('Fill value', { exact: true })).toHaveValue('legacy');
  await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
  await expect(page.getByText('Existing NULL values in status will be replaced.', { exact: true })).toBeVisible();
  await expect(page.getByText('status will become required.', { exact: true })).toBeVisible();
  await expect(page.getByText('Advanced details: generated SQL and revision', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Apply schema', exact: true }).click(); await expect(page.getByText('Schema applied', { exact: true })).toBeVisible();
  expect((await create({ status: null })).status).toBe(400); expect((await create({})).status).toBe(400);
  const list = await page.request.get('http://127.0.0.1:3010/api/' + project.slug + '/evolution_records', { headers: { authorization: 'Bearer ' + key } });
  const rows = (await list.json()).data; expect(rows.some((row: any) => row.status === 'legacy')).toBe(true); expect(rows.find((row: any) => row.id === kept.body.id).status).toBe('kept');
  let previousHash = '';
  for (const value of ['new', 'changed', undefined]) {
    await page.reload();
    await page.getByRole('combobox', { name: 'Default', exact: true }).first().selectOption(value === undefined ? 'none' : 'literal');
    if (value !== undefined) await page.getByRole('textbox', { name: /^Default value/ }).first().fill(value);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect(page.getByText('Schema draft saved', { exact: true })).toBeVisible();
    expect((await apply()).status).toBe(200);
    const sdk = await call(base + '/sdk/typescript');
    if (value === 'changed') expect(sdk.contractHash).toBe(previousHash);
    previousHash = sdk.contractHash;
    expect(sdk.source).not.toContain('"legacy"');
    const doc = await call(base + '/openapi');
    const required = doc.paths['/evolution_records'].post.requestBody.content['application/json'].schema.required ?? [];
    expect(required.includes('status')).toBe(value === undefined);
    const created = await create({}); expect(created.status).toBe(value === undefined ? 400 : 201); if (value !== undefined) expect(created.body.status).toBe(value);
  }
  const current = await call(path);
  const fields = current.fields.map(({ default: def, ...field }: any) => ({ ...field, ...(def ? { default: def } : {}) }));
  fields.push({ name: 'fill_only', type: 'text', nullable: false, backfillIntent: { kind: 'literal', value: 'history_only' } });
  const fillDraft = await call(path + '/draft', 'PUT', { name: current.name, expectedDraftRevision: current.draftRevision, fields });
  await page.reload(); await expect(page.getByLabel('Fill value', { exact: true })).toHaveValue('history_only');
  expect((await apply()).status).toBe(200);
  expect((await call(path)).draftRevision).toBe(fillDraft.draftRevision);
  await page.getByRole('button', { name: 'Refresh saved status (keep edits)', exact: true }).click();
  await expect(page.getByLabel('Fill value', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Schema draft saved', { exact: true })).toBeVisible();
  expect((await create({ status: 'provided' })).status).toBe(400);
  expect((await create({ status: 'provided', fill_only: 'provided' })).status).toBe(201);
  const sdk = await call(base + '/sdk/typescript'); expect(sdk.source).not.toContain('history_only');
  const indexed = await call(path);
  await call(path + '/draft', 'PUT', { name: indexed.name, expectedDraftRevision: indexed.draftRevision, fields: indexed.fields.map(({ default: def, ...field }: any) => ({ ...field, ...(def ? { default: def } : {}) })), indexes: [{ fieldIds: [indexed.fields.find((field: any) => field.name === 'category').id], unique: false }] });
  expect((await apply()).status).toBe(200); expect((await call(base + '/sdk/typescript')).source).toBe(sdk.source);
  const both = await call(path);
  const bothFields = both.fields.map(({ default: def, ...field }: any) => ({ ...field, ...(def ? { default: def } : {}) }));
  bothFields.push({ name: 'both_values', type: 'text', nullable: false, backfillIntent: { kind: 'literal', value: 'historical_both_marker' }, default: { kind: 'literal', value: 'future_both_marker' } });
  await call(path + '/draft', 'PUT', { name: both.name, expectedDraftRevision: both.draftRevision, fields: bothFields, indexes: both.indexes.map(({ specificationVersion: _, ...index }: any) => index) }); expect((await apply()).status).toBe(200);
  expect((await create({ status: 'provided', fill_only: 'provided' })).body.both_values).toBe('future_both_marker');
  expect((await call(base + '/sdk/typescript')).source).not.toContain('historical_both_marker');
  async function fixtureTable(name: string, fields: object[]) {
    const record = await call(base + '/schema/tables', 'POST', { name, fields });
    const fixturePath = base + '/schema/tables/' + record.id;
    const preview = await call(fixturePath + '/preview', 'POST');
    await call(fixturePath + '/apply', 'POST', { expectedDraftRevision: preview.draftRevision, planHash: preview.planHash });
    await call(fixturePath + '/api', 'PUT', { enabledOperations: ['create', 'list'], expectedAppliedRevision: 1, expectedConfigRevision: 0 });
    return { ...record, fixturePath };
  }
  async function fixtureCreate(resource: string, body: object) {
    const response = await page.request.post('http://127.0.0.1:3010/api/' + project.slug + '/' + resource, { headers: { authorization: 'Bearer ' + key }, data: body });
    expect(response.status()).toBe(201); return response.json();
  }
  async function failingFill(record: any, value: unknown, code: string) {
    const current = await call(record.fixturePath);
    const fields = current.fields.map(({ default: def, ...field }: any) => ({ ...field, ...(def ? { default: def } : {}), nullable: false, backfillIntent: { kind: 'literal', value } }));
    await call(record.fixturePath + '/draft', 'PUT', { name: current.name, expectedDraftRevision: current.draftRevision, fields });
    const preview = await call(record.fixturePath + '/preview', 'POST');
    const failed = await request(record.fixturePath + '/apply', 'POST', { expectedDraftRevision: preview.draftRevision, planHash: preview.planHash }); expect(failed.body.code).toBe(code);
    expect((await call(record.fixturePath)).appliedRevision).toBe(1);
  }
  const unique = await fixtureTable('evolution_unique', [{ name: 'value_key', type: 'integer', unique: true }]);
  await fixtureCreate(unique.name, {}); await fixtureCreate(unique.name, {});
  await failingFill(unique, 7, 'SCHEMA_DATA_INVALID');
  const parent = await fixtureTable('evolution_parent', [{ name: 'name', type: 'text' }]);
  const child = await fixtureTable('evolution_child', [{ name: 'parent_id', type: 'uuid', relationship: { tableId: parent.id, onDelete: 'restrict' } }]);
  await fixtureCreate(child.name, {});
  await failingFill(child, randomUUID(), 'RELATIONSHIP_CONFLICT');

});
