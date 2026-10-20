import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Indexes } from '../src/features/schema/indexes';
import { validateIndexForms } from '../src/lib/schema-indexes';
import { tableDto } from '../src/lib/server/dto';
const fields = [{ id: 'a', name: 'category', type: 'integer' as const }, { id: 'b', name: 'sku', type: 'uuid' as const }, { id: 'c', name: 'title', type: 'text' as const }];
test('index form preserves meaningful order and rejects duplicate, unsupported and empty choices', () => {
  validateIndexForms([{ fieldIds: ['a', 'b'], unique: false }, { fieldIds: ['b', 'a'], unique: false }], fields);
  for (const indexes of [[{ fieldIds: [], unique: false }], [{ fieldIds: ['a', 'a'], unique: false }], [{ fieldIds: ['c'], unique: false }], [{ fieldIds: ['a', 'b'], unique: true }, { fieldIds: ['b', 'a'], unique: true }]]) assert.throws(() => validateIndexForms(indexes, fields));
});
test('index controls label ordering, lock applied indexes and keep relationship indexes read-only', () => {
  const html = renderToStaticMarkup(createElement(Indexes, { indexes: [{ id: 'locked', fieldIds: ['a'], unique: false }, { fieldIds: ['a', 'b'], unique: true }], fields: [...fields, { id: 'fk', name: 'customer_id', type: 'uuid', relationship: { tableId: 'target', onDelete: 'restrict' } }], applied: [{ id: 'locked', fieldIds: ['a'], unique: false }], busy: false, attention: true, onChange() {} }));
  for (const text of ['Applied', 'Draft', 'Move index 2 field 2 up', 'system managed', 'read-only', 'Needs', 'title']) {
    if (text === 'Needs') assert.match(html, /needs attention/i);
    else if (text === 'title') assert.ok(!html.includes('value="c"'));
    else assert.ok(html.includes(text), text);
  }
  assert.match(html, /fieldset disabled=""/); assert.ok(!html.includes('ix_usr_'));
});
test('table DTO preserves physical revision and managed IDs while stripping physical names and SQL', () => {
  const index = { id: 'index', specificationVersion: 1, fieldIds: ['a'], unique: false, name: 'private_index_name', sql: 'PRIVATE_SQL' };
  const dto = tableDto({ id: 'table', fields, indexes: [index], appliedRevision: 2, appliedPhysicalRevision: 3, appliedDefinition: { definition: { name: 'products', fields, indexes: [index] } } }) as Record<string, unknown>;
  assert.equal(dto.appliedPhysicalRevision, 3); assert.ok(JSON.stringify(dto).includes('fieldIds')); assert.ok(!JSON.stringify(dto).includes('PRIVATE_SQL')); assert.ok(!JSON.stringify(dto).includes('private_index_name'));
});
