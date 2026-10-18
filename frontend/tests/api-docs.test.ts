import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiDocs } from '../src/components/api-docs';
import {
  operationById,
  playgroundHref,
  downloadDocument,
} from '../src/lib/api-docs';
import { documentFixture } from './api-docs-fixture';
import { operationFor } from '../src/lib/server/operations';
test('Docs renders deployed CRUD, auth, ownership, examples and workflow responses', () => {
  const doc = structuredClone(documentFixture);
  const html = renderToStaticMarkup(
    createElement(ApiDocs, { document: doc, projectId: 'project' }),
  );
  for (const text of [
    'API documentation',
    'Download openapi.json',
    '/tasks',
    'Record owner only',
    'clients cannot set or transfer ownership',
    'Example title',
    '/place-order',
    '201',
    '409',
    'Try in Playground',
    'auth_login',
    'Signed-in application user',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes('literal-secret-sentinel'));
  const match = operationById(doc, 'crud_tasks_create')!;
  assert.equal(
    playgroundHref('project', match.operation),
    '/projects/project/playground?operationId=crud_tasks_create',
  );
  assert.equal(operationById(doc, 'disabled-operation'), undefined);
  assert.equal(
    operationFor('projects/11111111-1111-4111-8111-111111111111/openapi', 'GET')
      ?.mode,
    'management',
  );
  assert.equal(
    operationFor(
      'projects/11111111-1111-4111-8111-111111111111/openapi',
      'POST',
    ),
    undefined,
  );
});
test('download exports owner-loaded JSON with safe filename', async () => {
  const doc = structuredClone(documentFixture);
  let blob: Blob | undefined,
    clicked = false;
  const link = {
    href: '',
    download: '',
    click() {
      clicked = true;
    },
    remove() {},
  };
  const oldDocument = globalThis.document,
    oldCreate = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => link, body: { append() {} } },
  });
  URL.createObjectURL = (value) => {
    blob = value as Blob;
    return 'blob:fixture';
  };
  URL.revokeObjectURL = () => {};
  try {
    downloadDocument(doc);
    assert.equal(clicked, true);
    assert.equal(link.download, 'docs-project-openapi.json');
    assert.deepEqual(JSON.parse(await blob!.text()), doc);
  } finally {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: oldDocument,
    });
    URL.createObjectURL = oldCreate;
    setTimeout(() => {
      URL.revokeObjectURL = oldRevoke;
    }, 1);
  }
});
