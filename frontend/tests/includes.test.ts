import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { documentFixture } from './api-docs-fixture';
import { includeOptions, includeQuery } from '../src/lib/api-docs';
import { operationExamples } from '../src/lib/operation-examples';
import { OperationExamples } from '../src/components/operation-examples';
test('OpenAPI choices generate encoded include URL and safe curl/fetch examples', () => {
  const document = structuredClone(documentFixture);
  const operation = { ...document.paths['/tasks']!.post!, operationId: 'crud_tasks_list' };
  delete operation.requestBody;
  document.paths['/tasks']!.get = operation;
  operation.parameters = [{ name: 'include', in: 'query', style: 'form', explode: false, schema: { type: 'array', maxItems: 2, items: { type: 'string', enum: ['customer_id', 'warehouse_id'] } } }];
  assert.deepEqual(includeOptions(operation), ['customer_id', 'warehouse_id']);
  assert.deepEqual(includeOptions(document.paths['/tasks']!.post), []);
  assert.equal(includeQuery([]), '');
  assert.equal(includeQuery(['customer_id', 'warehouse_id']), 'include=customer_id%2Cwarehouse_id');
  const ordinary = operationExamples(document, operation.operationId)!;
  assert.ok(!ordinary.curl.includes('?include'));
  const examples = operationExamples(document, operation.operationId, ['customer_id', 'warehouse_id'])!;
  for (const snippet of [examples.curl, examples.javascript]) {
    assert.ok(snippet.includes('?include=customer_id%2Cwarehouse_id'));
    assert.ok(!snippet.includes('literal-secret-sentinel'));
  }
  const html = renderToStaticMarkup(createElement(OperationExamples, { document, operationId: operation.operationId }));
  assert.match(html, /Include \(maximum two\)/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /customer_id/);
});
