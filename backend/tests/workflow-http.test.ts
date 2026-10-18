import { memoryPlatformAuthRepository } from './platform-auth-helpers.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { env, memoryRepository } from './helpers.js';
import { CredentialEncryption } from '../src/security/encryption.js';
import type { WorkflowDefinition, WorkflowRepository, WorkflowTarget } from '../src/modules/workflows/types.js';
const fail = async (): Promise<never> => { throw new Error('Unexpected management operation'); };
test('fixed POST route dispatches published workflows, validates input and keeps workflow data out of logs', async () => {
  const projectId = randomUUID(); const connectionId = randomUUID(); const now = new Date(); const key = `pk_${'a'.repeat(43)}`;
  const definition: WorkflowDefinition = { input: { text: { type: 'string', required: true, maxLength: 100 } }, auth: 'key_only', steps: [{ id: randomUUID(), name: 'respond', type: 'response', status: 200, body: { kind: 'reference', source: 'request', path: ['body', 'text'] } }] };
  const endpoint = { id: randomUUID(), projectId, connectionId, path: 'echo', method: 'POST' as const, enabled: true, draftDefinition: definition, draftRevision: 1, publishedVersionId: randomUUID(), createdAt: now, updatedAt: now };
  const target: WorkflowTarget = { endpoint, version: { id: endpoint.publishedVersionId, workflowEndpointId: endpoint.id, version: 1, definition, definitionHash: 'a'.repeat(64), schemaDependencies: [], publishedAt: now },
    tables: [], blocked: false, connection: { id: connectionId, projectId, label: 'Fixture', ...new CredentialEncryption(env.connectionEncryptionKey).encrypt({ schema: 'public' }, `${projectId}:${connectionId}`), lastTestStatus: 'success', lastTestedAt: now, createdAt: now, updatedAt: now } };
  const repository: WorkflowRepository = { create: fail, get: fail, list: fail, edit: fail, toggle: fail, tables: fail, publish: fail, async resolve(_project, path) { return path === 'echo' && endpoint.enabled ? target : undefined; } };
  const logs: unknown[] = [];
  const app = buildApp({ platformAuthRepository: memoryPlatformAuthRepository("11111111-1111-4111-8111-111111111111"), env, projectRepository: memoryRepository(), logger: false, workflowRepository: repository,
    runtimeRepository: { async authenticate() { return { projectId, keyId: 'safe-id', scope: 'read_write' }; }, async resolve() { return undefined; } },
    transactionRunner: async (_config, work) => work({ async connect() {}, async end() {}, on() {}, async query() { return { rows: [] }; } }),
  });
  app.addHook('onRequest', async (req) => { req.log.info = (...args: unknown[]) => { logs.push(args); }; });
  try {
    const headers = { authorization: `Bearer ${key}` }; const url = '/api/shop/echo'; const secret = 'private-workflow-request-value';
    const response = await app.inject({ method: 'POST', url, headers, payload: { text: secret } }); assert.equal(response.statusCode, 200, response.body); assert.equal(response.json(), secret);
    assert.match(String(response.headers['content-type']), /application\/json/);
    const terminal = definition.steps[0]!;
    if (terminal.type !== 'response') throw new Error('Invalid fixture');
    const originalBody = terminal.body!; terminal.body = { kind: 'literal', value: null };
    const nullResponse = await app.inject({ method: 'POST', url, headers, payload: { text: secret } });
    assert.equal(nullResponse.body, 'null'); terminal.body = originalBody;
    assert.equal((await app.inject({ method: 'POST', url, payload: { text: secret } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { text: secret, extra: 1 } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: `${url}?extra=1`, headers, payload: { text: secret } })).statusCode, 400);
    endpoint.enabled = false; assert.equal((await app.inject({ method: 'POST', url, headers, payload: { text: secret } })).statusCode, 404);
    assert.ok(!JSON.stringify(logs).includes(secret)); assert.ok(!JSON.stringify(logs).includes(key)); assert.ok(JSON.stringify(logs).includes('versionId'));
  } finally { await app.close(); }
});
