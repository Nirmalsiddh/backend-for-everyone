import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuidedBuilder } from '../src/components/guided-builder';
import { guidedReducer, initialGuidedState, taskActions, taskFields } from '../src/lib/taskforge';
import { api, ApiError } from '../src/lib/api';
import type { Endpoint, Table } from '../src/lib/contracts';
import { createTaskforge, inspectTaskforge, selectedOperations, taskDraft } from '../src/lib/taskforge-setup';

const table: Table = {
  id: 'task-table', name: 'tasks', draftRevision: 3, appliedRevision: 3,
  fields: taskDraft.fields,
  appliedDefinition: { definition: { name: 'tasks', fields: taskDraft.fields } },
};
const endpoint: Endpoint = {
  id: 'task-endpoint', tableId: table.id, resourceName: 'tasks', revision: 1,
  enabledOperations: ['create', 'list', 'get', 'update', 'delete'],
};
function fixture(options: { missing?: boolean; existing?: Table; endpoint?: Endpoint; fail?: 'preview' | 'apply' | 'api'; unconfirmedApply?: boolean } = {}) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const request = (async (path: string, method = 'GET', body?: unknown) => {
    calls.push({ path, method, body });
    if (path.endsWith('/database-connection')) {
      if (options.missing) throw new ApiError(404, 'CONNECTION_NOT_FOUND', 'Not found');
      return { id: 'connection', lastTestStatus: 'success' };
    }
    if (path.endsWith('/schema')) return options.existing ? [options.existing] : [];
    if (path.endsWith('/endpoints')) return options.endpoint ? [options.endpoint] : [];
    if (method === 'GET') return { id: 'project', slug: 'student-tasks', runtimeState: 'active' };
    if (options.fail && path.endsWith(`/${options.fail}`)) throw new Error('operation failed');
    if (path.endsWith('/tables')) return { ...table, appliedRevision: null, appliedDefinition: null };
    if (path.endsWith('/preview')) return { draftRevision: 3, planHash: 'a'.repeat(64) };
    if (path.endsWith('/apply')) return { status: options.unconfirmedApply ? 'applying' : 'applied', table };
    if (path.endsWith('/api')) return { ...endpoint, enabledOperations: (body as Endpoint).enabledOperations };
    throw new Error('Unexpected call');
  }) as typeof api;
  return { request, calls, mutations: () => calls.filter((call) => call.method !== 'GET') };
}

test('builder renders fixed template, labelled fields/actions and checked defaults', () => {
  const html = renderToStaticMarkup(createElement(GuidedBuilder, { projectId: 'demo' }));
  assert.match(html, /Build your Task Manager/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.equal(initialGuidedState.template, 'task-manager');
  for (const field of taskFields) assert.ok(html.includes(field.label) && html.includes(field.description));
  for (const action of taskActions) {
    assert.ok(html.includes(`for="task-${action.id}"`));
    assert.match(html, new RegExp(`id="task-${action.id}"[^>]*checked=""`));
  }
  assert.match(html, /<fieldset><legend>What should your app be able to do\?/);
  assert.match(html, /href="\/projects\/demo\/database"/);
  assert.match(html, /aria-describedby="continue-help"/);
  assert.match(html, /Checking your saved settings before you continue/);
  assert.match(html, /4\. Ready/);
  assert.match(html, /Built your frontend/);
  const choices = guidedReducer(initialGuidedState, { type: 'toggle', action: 'delete', checked: false });
  assert.equal(guidedReducer(guidedReducer(choices, { type: 'continue' }), { type: 'back' }).actions.delete, false);
});

test('missing database blocks all setup mutations', async () => {
  const f = fixture({ missing: true });
  assert.equal((await inspectTaskforge('project', f.request)).kind, 'missing');
  await assert.rejects(createTaskforge('project', initialGuidedState.actions, () => {}, f.request), /Connect your database/);
  assert.equal(f.mutations().length, 0);
});

test('clean setup uses returned revisions, exact template, selected operations and confirms readiness', async () => {
  const f = fixture();
  const actions = { create: true, view: true, edit: false, delete: false };
  const result = await createTaskforge('project', actions, () => {}, f.request);
  assert.deepEqual(f.mutations().map((c) => [c.method, c.path.split('/').at(-1)]),
    [['POST', 'tables'], ['POST', 'preview'], ['POST', 'apply'], ['PUT', 'api']]);
  assert.deepEqual(f.mutations()[0].body, { name: 'tasks', fields: [
    { name: 'title', type: 'text', nullable: false },
    { name: 'description', type: 'text', nullable: true },
    { name: 'completed', type: 'boolean', nullable: false, default: { kind: 'literal', value: false } },
    { name: 'due_date', type: 'date', nullable: true },
  ] });
  assert.equal(f.mutations()[1].body, undefined);
  assert.deepEqual(f.mutations()[2].body, { expectedDraftRevision: 3, planHash: 'a'.repeat(64) });
  assert.deepEqual(f.mutations()[3].body, {
    enabledOperations: ['create', 'list', 'get'], expectedAppliedRevision: 3, expectedConfigRevision: 0,
    policies: { create: { mode: 'key_only' }, list: { mode: 'key_only' }, get: { mode: 'key_only' } },
  });
  assert.equal(result.table.appliedRevision, 3);
  assert.deepEqual(result.endpoint.enabledOperations, ['create', 'list', 'get']);
  assert.deepEqual(selectedOperations(initialGuidedState.actions), ['create', 'list', 'get', 'update', 'delete']);
});

test('schema failure or unconfirmed apply stops before CRUD without replay', async () => {
  for (const options of [{ fail: 'preview' as const }, { fail: 'apply' as const }, { unconfirmedApply: true }]) {
    const f = fixture(options);
    await assert.rejects(createTaskforge('project', initialGuidedState.actions, () => {}, f.request), /Tasks draft was saved/);
    assert.ok(!f.mutations().some((call) => call.method === 'PUT'));
    assert.ok(f.mutations().filter((call) => call.path.endsWith('/apply')).length <= 1);
  }
});

test('CRUD failure reports that storage succeeded and stops', async () => {
  const f = fixture({ fail: 'api' });
  await assert.rejects(createTaskforge('project', initialGuidedState.actions, () => {}, f.request), /storage was created, but the API actions/);
  assert.equal(f.mutations().length, 4);
});

test('matching saved configuration including a selected subset is recognized without mutations', async () => {
  const saved = { ...endpoint, enabledOperations: ['list', 'get'] as Endpoint['enabledOperations'] };
  const f = fixture({ existing: table, endpoint: saved });
  assert.equal((await inspectTaskforge('project', f.request)).kind, 'ready');
  const result = await createTaskforge('project', initialGuidedState.actions, () => {}, f.request);
  assert.deepEqual(result.endpoint.enabledOperations, ['list', 'get']);
  assert.equal(f.mutations().length, 0);
});

test('incompatible, unfinished or protected Tasks configurations block manual repair', async () => {
  for (const existing of [
    { ...table, fields: table.fields.slice(1) },
    { ...table, appliedRevision: null },
    { ...table, applyStatus: { status: 'outcome_unknown' as const, migrationId: 'm', errorCode: null, completedAt: null } },
    { ...table, draftRevision: 4 },
  ]) {
    const f = fixture({ existing, endpoint });
    assert.equal((await inspectTaskforge('project', f.request)).kind, 'blocked');
    await assert.rejects(createTaskforge('project', initialGuidedState.actions, () => {}, f.request));
    assert.equal(f.mutations().length, 0);
  }
  assert.equal((await inspectTaskforge('project', fixture({ existing: table }).request)).kind, 'blocked');
  assert.equal((await inspectTaskforge('project', fixture({ existing: table, endpoint: { ...endpoint, policies: { create: { mode: 'authenticated' } } } }).request)).kind, 'blocked');
});

test('Taskforge does not persist plaintext credentials or silently create keys during setup', async () => {
  const f = fixture();
  await createTaskforge('project', initialGuidedState.actions, () => {}, f.request);
  assert.ok(!f.calls.some((call) => call.path.includes('api-keys')));
  for (const path of ['../src/components/guided-builder.tsx', '../src/lib/taskforge-setup.ts', '../src/lib/taskforge.ts']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|document\.cookie|indexedDB/);
  }
});
