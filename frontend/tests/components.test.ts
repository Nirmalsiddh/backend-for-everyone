import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PolicyEditor } from '../src/features/apis/policy';
import { ValueEditor } from '../src/features/workflows/value-editor';
test('owner policy control requires deliberate selection and describes admin bypass', () => {
  const html = renderToStaticMarkup(
    createElement(PolicyEditor, {
      value: { mode: 'owner', ownerFieldId: '', allowAdmin: false },
      onChange: () => {},
      fields: [
        { id: 'owner', name: 'owner_id', type: 'uuid' },
        { id: 'title', name: 'title', type: 'text' },
      ],
    }),
  );
  assert.match(html, /Choose applied UUID field/);
  assert.match(html, /required/);
  assert.match(html, /Allow application admins to access all rows/);
  assert.ok(!html.includes('value="title"'));
});
test('invalid workflow references have a nearby accessible error', () => {
  const html = renderToStaticMarkup(
    createElement(ValueEditor, {
      value: {
        kind: 'reference',
        source: 'step',
        stepId: 'missing',
        path: ['row', 'id'],
      },
      onChange: () => {},
      refs: [],
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /no longer available/);
});
