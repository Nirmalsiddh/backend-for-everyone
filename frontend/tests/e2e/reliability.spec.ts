import { signupLogin } from './platform-account';
import { test, expect, type Page } from '@playwright/test';
const id = '11111111-1111-4111-8111-111111111111';
const tableId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
const owner = '44444444-4444-4444-8444-444444444444';
const fields = [
  {
    id: owner,
    name: 'owner_id',
    type: 'uuid',
    nullable: true,
    unique: false,
    default: null,
    options: {},
  },
];
function table(name: string, id: string) {
  return {
    id,
    name,
    draftRevision: 1,
    appliedRevision: 1,
    fields,
    appliedDefinition: { definition: { name, fields } },
  };
}
let fixtureCookies: Awaited<ReturnType<ReturnType<Page['context']>['cookies']>> | undefined;
async function fixture(page: Page, workflow?: any) {
  if (fixtureCookies) await page.context().addCookies(fixtureCookies);
  else { await signupLogin(page); fixtureCookies = await page.context().cookies(); }
  let endpoints: any[] = [];
  let connection = {
    id: tableId,
    label: 'Test database',
    lastTestStatus: 'success',
    lastTestedAt: '2026-10-18T10:00:00Z',
  };
  let auth = {
    enabled: true,
    signupEnabled: true,
    sessionLifetimeSeconds: 86400,
    revision: 1,
    provisioningStatus: 'unprovisioned',
  };
  const project = { id, name: 'Test project', slug: 'test-project' };
  await page.route('**/api/management/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/api/management/')[1];
    let data: unknown = project;
    let status = 200;
    if (path.endsWith('/schema'))
      data = [table('products', tableId), table('orders', secondId)];
    else if (path.endsWith('/endpoints')) data = endpoints;
    else if (path.endsWith('/api') && request.method() === 'PUT') {
      const body = request.postDataJSON();
      const tid = path.split('/tables/')[1].split('/')[0];
      const row = {
        id: tid,
        tableId: tid,
        resourceName: tid === tableId ? 'products' : 'orders',
        revision: 1,
        enabledOperations: body.enabledOperations,
        policies: body.policies,
      };
      endpoints = [...endpoints.filter((e) => e.tableId !== tid), row];
      data = row;
    } else if (path.endsWith('/database-connection/test')) {
      connection = { ...connection, lastTestStatus: 'failed' };
      status = 422;
      data = { code: 'CONNECTION_FAILED', message: 'Connection check failed' };
    } else if (path.endsWith('/database-connection')) data = connection;
    else if (path.endsWith('/auth/provision')) {
      auth = { ...auth, revision: 3, provisioningStatus: 'failed' };
      status = 422;
      data = {
        code: 'AUTH_PROVISION_FAILED',
        message: 'Authentication tables could not be created',
      };
    } else if (path.endsWith('/auth')) data = auth;
    else if (path.endsWith('/api-keys'))
      data = request.method() === 'POST' ? { key: 'pk_once', id: tableId } : [];
    else if (path.endsWith('/workflows')) data = workflow ? [workflow] : [];
    else if (path.includes('/workflows/')) data = workflow;
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'x-request-id': 'fixture-id' },
      body: JSON.stringify(data),
    });
  });
  return {
    setEndpoints: (rows: any[]) => {
      endpoints = rows;
    },
  };
}

test('saving one API preserves another editor, refetch and dirty sidebar navigation', async ({
  page,
}) => {
  await fixture(page);
  await page.goto(`/projects/${id}/apis`);
  const products = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'products', exact: true }),
  });
  const orders = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'orders', exact: true }),
  });
  await products.getByLabel('Enable list', { exact: true }).check();
  await orders.getByLabel('Enable create', { exact: true }).check();
  await products.getByRole('button', { name: 'Save products API' }).click();
  await expect(
    products.getByText('products API configuration saved'),
  ).toBeVisible();
  await expect(
    orders.getByLabel('Enable create', { exact: true }),
  ).toBeChecked();
  await page
    .getByRole('button', { name: 'Refresh saved status (keep edits)' })
    .click();
  await expect(
    orders.getByLabel('Enable create', { exact: true }),
  ).toBeChecked();
  await page.getByRole('link', { name: 'Database', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(
    orders.getByLabel('Enable create', { exact: true }),
  ).toBeChecked();
  await page.getByRole('link', { name: 'Database', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save and leave' }).click();
  await expect(page).toHaveURL(new RegExp('/database$'));
  await page.goto(`/projects/${id}/apis`);
  await expect(
    page.getByLabel('Enable create', { exact: true }).nth(1),
  ).toBeChecked();
});

test('owner selection is deliberate and dirty project navigation supports discard', async ({
  page,
}) => {
  await fixture(page);
  await page.goto(`/projects/${id}/apis`);
  const row = page
    .locator('fieldset')
    .filter({ has: page.getByLabel('Enable list', { exact: true }) })
    .first();
  await row.getByLabel('Enable list', { exact: true }).check();
  await row
    .getByRole('combobox', { name: 'Policy', exact: true })
    .selectOption('owner');
  await expect(
    row.getByRole('combobox', { name: 'Owner field', exact: true }),
  ).toHaveValue('');
  await expect(
    row.getByRole('combobox', { name: 'Owner field', exact: true }),
  ).toHaveAttribute('required', '');
  await page.getByRole('link', { name: 'All projects', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: 'Discard and leave' })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
});

test('failed retest and failed provisioning refresh authoritative status', async ({
  page,
}) => {
  await fixture(page);
  page.on('dialog', (d) => d.accept());
  await page.goto(`/projects/${id}/database`);
  await page.getByRole('button', { name: 'Retest saved connection' }).click();
  await expect(page.getByText(/Last connection check: failed/)).toBeVisible();
  await page.goto(`/projects/${id}/auth`);
  await page
    .getByRole('button', { name: 'Create authentication tables' })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Authentication status:' }),
  ).toContainText('Failed');
  await expect(
    page.getByRole('status').filter({ hasText: 'Authentication status:' }),
  ).toContainText('Revision 3');
});

async function delayedLogin(page: Page) {
  await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let received!: () => void;
  const started = new Promise<void>((r) => {
    received = r;
  });
  await page.route('**/api/runtime/**', async (route) => {
    received();
    await gate;
    await route
      .fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'us_delayed_secret',
          expiresIn: 60,
          user: { id: owner, email: 'alice@example.test', role: 'user' },
        }),
      })
      .catch(() => {});
  });
  await page.goto(`/projects/${id}/playground`);
  await page
    .getByRole('combobox', { name: 'Endpoint', exact: true })
    .selectOption('auth:login');
  await page
    .getByLabel('JSON request body', { exact: true })
    .fill('{"email":"alice@example.test","password":"password-for-testing"}');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await started;
  return release;
}

test('clear during pending login suppresses late token and reload does not restore it', async ({
  page,
}) => {
  const release = await delayedLogin(page);
  await page
    .getByRole('button', { name: 'Clear credentials and response' })
    .click();
  release();
  await expect(
    page.getByLabel('JSON request body', { exact: true }),
  ).not.toHaveValue(/password-for-testing/);
  await expect(
    page.getByRole('combobox', { name: 'Credential mode', exact: true }),
  ).toHaveValue('none');
  await expect(page.getByTestId('response-status')).toHaveCount(0);
  await expect(page.getByText('us_delayed_secret')).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('combobox', { name: 'Credential mode', exact: true }),
  ).toHaveValue('none');
});

test('switching target suppresses pending response', async ({ page }) => {
  const release = await delayedLogin(page);
  await page
    .getByRole('combobox', { name: 'Endpoint', exact: true })
    .selectOption('auth:me');
  release();
  await expect(page.getByTestId('response-status')).toHaveCount(0);
  await expect(
    page.getByRole('combobox', { name: 'Credential mode', exact: true }),
  ).toHaveValue('none');
});

test('login hides token, logout clears credential, JSON null differs from empty', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/runtime/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    return path.endsWith('/login')
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            token: 'us_transient',
            expiresIn: 60,
            user: { id: owner, email: 'alice@example.test' },
          }),
        })
      : path.endsWith('/logout')
        ? route.fulfill({ status: 204 })
        : route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: 'null',
          });
  });
  await page.goto(`/projects/${id}/playground`);
  await page
    .getByRole('combobox', { name: 'Endpoint', exact: true })
    .selectOption('auth:login');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByTestId('response-status')).toHaveText('HTTP 200');
  await expect(page.getByTestId('response-body')).not.toContainText(
    'us_transient',
  );
  await expect(
    page.getByLabel('Runtime credential', { exact: true }),
  ).toHaveValue('us_transient');
  await page
    .getByRole('combobox', { name: 'Endpoint', exact: true })
    .selectOption('auth:me');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByTestId('response-body')).toHaveText('null');
  await page
    .getByRole('combobox', { name: 'Endpoint', exact: true })
    .selectOption('auth:logout');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByTestId('response-status')).toHaveText('HTTP 204');
  await expect(page.getByTestId('response-body')).toHaveText('Empty response');
  await expect(
    page.getByRole('combobox', { name: 'Credential mode', exact: true }),
  ).toHaveValue('none');
});

test('one-time secret dialog handles clipboard denial and Escape clears it', async ({
  page,
}) => {
  await fixture(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Denied');
        },
      },
    }),
  );
  await page.goto(`/projects/${id}/keys`);
  await page.getByLabel('Name', { exact: true }).fill('Key');
  await page.getByRole('button', { name: 'Generate key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy your key now' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Clipboard unavailable',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('new-key')).toHaveCount(0);
});

test('workflow branch removal warns and moving steps flags invalid references', async ({
  page,
}) => {
  const queryId = '55555555-5555-4555-8555-555555555555';
  const response = (name: string) => ({
    id: crypto.randomUUID(),
    name,
    type: 'response',
    status: 200,
    body: { kind: 'object', fields: {} },
  });
  const workflow = {
    id: secondId,
    path: 'conditional',
    enabled: false,
    publishedVersionId: null,
    draftRevision: 1,
    draftDefinition: {
      auth: 'key_only',
      input: {},
      steps: [
        {
          id: queryId,
          name: 'read',
          type: 'query',
          tableId,
          access: { mode: 'key_only' },
          select: ['id'],
          idValue: { kind: 'literal', value: owner },
          onMissing: '404',
        },
        {
          id: crypto.randomUUID(),
          name: 'branch',
          type: 'condition',
          operator: 'equals',
          left: {
            kind: 'reference',
            source: 'step',
            stepId: queryId,
            path: ['row', 'id'],
          },
          right: { kind: 'literal', value: owner },
          then: [response('yes')],
          else: [response('no')],
        },
      ],
    },
  };
  await fixture(page, workflow);
  await page.goto(`/projects/${id}/workflows/${secondId}`);
  const root = page.getByTestId('steps-depth-0');
  const condition = root.locator(':scope > fieldset').nth(1);
  page.once('dialog', (d) => d.dismiss());
  await condition
    .getByRole('button', { name: 'Remove step', exact: true })
    .first()
    .click();
  await expect(root.locator(':scope > fieldset')).toHaveCount(2);
  await root
    .locator(':scope > fieldset')
    .first()
    .getByRole('button', { name: 'Move down', exact: true })
    .click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'This reference is no longer available here' }),
  ).toBeVisible();
  await expect(page.getByText(/unreachable, move\/remove/)).toBeVisible();
});
