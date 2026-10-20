import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryFilters, publicFilters, type FilterRow } from '../src/components/query-filters';
import { queryCapabilities, serializeRuntimeQuery, type PublicFilter } from '../../shared/runtime-query.js';
import { operationExamples } from '../src/lib/operation-examples';
import type { OpenApiDocument } from '../src/lib/api-docs';
const capabilities = queryCapabilities([
  { name: 'price', type: 'decimal', nullable: false, options: { precision: 20, scale: 2 } },
  { name: 'label', type: 'text', nullable: true, options: {} },
  { name: 'payload', type: 'jsonb', nullable: true, options: {} },
]);
test('deployed capabilities exclude JSONB and expose only public metadata', () => {
  assert.deepEqual(capabilities.fields.map((field) => field.name), ['id','price','label']);
  assert.deepEqual(capabilities.fields[0]!.operators, ['eq','neq','in']);
  assert.ok(!capabilities.fields[1]!.operators.includes('is_null'));
  assert.ok(!capabilities.fields[2]!.operators.includes('gte'));
  assert.ok(!JSON.stringify(capabilities).includes('fieldId'));
});
test('one deterministic serializer round trips punctuation Unicode plus timezone and exact numbers', () => {
  const filters: PublicFilter[] = [
    { field: 'label', operator: 'in', values: ['ACME, Inc.','A&B','雪','"quoted"','', '+', 'null'] },
    { field: 'instant', operator: 'gte', value: '2026-01-01T00:00:00.123456+05:30' },
    { field: 'price', operator: 'lte', value: '123456789012345678.90' },
    { field: 'counter', operator: 'legacy_eq', value: '9007199254740993' },
  ];
  const encoded = serializeRuntimeQuery({ filters, includes: ['shipping_id','billing_id'], sort: 'price', direction: 'desc', limit: '25' });
  const decoded = new URLSearchParams(encoded);
  assert.deepEqual(JSON.parse(decoded.get('filter[label][in]')!), filters[0]!.operator === 'in' && filters[0]!.values);
  assert.equal(decoded.get('filter[instant][gte]'), '2026-01-01T00:00:00.123456+05:30');
  assert.equal(decoded.get('filter[counter]'), '9007199254740993');
  assert.equal(decoded.get('include'), 'billing_id,shipping_id');
  assert.match(encoded, /%5B/); assert.match(encoded, /%2B/);
  assert.equal(encoded, serializeRuntimeQuery({ filters: filters.reverse(), includes: ['billing_id','shipping_id'], sort: 'price', direction: 'desc', limit: '25' }));
});
test('bounded filter rows reject duplicates, unavailable draft fields and invalid operator choices', () => {
  const row: FilterRow = { field: 'price', operator: 'gte', value: '9007199254740993', values: [''] };
  assert.deepEqual(publicFilters([row],capabilities), [{ field: 'price', operator: 'gte', value: '9007199254740993' }]);
  assert.throws(() => publicFilters([row,row],capabilities));
  assert.throws(() => publicFilters(Array(6).fill(row),capabilities));
  assert.throws(() => publicFilters([{ ...row, field: 'draft_field' }],capabilities));
  assert.throws(() => publicFilters([{ ...row, field: 'label' }],capabilities));
  assert.throws(() => publicFilters([{ ...row, operator: 'in', values: Array(26).fill('1') }],capabilities));
  assert.throws(() => publicFilters([{ ...row, operator: 'in', values: [] }],capabilities));
});
test('filter controls have explicit labels, bounded IN editor and NULL selector without scalar input', () => {
  const rows: FilterRow[] = [
    { field: 'label', operator: 'in', value: '', values: Array(25).fill('') },
    { field: 'label', operator: 'is_null', value: 'true', values: [''] },
  ];
  const markup = renderToStaticMarkup(createElement(QueryFilters,{ rows,capabilities,disabled:true,onChange:()=>{} }));
  assert.match(markup,/Filters \(AND, maximum five clauses\)/);
  assert.match(markup,/Filter 1 value 25/);
  assert.match(markup,/disabled="">Add IN value/);
  assert.match(markup,/NULL selection 2/);
  assert.match(markup,/Non-NULL/);
  assert.ok(!markup.includes('Value 2<input'));
  assert.match(markup,/fieldset disabled/);
});
test('synthetic curl and fetch query variants share encoded grammar and credential placeholders', () => {
  const doc: OpenApiDocument = { openapi:'3.1.0',info:{title:'Fixture',version:'1',description:''},servers:[{url:'https://example.test/api/demo'}],components:{schemas:{},securitySchemes:{}},paths:{'/products':{get:{operationId:'list',summary:'List',tags:['Resources'],description:'',security:[{ProjectApiKey:[]}],'x-access-policy':'key_only','x-runtime-query':capabilities,responses:{}}}} };
  for (const [kind,key] of [['legacy','filter[label]'],['range','filter[price][gte]'],['in','filter[id][in]'],['null','filter[label][is_null]']] as const) {
    const examples = operationExamples(doc,'list',[],kind)!;
    assert.ok(examples.curl.includes(encodeURIComponent(key))); assert.ok(examples.javascript.includes(encodeURIComponent(key)));
    assert.ok(examples.curl.includes('<PROJECT_API_KEY>'));
  }
});

test('synthetic query scalars fit restrictive decimal and varchar definitions', () => {
  const caps = queryCapabilities([{ name: 'fraction', type: 'decimal', nullable: true, options: { precision: 2, scale: 2 } }, { name: 'letter', type: 'varchar', nullable: false, options: { length: 1 } }]);
  const doc: OpenApiDocument = { openapi:'3.1.0', info:{title:'Fixture',version:'1',description:''}, servers:[{url:'https://example.test/api/demo'}], components:{schemas:{},securitySchemes:{}}, paths:{'/items':{get:{operationId:'list',summary:'List',tags:['Resources'],description:'',security:[],'x-access-policy':'key_only','x-runtime-query':caps,responses:{}}}} };
  assert.ok(operationExamples(doc,'list',[],'range')!.curl.includes('=0'));
  assert.ok(operationExamples(doc,'list',[],'legacy')!.curl.includes('=x'));
});
