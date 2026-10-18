import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import type { Definition } from '../src/modules/schema-builder/types.js';
import { validateBody, validateId, validateList } from '../src/runtime/validation.js';
import { deleteRow, insertRow, selectById, selectList, serializeRow, updateRow } from '../src/runtime/queries.js';
import { ApiKeyService, hashKey } from '../src/modules/api-keys/service.js';
import type { ApiKeyMetadata, ApiKeyRecord, ApiKeyRepository } from '../src/modules/api-keys/types.js';
const definition: Definition = { schema: 'public', ...normalizeDraft({ name: 'products', fields: [
  { name: 'sku', type: 'text', nullable: false, unique: true },
  { name: 'price', type: 'decimal', options: { precision: 20, scale: 2 }, default: { kind: 'literal', value: '0' } },
  { name: 'counter', type: 'bigint' }, { name: 'active', type: 'boolean' }, { name: 'payload', type: 'jsonb' },
  { name: 'birthday', type: 'date' }, { name: 'created_at', type: 'timestamp' },
] }) };
test('runtime bodies enforce applied fields, defaults, nullability and exact scalar types', () => {
  const body = { sku: 'ABC', price: '123456789012345678.90', counter: '9223372036854775807', payload: [true, null, { label: 'x' }], birthday: '2024-02-29', created_at: '2026-01-01T00:00:00.123Z' };
  assert.deepEqual(validateBody(definition, body, true), body);
  assert.deepEqual(validateBody(definition, { sku: 'ABC' }, true), { sku: 'ABC' });
  assert.deepEqual(validateBody(definition, { payload: null }, false), { payload: null });
  assert.deepEqual(validateBody({ ...definition, fields: [] }, {}, true), {});
  for (const invalid of [null, [], 'text', {}, { id: randomUUID() }, { sku: null }, { unknown: 'x' }, { price: 1.23 }, { counter: 5 }, { active: 'true' }, { birthday: '2025-02-29' }, { created_at: '2026-01-01T00:00:00' }]) {
    assert.throws(() => validateBody(definition, invalid, false), { statusCode: 400 });
  }
  assert.throws(() => validateBody(definition, {}, true), { statusCode: 400 });
  assert.throws(() => validateId('x OR true'), { statusCode: 400 });
});
test('safe list parameters allow bounded pagination, scalar sorting, and at most five equality filters', () => {
  const parsed = validateList(definition, { limit: '2', offset: '3', sort: 'price', direction: 'desc', 'filter[sku]': "x' OR 1=1 --", 'filter[active]': 'false' });
  assert.equal(parsed.limit, 2); assert.equal(parsed.direction, 'DESC');
  assert.deepEqual(parsed.filters[1], { field: 'active', value: false });
  for (const query of [ { limit: '101' }, { limit: '0' }, { offset: '10001' }, { limit: ['2', '3'] }, { sort: 'payload' }, { sort: 'sku; DROP TABLE products' },
    { direction: 'asc; DROP TABLE products' }, { 'filter[payload]': '{}' }, { 'filter[unknown]': 'x' }, { 'filter[active]': 'null' },
    { 'filter[sku][eq]': 'x' }, { search: 'x' }, { 'filter[sku]': ['a', 'b'] },
    { 'filter[sku]': 'x', 'filter[price]': '0', 'filter[counter]': '1', 'filter[active]': 'true', 'filter[birthday]': '2026-01-01', 'filter[id]': randomUUID() },
  ]) assert.throws(() => validateList(definition, query), { statusCode: 400 });
});
test('all query builders quote metadata identifiers, bind values, and explicitly project allowed fields', () => {
  const id = randomUUID(); const hostile = "x'); DROP TABLE products; --";
  const list = selectList(definition, validateList(definition, { sort: 'price', 'filter[sku]': hostile }));
  assert.ok(!list.text.includes(hostile)); assert.equal(list.values[0], hostile);
  assert.match(list.text, /ORDER BY "runtime_row"\."price" ASC NULLS LAST, "runtime_row"\."id" ASC/);
  assert.deepEqual(list.values.slice(-2), [26, 0]);
  const insert = insertRow(definition, { sku: hostile, payload: ['a', 'b'] });
  assert.ok(!insert.text.includes(hostile)); assert.equal(insert.values[1], '["a","b"]');
  assert.match(insert.text, /::pg_catalog.jsonb/);
  assert.match(insertRow({ ...definition, fields: [] }, {}).text, /DEFAULT VALUES RETURNING "id"/);
  const update = updateRow(definition, id, { sku: hostile });
  assert.deepEqual(update.values, [hostile, id]);
  const remove = deleteRow(definition, id); assert.match(remove.text, /RETURNING "id"$/);
  for (const query of [list, insert, update, remove, selectById(definition, id)]) {
    assert.ok(!/SELECT \*|RETURNING \*/.test(query.text)); assert.match(query.text, /"public"\."products"/);
  }
  assert.throws(() => insertRow(definition, { id }), { statusCode: 400 });
  assert.throws(() => updateRow(definition, id, { injected: 'x' }), { statusCode: 400 });
  const row = serializeRow(definition, { id, sku: 'x', created_at: new Date('2026-01-01T00:00:00Z'), outside_secret: 'hidden' });
  assert.equal(row.created_at, '2026-01-01T00:00:00.000Z'); assert.ok(!Object.hasOwn(row, 'outside_secret'));
});
test('API keys contain random secrets, persist only hashes, and return safe metadata on listing', async () => {
  const records: ApiKeyRecord[] = [];
  const metadata = ({ keyHash: _hash, ...key }: ApiKeyRecord): ApiKeyMetadata => key;
  const repository: ApiKeyRepository = {
    async create(_project, _owner, key) { records.push(key); return metadata(key); },
    async list() { return records.map(metadata); }, async revoke() {},
  };
  const service = new ApiKeyService(repository);
  const first = await service.create('project', 'owner', 'Browser', 'read');
  const second = await service.create('project', 'owner', 'Server', 'read_write');
  assert.match(first.key, /^pk_[A-Za-z0-9_-]{43}$/); assert.notEqual(first.key, second.key);
  assert.equal(records[0]?.keyHash, hashKey(first.key));
  assert.ok(!JSON.stringify(records).includes(first.key)); assert.ok(!Object.hasOwn(first, 'keyHash'));
  const listed = JSON.stringify(await service.list('project', 'owner'));
  assert.ok(!listed.includes(first.key)); assert.ok(!listed.includes('keyHash'));
});
