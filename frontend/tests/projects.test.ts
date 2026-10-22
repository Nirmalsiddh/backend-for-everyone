import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Projects from '../src/app/projects/page';
import { ProjectSlugField, isProjectSlugConflict } from '../src/components/project-slug-field';
import { ApiError } from '../src/lib/api';
import { ErrorBox } from '../src/components/ui';

const registration = { name: 'slug' as const, ref: () => {}, onChange: async () => {}, onBlur: async () => {} };
function field(error: unknown = null) {
  return renderToStaticMarkup(createElement(ProjectSlugField, { registration, error }));
}
test('slug field explains global uniqueness with associated help and existing constraints', () => {
  const html = field();
  assert.match(html, /Project names can repeat. The API slug must be unique across the platform./);
  assert.match(html, /aria-describedby="project-slug-help"/);
  assert.match(html, /name="slug"/);
  assert.match(html, /required/);
  assert.match(html, /minLength="3"/);
  assert.match(html, /maxLength="63"/);
});
test('project creation form and both fields opt out of browser autocomplete', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {}, bfcacheId: 'test' };
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    createElement(QueryClientProvider, { client }, createElement(Projects))));
  assert.match(html, /<form[^>]*autoComplete="off"/);
  for (const name of ['name', 'slug']) {
    const input = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
    assert.ok(input, `${name} input rendered`);
    assert.match(input, /autoComplete="off"/);
  }
  client.clear();
});
test('only the known slug conflict gets friendly accessible field feedback', () => {
  const error = new ApiError(409, 'SLUG_UNAVAILABLE', 'Project slug is unavailable');
  assert.equal(isProjectSlugConflict(error), true);
  const html = field(error);
  assert.match(html, /role="alert"/);
  assert.match(html, /That API slug is already taken. Choose another slug./);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="project-slug-help project-slug-error"/);
});
test('other backend and unexpected errors retain the normal error path', () => {
  for (const error of [new ApiError(403, 'OWNER_UNAVAILABLE', 'Platform user is unavailable'), new ApiError(409, 'OTHER_CONFLICT', 'Different conflict'), new Error('Network problem')]) {
    assert.equal(isProjectSlugConflict(error), false);
    assert.doesNotMatch(field(error), /role="alert"|aria-invalid/);
    const html = renderToStaticMarkup(createElement(ErrorBox, { error }));
    assert.match(html, /role="alert"/);
    assert.ok(html.includes(error.message));
  }
  assert.equal(isProjectSlugConflict({ code: 'SLUG_UNAVAILABLE' }), false);
});
