import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutationRecovery, supportDetails } from '../src/lib/mutation-recovery';
import { boundedBody } from '../src/lib/server/body-limit';
import { deriveProjectSetupStatus } from '../src/lib/project-setup';
import { operationExamples } from '../src/lib/operation-examples';
import { documentFixture } from './api-docs-fixture';
test('uncertain writes use operation-specific recovery without automatic retry', () => {
  assert.match(
    mutationRecovery('WRITE_OUTCOME_UNKNOWN', 'workflow:w POST', 503),
    /duplicate effects/,
  );
  assert.match(
    mutationRecovery('RESPONSE_UNCONFIRMED', 'projects/p/api-keys POST'),
    /revoke it and create another/,
  );
  assert.match(mutationRecovery('AUTH_OUTCOME_UNKNOWN'), /operator/);
  assert.match(
    mutationRecovery('INTERNAL_ERROR', 'projects/p/api-keys POST', 500),
    /secret was not received/,
  );
  assert.match(
    mutationRecovery('RESPONSE_UNCONFIRMED', 'auth:signup POST'),
    /same account/,
  );
});
test('support details are an explicit safe allowlist, never error payloads or credentials', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const details = supportDetails({
    projectId: id,
    requestId: id,
    timestamp: '2026-10-20T00:00:00.000Z',
    operation: `projects/${id}/api-keys POST`,
    code: 'WRITE_OUTCOME_UNKNOWN',
    status: 503,
  });
  assert.match(details, /WRITE_OUTCOME_UNKNOWN/);
  const poisoned = supportDetails({
    projectId: 'pk_SECRET',
    requestId: 'Bearer us_SECRET',
    operation: 'password SECRET',
    code: 'Cookie SECRET',
    timestamp: 'DB_URL_SECRET',
  });
  assert.doesNotMatch(poisoned, /SECRET|password|Cookie|Bearer/);
});
test('stream body cap rejects before reading further chunks', async () => {
  let pulled = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(4000));
    },
  });
  await assert.rejects(
    boundedBody(
      new Request('https://app.test', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit),
      4096,
    ),
    RangeError,
  );
  assert.ok(pulled <= 4);
});
test('PATCH without writable fields has no misleading generated body', () => {
  const doc = structuredClone(documentFixture);
  const op = doc.paths['/tasks'].post;
  op.operationId = 'empty_patch';
  op.requestBody!.content['application/json'].schema.properties = {};
  doc.paths = { '/tasks/{id}': { patch: op } };
  assert.equal(operationExamples(doc, 'empty_patch'), null);
});
test('current blockers outrank visit success and owner-only PATCH is not ready', () => {
  const status = deriveProjectSetupStatus({
    projectId: 'p',
    connection: {
      data: {
        id: 'c',
        label: 'db',
        lastTestStatus: 'success',
        lastTestedAt: null,
      },
    },
    tables: {
      data: [
        {
          id: 't',
          name: 'tasks',
          draftRevision: 1,
          appliedRevision: 1,
          fields: [],
          appliedDefinition: {
            definition: {
              name: 'tasks',
              fields: [{ id: 'o', name: 'owner_id', type: 'uuid' }],
            },
          },
        },
      ],
    },
    endpoints: {
      data: [
        {
          id: 'e',
          tableId: 't',
          resourceName: 'tasks',
          enabledOperations: ['update'],
          policies: {
            update: { mode: 'owner', ownerFieldId: 'o', allowAdmin: false },
          },
          revision: 1,
        },
      ],
    },
    auth: { data: null },
    keys: { data: [] },
    workflows: { data: [] },
    successes: [
      { projectId: 'p', operationId: 'crud_tasks_update', success: true },
    ],
  });
  assert.equal(status.readyOperations[0].ready, false);
  assert.equal(status.readyOperations[0].noWritableFields, true);
  assert.equal(status.currentReady, false);
});
