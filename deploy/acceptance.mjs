// Explicit destructive-on-disposable-target acceptance. No secret values in argv.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
let config;
try { config = JSON.parse(await readFile(process.env.ACCEPTANCE_CONFIG, 'utf8')); }
catch { console.error('Invalid protected deployment test configuration'); process.exit(1); }
if (config.disposable !== true) throw new Error('Disposable target confirmation required');
const app = new URL(config.appOrigin).origin, api = new URL(config.apiOrigin).origin;
if (!app.startsWith('https:') || !api.startsWith('https:')) throw new Error('HTTPS required');
let cookie;
async function call(origin, path, method = 'GET', body, expected = 200, runtime = false) {
  const headers = { origin: app };
  if (cookie && !runtime) headers.cookie = cookie;
  if (runtime) headers.authorization = `Bearer ${config.runtimeKey}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(25000) });
  if (response.status !== expected) {
    const result = await response.json().catch(() => ({}));
    throw new Error(`Acceptance ${method} ${path} failed: HTTP ${response.status} ${result.code ?? ''}`);
  }
  if (path === '/api/auth/login') {
    const value = response.headers.get('set-cookie') ?? '';
    if (!value.startsWith('__Host-platform_session=') || !value.includes('Secure') || !value.includes('HttpOnly')) throw new Error('Unsafe cookie');
    cookie = value.split(';')[0];
  }
  return response.status === 204 ? undefined : response.json();
}
async function management(path, method, body, expected) { return call(app, '/api/management/' + path, method, body, expected); }
async function verify(state) {
  cookie = state.cookie; config.runtimeKey = state.runtimeKey;
  await management(`projects/${state.projectId}`);
  await management(`projects/${state.projectId}/database-connection/test`, 'POST');
  await call(api, state.runtimePath, 'GET', undefined, 200, true);
  await call(api, state.workflowPath, 'POST', {}, 200, true);
}
async function main() {
  if (config.verifyState) {
    await verify(JSON.parse(await readFile(config.verifyState, 'utf8')));
    console.log('Restart acceptance passed: original session, project, encrypted connection, runtime and workflow'); return;
  }
  const credentials = { email: config.email, password: config.password };
  await call(app, '/api/auth/signup', 'POST', credentials, 202);
  await call(app, '/api/auth/login', 'POST', credentials);
  const suffix = randomUUID().slice(0, 8), slug = `deployment-${suffix}`;
  const project = await management('projects', 'POST', { name: 'Deployment acceptance', slug }, 201);
  const base = `projects/${project.id}`;
  const connection = { ...config.customerConnection, schema: config.customerConnection.schema ?? 'public' };
  for (const [candidate, expectedCode] of [[{ ...connection, host: '127.0.0.1' }, 'DESTINATION_NOT_ALLOWED'], [{ ...connection, ssl: false }, 'TLS_REQUIRED']]) {
    const result = await management(base + '/database-connection', 'POST', candidate, 422);
    if (result.code !== expectedCode) throw new Error('Unexpected policy rejection');
  }
  await management(base + '/database-connection', 'POST', connection, 201);
  const table = await management(base + '/schema/tables', 'POST', { name: `acceptance_${suffix}`, fields: [{ name: 'title', type: 'text', nullable: false }] }, 201);
  const tableBase = base + `/schema/tables/${table.id}`;
  const preview = await management(tableBase + '/preview', 'POST');
  await management(tableBase + '/apply', 'POST', { expectedDraftRevision: table.draftRevision, planHash: preview.planHash });
  await management(tableBase + '/api', 'PUT', { enabledOperations: ['list', 'create'], expectedAppliedRevision: 1, expectedConfigRevision: 0 });
  const key = await management(base + '/api-keys', 'POST', { name: 'Disposable deployment acceptance', scope: 'read_write' }, 201);
  config.runtimeKey = key.key;
  const runtimePath = `/api/${slug}/${table.name}`;
  await call(api, runtimePath, 'POST', { title: 'HTTPS deployment' }, 201, true);
  await call(api, runtimePath, 'GET', undefined, 200, true);
  const workflow = await management(base + '/workflows', 'POST', { path: 'acceptance-flow', definition: {
    auth: 'key_only', input: {}, steps: [
      { id: randomUUID(), name: 'insert_record', type: 'insert', tableId: table.id, access: { mode: 'key_only' }, select: ['id'], values: { [table.fields.find((field) => field.name === 'title').id]: { kind: 'literal', value: 'Workflow acceptance' } } },
      { id: randomUUID(), name: 'done', type: 'response', status: 200, body: { kind: 'object', fields: {} } },
    ],
  } }, 201);
  const workflowBase = base + `/workflows/${workflow.id}`;
  const workflowPreview = await management(workflowBase + '/preview', 'POST');
  await management(workflowBase + '/publish', 'POST', { expectedDraftRevision: workflow.draftRevision, definitionHash: workflowPreview.definitionHash });
  await management(workflowBase, 'PATCH', { expectedDraftRevision: workflow.draftRevision, enabled: true });
  const state = { cookie, projectId: project.id, runtimeKey: key.key, runtimePath, workflowPath: `/api/${slug}/acceptance-flow` };
  await verify(state);
  await writeFile(config.stateFile, JSON.stringify(state), { mode: 0o600 });
  console.log('Disposable HTTPS acceptance passed: signup/login, project, destination/TLS rejection, schema, generated API and workflow');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
