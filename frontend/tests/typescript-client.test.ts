import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TypeScriptClient } from '../src/components/typescript-client';
import { operationFor } from '../src/lib/server/operations';
test('SDK preview starts with an explicit accessible generation action and credential guidance',()=>{
  const html=renderToStaticMarkup(createElement(TypeScriptClient,{projectId:'project'}));
  assert.match(html,/Generate TypeScript client/);
  assert.match(html,/Project keys are shared credentials/);
  assert.match(html,/Bigint and decimal/);
  assert.ok(!html.includes('Download .ts'));
  assert.ok(!html.includes('<script'));
});
test('SDK management adapter has explicit GET-only public envelope projection',()=>{
  const path='projects/11111111-1111-4111-8111-111111111111/sdk/typescript';
  const operation=operationFor(path,'GET');
  assert.ok(operation);
  assert.equal(operationFor(path,'POST'),undefined);
  assert.equal(operationFor(path,'GET',true),undefined);
  assert.deepEqual(operation.project({filename:'p-client.ts',source:'safe',secret:'hidden'},'GET'),{filename:'p-client.ts',source:'safe'});
});
