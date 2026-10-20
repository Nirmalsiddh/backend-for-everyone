import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveProjectSetupStatus as derive } from '../src/lib/project-setup';
import { operationExamples } from '../src/lib/operation-examples';
import { documentFixture } from './api-docs-fixture';
import {
  tasksPreset,
  validateFields,
  mayReplacePreset,
  ownershipWarning,
} from '../src/lib/schema-form';
import { errorGuidance } from '../src/lib/runtime-guidance';
import type {
  Connection,
  Table,
  Endpoint,
  Auth,
  KeyMetadata,
  Workflow,
} from '../src/lib/contracts';
const connection: Connection = {
  id: 'c',
  label: 'DB',
  lastTestStatus: 'success',
  lastTestedAt: null,
};
const table: Table = {
  id: 't',
  name: 'tasks',
  draftRevision: 1,
  appliedRevision: 1,
  fields: [],
  appliedDefinition: { definition: { name: 'tasks', fields: [] } },
};
const endpoint: Endpoint = {
  id: 'e',
  tableId: 't',
  resourceName: 'tasks',
  enabledOperations: ['list'],
  revision: 1,
};
const auth: Auth = {
  enabled: true,
  signupEnabled: false,
  sessionLifetimeSeconds: 300,
  revision: 1,
  provisioningStatus: 'ready',
};
const key: KeyMetadata = {
  id: 'k',
  name: 'key',
  keyPrefix: 'prefix',
  scope: 'read',
  revokedAt: null,
};
function input() {
  return {
    projectId: 'p',
    connection: { data: null as Connection | null },
    tables: { data: [] as Table[] },
    endpoints: { data: [] as Endpoint[] },
    auth: { data: null as Auth | null },
    keys: { data: [] as KeyMetadata[] },
    workflows: { data: [] as Workflow[] },
  };
}
function configured() {
  const i = input();
  i.connection.data = connection;
  i.tables.data = [table];
  i.endpoints.data = [endpoint];
  return i;
}
test('zero state through applied schema selects deterministic action', () => {
  const i = input();
  assert.equal(derive(i).nextAction.label, 'Connect PostgreSQL');
  i.connection.data = connection;
  assert.equal(derive(i).nextAction.label, 'Create your first table');
  i.tables.data = [{ ...table, appliedRevision: null }];
  assert.equal(derive(i).nextAction.label, 'Preview and apply tasks');
  i.tables.data = [table];
  assert.equal(derive(i).nextAction.label, 'Configure tasks API');
});
test('connection failure, unresolved and running apply priority', () => {
  const i = configured();
  i.connection.data = { ...connection, lastTestStatus: 'failed' };
  assert.match(derive(i).nextAction.label, /retest/);
  i.tables.data = [
    {
      ...table,
      applyStatus: {
        status: 'outcome_unknown',
        migrationId: 'm',
        errorCode: null,
        completedAt: null,
      },
    },
  ];
  assert.equal(derive(i).steps[1].status, 'Blocked');
  assert.match(derive(i).nextAction.label, /unresolved/);
  i.tables.data[0].applyStatus!.status = 'applying';
  assert.match(derive(i).nextAction.label, /in progress/);
});
test('conditional auth, active key scopes, revocation and mixed readiness', () => {
  const i = configured();
  assert.equal(derive(i).nextAction.label, 'Create an API key');
  assert.equal(derive(i).steps[3].status, 'Optional');
  i.keys.data = [key];
  assert.equal(derive(i).readyOperations[0].ready, true);
  i.endpoints.data = [{ ...endpoint, enabledOperations: ['list', 'create'] }];
  assert.deepEqual(
    derive(i).readyOperations.map((o) => o.ready),
    [true, false],
  );
  i.keys.data = [{ ...key, scope: 'read_write' }];
  assert.ok(derive(i).readyOperations.every((o) => o.ready));
  i.keys.data[0].revokedAt = 'today';
  assert.equal(derive(i).readyOperations[0].ready, false);
  i.endpoints.data = [
    { ...endpoint, policies: { list: { mode: 'authenticated' } } },
  ];
  assert.equal(derive(i).nextAction.label, 'Set up application authentication');
  assert.equal(derive(i).steps[4].status, 'Optional');
  i.auth.data = auth;
  assert.equal(derive(i).readyOperations[0].ready, true);
  i.auth.data = { ...auth, blocked: true };
  assert.equal(derive(i).readyOperations[0].ready, false);
});
test('metadata errors and loading are unknown; workflows optional; visit success project scoped', () => {
  const i = configured();
  const s = derive({
    ...i,
    connection: { error: true },
    tables: { loading: true },
  });
  assert.equal(s.steps[0].status, 'Could not check');
  assert.equal(s.steps[1].status, 'Could not check');
  assert.equal(s.optionalSteps[0].status, 'Optional');
  i.keys.data = [key];
  assert.match(derive(i).nextAction.label, /Playground/);
  assert.equal(
    derive({
      ...i,
      successes: [
        { projectId: 'other', operationId: 'crud_tasks_list', success: true },
      ],
    }).tested,
    false,
  );
  assert.match(
    derive({
      ...i,
      successes: [
        { projectId: 'p', operationId: 'crud_tasks_list', success: true },
      ],
    }).nextAction.label,
    /integration example/,
  );
});
test('Tasks presets, overwrite confirmation and pre-apply ownership warning', () => {
  const owned = validateFields(tasksPreset('owned').fields);
  assert.deepEqual(
    owned.map((f) => f.name),
    ['title', 'done', 'owner_id'],
  );
  assert.equal(owned[0].nullable, false);
  assert.equal(owned[2].type, 'uuid');
  assert.equal(owned[2].nullable, false);
  assert.deepEqual(owned[1].default, { kind: 'literal', value: false });
  assert.deepEqual(
    tasksPreset('server').fields.map((f) => f.name),
    ['title', 'done'],
  );
  assert.equal(
    mayReplacePreset(true, () => false),
    false,
  );
  assert.equal(
    mayReplacePreset(true, () => true),
    true,
  );
  assert.equal(
    mayReplacePreset(false, () => {
      throw Error();
    }),
    true,
  );
  assert.match(ownershipWarning, /before the first Apply/);
});
test('runtime and dashboard 401 context', () => {
  assert.match(errorGuidance(401, 'key')!, /project API key/);
  assert.match(errorGuidance(401, 'session')!, /application session token/);
  assert.doesNotMatch(errorGuidance(401, 'session')!, /dashboard|sign in/i);
  assert.match(errorGuidance(401)!, /dashboard session.*Sign in/);
});
for (const method of ['get', 'post', 'patch', 'delete'])
  test(`${method} safe curl/fetch examples`, () => {
    const doc = structuredClone(documentFixture),
      op = structuredClone(doc.paths['/tasks'].post);
    op.operationId = 'test';
    op.security = [{ ProjectApiKey: [] }];
    if (['get', 'delete'].includes(method)) delete op.requestBody;
    else
      op.requestBody!.content['application/json'].example = {
        amount: '9223372036854775807',
        decimal: '1.20',
        title: "it's $(secret) `safe`\nline",
      };
    doc.paths = { '/tasks/{id}': { [method]: op } };
    const s = operationExamples(doc, 'test')!;
    assert.match(s.curl, /<PROJECT_API_KEY>/);
    assert.match(s.curl, /<RECORD_ID>/);
    assert.match(s.javascript, /<RECORD_ID>/);
    assert.match(s.javascript, /response.ok/);
    assert.match(s.javascript, /response.status === 204/);
    assert.match(s.javascript, new RegExp(`method: "${method.toUpperCase()}"`));
    if (op.requestBody) {
      assert.match(s.javascript, /"9223372036854775807"/);
      assert.match(s.javascript, /"1.20"/);
      assert.ok(s.curl.includes("'\\''"));
    } else assert.doesNotMatch(s.javascript, /JSON.stringify|Content-Type/);
    assert.doesNotMatch(s.javascript, /BACKEND_ORIGIN|pk_|us_/);
  });
test('workflow and auth example credentials', () => {
  assert.match(
    operationExamples(documentFixture, 'workflow_place_order')!.javascript,
    /APPLICATION_SESSION_TOKEN/,
  );
  assert.doesNotMatch(
    operationExamples(documentFixture, 'auth_login')!.curl,
    /Authorization/,
  );
});

test('visit store excludes auth/failure data and clears on sign-out', async () => {
  const { recordRuntimeSuccess, getRuntimeSuccesses, clearRuntimeSuccesses } =
    await import('../src/lib/project-visit');
  clearRuntimeSuccesses();
  recordRuntimeSuccess('p', 'auth_login', 200);
  recordRuntimeSuccess('p', 'crud_tasks_list', 401);
  assert.deepEqual(getRuntimeSuccesses(), []);
  recordRuntimeSuccess('p', 'crud_tasks_list', 200);
  recordRuntimeSuccess('p', 'workflow_test', 204);
  assert.deepEqual(getRuntimeSuccesses(), [
    { projectId: 'p', operationId: 'crud_tasks_list', success: true },
    { projectId: 'p', operationId: 'workflow_test', success: true },
  ]);
  clearRuntimeSuccesses();
  assert.deepEqual(getRuntimeSuccesses(), []);
});

test('optional published workflows use published authentication and required key scope', () => {
  const i = configured();
  i.keys.data = [key];
  i.workflows.data = [
    {
      id: 'w',
      path: 'complete-task',
      enabled: true,
      draftRevision: 2,
      publishedVersionId: 'v',
      draftDefinition: { input: {}, auth: 'authenticated', steps: [] },
      publishedDefinition: {
        input: {},
        auth: 'key_only',
        steps: [
          {
            id: 's',
            name: 'delete',
            type: 'delete',
            tableId: 't',
            access: { mode: 'key_only' },
            idValue: { kind: 'literal', value: 'example' },
          },
        ],
      },
      readiness: { state: 'enabled', reasons: [] },
    },
  ];
  assert.equal(derive(i).steps[3].status, 'Optional');
  assert.equal(
    derive(i).readyOperations.find((o) => o.id === 'workflow_complete_task')
      ?.ready,
    false,
  );
  i.keys.data = [{ ...key, scope: 'read_write' }];
  assert.equal(
    derive(i).readyOperations.find((o) => o.id === 'workflow_complete_task')
      ?.ready,
    true,
  );
  i.workflows.data[0].readiness!.state = 'blocked';
  assert.equal(
    derive(i).readyOperations.find((o) => o.id === 'workflow_complete_task')
      ?.ready,
    false,
  );
});

test('rendered runtime errors and copy controls retain accessible context', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ErrorBox } = await import('../src/components/ui');
  const { ApiError } = await import('../src/lib/api');
  const { OperationExamples } = await import(
    '../src/components/operation-examples'
  );
  const error = new ApiError(
    401,
    'UNAUTHORIZED',
    'Invalid credential',
    'request-example',
  );
  const runtime = renderToStaticMarkup(
    createElement(ErrorBox, { error, context: 'session' }),
  );
  assert.match(runtime, /application session token/);
  assert.doesNotMatch(runtime, /dashboard|Sign in/);
  assert.match(
    renderToStaticMarkup(createElement(ErrorBox, { error })),
    /dashboard session.*Sign in/,
  );
  const examples = renderToStaticMarkup(
    createElement(OperationExamples, {
      document: documentFixture,
      operationId: 'crud_tasks_create',
    }),
  );
  assert.match(examples, /aria-label="Copy JavaScript example/);
  assert.match(examples, /role="status"/);
  assert.match(examples, /aria-live="polite"/);
});

test('policy prerequisites are shown only when readiness was checked', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { PolicyEditor } = await import('../src/features/apis/policy');
  const props = {
    value: { mode: 'authenticated' as const },
    onChange: () => {},
    fields: [],
  };
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(PolicyEditor, props)),
    /Set up authentication before/,
  );
  assert.match(
    renderToStaticMarkup(
      createElement(PolicyEditor, {
        ...props,
        authReady: false,
        authHref: '/projects/p/auth',
      }),
    ),
    /Set up authentication before/,
  );
});

test('empty PATCH and a blocked deployed workflow outrank historical request success', () => {
  const i = configured();
  i.keys.data = [{ ...key, scope: 'read_write' }];
  i.endpoints.data = [{ ...endpoint, enabledOperations: ['update'] }];
  const successes = [
    {
      projectId: 'p',
      operationId: 'crud_tasks_update',
      success: true as const,
    },
  ];
  let status = derive({ ...i, successes });
  assert.equal(status.currentReady, false);
  assert.match(status.nextAction.label, /no writable fields/);
  assert.match(status.blockers[0].detail, /no writable fields/);
  i.endpoints.data = [endpoint];
  const definition = { auth: 'key_only' as const, input: {}, steps: [] };
  i.workflows.data = [
    {
      id: 'w',
      path: 'stale-flow',
      enabled: true,
      draftRevision: 1,
      draftDefinition: definition,
      publishedDefinition: definition,
      publishedVersionId: 'v',
      readiness: { state: 'blocked', reasons: ['Applied schema changed'] },
    },
  ];
  status = derive({
    ...i,
    successes: [{ ...successes[0], operationId: 'crud_tasks_list' }],
  });
  assert.equal(status.tested, true);
  assert.equal(status.currentReady, false);
  assert.equal(
    status.readyOperations.find((o) => o.id === 'crud_tasks_list')?.ready,
    true,
  );
  assert.match(status.nextAction.label, /Republish or disable stale-flow/);
  assert.equal(status.nextAction.href, '/projects/p/workflows/w');
  assert.match(
    status.blockers.find((s) => s.id === 'workflows')!.detail,
    /stale-flow/,
  );
});
