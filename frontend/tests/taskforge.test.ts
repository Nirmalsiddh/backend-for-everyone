import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuidedBuilder } from '../src/components/guided-builder';
import { guidedReducer, initialGuidedState, taskActions, taskFields } from '../src/lib/taskforge';

test('builder renders the fixed Task Manager, labelled fields and selected actions', () => {
  const html = renderToStaticMarkup(createElement(GuidedBuilder, { projectId: 'demo' }));
  assert.match(html, /Build your Task Manager/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.equal(initialGuidedState.template, 'task-manager');
  for (const field of taskFields) {
    assert.ok(html.includes(field.label));
    assert.ok(html.includes(field.description));
  }
  for (const action of taskActions) {
    assert.ok(html.includes(`for="task-${action.id}"`));
    assert.match(html, new RegExp(`id="task-${action.id}"[^>]*checked=""`));
    assert.ok(html.includes(action.label));
  }
  assert.match(html, /<fieldset><legend>What should your app be able to do\?/);
  assert.match(html, /href="\/projects\/demo\/database"/);
  assert.match(html, /does not check or change your connection/);
  assert.match(html, /<button type="submit">Continue/);
});

test('review, back and preview preserve local choices without any network request', () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (() => { requests++; throw new Error('H1 must not request resources'); }) as typeof fetch;
  try {
    const choices = guidedReducer(initialGuidedState, { type: 'toggle', action: 'delete', checked: false });
    const review = guidedReducer(choices, { type: 'continue' });
    assert.equal(review.view, 'review');
    assert.deepEqual(taskActions.filter((a) => review.actions[a.id]).map((a) => a.label),
      ['Create tasks', 'View tasks', 'Edit tasks']);
    const back = guidedReducer(review, { type: 'back' });
    assert.equal(back.view, 'build');
    assert.equal(back.actions.delete, false);
    const preview = guidedReducer(guidedReducer(back, { type: 'continue' }), { type: 'preview' });
    assert.equal(preview.view, 'preview');
    assert.equal(preview.actions.delete, false);
    assert.equal(guidedReducer(preview, { type: 'review' }).view, 'review');
    assert.equal(initialGuidedState.actions.delete, true);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
