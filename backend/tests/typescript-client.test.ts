import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildContract } from '../src/modules/typescript-client/contract.js';
import { render } from '../src/modules/typescript-client/render.js';
import { snapshot, field } from './api-docs-fixtures.js';
import { serializeRuntimeQuery } from '../../shared/runtime-query.js';
function fixture() {
  const value = snapshot();
  value.tables[0] = { ...value.tables[0]!, name: 'tasks', fields: value.resources[0]!.fields };
  return value;
}
test('SDK deterministic, applied-only, independent of stale workflows and sensitive internal metadata', () => {
  const input = fixture();
  input.workflows[0]!.definition = null;
  const source = render(buildContract(input));
  input.workflows = [];
  input.resources[0]!.operations.reverse();
  input.resources[0]!.fields!.reverse();
  input.tables.push({id:'draft',applied:false,appliedRevision:null});
  assert.equal(render(buildContract(input)),source);
  for (const secret of ['literal-secret-sentinel','internal-field-','internal-table','ownerFieldId','physicalRevision']) assert.ok(!source.includes(secret));
  const hash = buildContract(input).hash;
  input.resources[0]!.operations = ['list'];
  assert.notEqual(buildContract(input).hash,hash);
  input.auth!.signupEnabled = false;
  assert.ok(!render(buildContract(input)).includes('signup: ('));
  input.auth!.enabled = false;
  assert.throws(()=>buildContract(input),{code:'SDK_UNAVAILABLE'});
});
test('standalone strict compile, negative types, canonical serialization, transport and protocol errors', async () => {
  const input = fixture();
  for (const type of ['uuid','integer','bigint','decimal','date','timestamp','boolean','text','varchar','jsonb'] as const)
    input.resources[0]!.fields!.push(field(`value_${type}`,type,{nullable:true, options:type==='decimal'?{precision:30,scale:6}:type==='varchar'?{length:100}:{}}));
  input.resources[0]!.fields!.push(field('json_required','jsonb',{default:{kind:'literal',value:null}}));
  const dir = await mkdtemp(join(tmpdir(),'sdk-compile-'));
  try {
    await writeFile(join(dir,'client.ts'),render(buildContract(input))+'\nexport { queryString };');
    await writeFile(join(dir,'fixture.ts'),`import {createClient,type Row_tasks,type Create_tasks} from './client.js';
const client=createClient({baseUrl:'https://example.test/api/project'});
client.resources.tasks.list({filter:{value_bigint:{gte:'9007199254740993'},value_integer:{in:[1,2]}}});
// @ts-expect-error exact string
client.resources.tasks.list({filter:{value_bigint:{eq:2}}});
// @ts-expect-error exact decimal string
client.resources.tasks.list({filter:{value_decimal:{eq:2}}});
// @ts-expect-error unknown operator
client.resources.tasks.list({filter:{title:{contains:'x'}}});
// @ts-expect-error id cannot be NULL checked
client.resources.tasks.list({filter:{id:{is_null:true}}});
// @ts-expect-error JSONB not filterable
client.resources.tasks.list({filter:{value_jsonb:{eq:'null'}}});
// @ts-expect-error boolean IN unsupported
client.resources.tasks.list({filter:{done:{in:[true]}}});
// @ts-expect-error protected owner
client.resources.tasks.update('id',{owner_id:'id'});
// @ts-expect-error empty PATCH
client.resources.tasks.update('id',{});
// @ts-expect-error undefined PATCH
client.resources.tasks.update('id',undefined);
// @ts-expect-error related sort unsupported
client.resources.tasks.list({sort:'customer.name'});
// @ts-expect-error include unsupported
client.resources.tasks.list({include:['other']});
const json:Row_tasks['json_required']=null; void json;
// @ts-expect-error nonnullable JSONB rejects top-level null write
const body:Create_tasks={title:'x',json_required:null}; void body;
`);
    execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--strict','--exactOptionalPropertyTypes','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--lib','ES2022,DOM','--skipLibCheck','--outDir',join(dir,'out'),join(dir,'client.ts'),join(dir,'fixture.ts')],{encoding:'utf8'});
    const client = await import(pathToFileURL(join(dir,'out/client.js')).href);
    assert.equal(client.queryString({filter:{title:{in:['ACME, Inc.','A&B','+空','']},value_timestamp:{gte:'2026-01-01T00:00:00.123456+05:30'}},sort:'id',limit:25}),serializeRuntimeQuery({filters:[{field:'title',operator:'in',values:['ACME, Inc.','A&B','+空','']},{field:'value_timestamp',operator:'gte',value:'2026-01-01T00:00:00.123456+05:30'}],sort:'id',limit:25}));
    assert.equal(client.queryString({filter:{title:{eq:'A&B+',neq:'null'},value_integer:{gt:1,lte:5},value_boolean:{is_null:false}},sort:'id',direction:'desc',offset:10,include:['supplier_id','customer_id']}),serializeRuntimeQuery({filters:[{field:'title',operator:'eq',value:'A&B+'},{field:'title',operator:'neq',value:'null'},{field:'value_integer',operator:'gt',value:'1'},{field:'value_integer',operator:'lte',value:'5'},{field:'value_boolean',operator:'is_null',value:'false'}],sort:'id',direction:'desc',offset:10,includes:['supplier_id','customer_id']}));
    assert.equal(client.queryString({filter:{value_integer:{in:[1,25]}}}),serializeRuntimeQuery({filters:[{field:'value_integer',operator:'in',values:['1','25']}]}));
    assert.throws(()=>client.queryString({filter:{title:{in:Array(26).fill('x')}}}),TypeError);
    assert.throws(()=>client.queryString({filter:{title:{eq:'x',neq:'y'},value_integer:{eq:1,neq:2,gt:0,lt:3}}}),TypeError);
    const original=globalThis.fetch;
    const config={baseUrl:'https://example.test/prefix/api/project/',getSessionToken:()=>`us_${'x'.repeat(43)}`};
    try {
      globalThis.fetch=async (_url,init)=>{assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');return new Response('<html>secret</html>',{status:503,headers:{'x-request-id':'request'}});};
      await assert.rejects(client.createClient(config).resources.tasks.list(),(e:Error & {requestId?:string})=>e instanceof client.ApiError && e.requestId==='request' && !e.message.includes('secret'));
      globalThis.fetch=async()=>new Response('',{status:200});
      await assert.rejects(client.createClient(config).resources.tasks.list(),client.ProtocolError);
      globalThis.fetch=async()=>{throw new Error('secret');};
      await assert.rejects(client.createClient(config).resources.tasks.list(),client.TransportError);
      globalThis.fetch=async()=>new Response(null,{status:204});
      assert.equal(await client.createClient(config).resources.tasks.delete('00000000-0000-4000-8000-000000000001'),undefined);
      await assert.rejects(client.createClient({...config,getSessionToken:()=>`pk_${'x'.repeat(43)}`}).resources.tasks.list(),TypeError);
    } finally {globalThis.fetch=original;}
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('strict empty create and omitted unusable PATCH with awkward resource name',()=>{
  const input=fixture();
  input.resources[0]!.name='constructor';input.resources[0]!.fields=[];input.resources[0]!.policies={};
  input.tables[0]!.name='constructor';input.tables[0]!.fields=[];
  const source=render(buildContract(input));
  assert.ok(source.includes('Create_constructor = Record<string, never>'));
  assert.ok(!source.includes('update: ('));
  assert.ok(source.includes('NO_WRITABLE_FIELDS'));
});

test('SDK owner management route: authentication, foreign project, query rejection and no-store', async (t) => {
  const { buildApp } = await import('../src/app.js');
  const { memoryPlatformAuthRepository } = await import('./platform-auth-helpers.js');
  const { env, auth, ownerId, memoryRepository } = await import('./helpers.js');
  const app = buildApp({env,projectRepository:memoryRepository(),platformAuthRepository:memoryPlatformAuthRepository(ownerId),logger:false,
    docsRepository:{async snapshot(id,owner,scope){assert.deepEqual(scope,{workflows:false});return id===ownerId && owner===ownerId?fixture():undefined;}}});
  t.after(()=>app.close());
  const url=`/internal/projects/${ownerId}/sdk/typescript`;
  assert.equal((await app.inject(url)).statusCode,401);
  const response=await app.inject({url,headers:auth});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(response.json().filename,'docs-project-client.ts');
  assert.equal((await app.inject({url:url+'?path=secret',headers:auth})).statusCode,400);
  assert.equal((await app.inject({url:'/internal/projects/22222222-2222-4222-8222-222222222222/sdk/typescript',headers:auth})).statusCode,404);
});

test('approved query matrix for nullable and required fields; names and relationship metadata fail closed',()=>{
  const matrix:Record<string,string[]>={uuid:['eq','neq','in'],integer:['eq','neq','gt','gte','lt','lte','in'],bigint:['eq','neq','gt','gte','lt','lte','in'],decimal:['eq','neq','gt','gte','lt','lte','in'],date:['eq','neq','gt','gte','lt','lte'],timestamp:['eq','neq','gt','gte','lt','lte'],boolean:['eq','neq'],text:['eq','neq','in'],varchar:['eq','neq','in'],jsonb:[]};
  const input=fixture();input.resources[0]!.policies={};
  const fields=input.resources[0]!.fields!;fields.length=0;
  for(const [type,operators] of Object.entries(matrix))for(const nullable of [false,true]) {
    const f=field(`${type}_${nullable?'nullable':'required'}`,type as Parameters<typeof field>[1],{nullable,options:type==='decimal'?{precision:24,scale:2}:type==='varchar'?{length:100}:{}});fields.push(f);
    const contract=buildContract(input);
    const query=contract.resources[0]!.operations.find((op)=>op.name==='list')!.query!;
    assert.deepEqual(query.fields.find((candidate)=>candidate.name===f.name)?.operators??[],[...operators,...(nullable && type!=='jsonb'?['is_null']:[])]);
    assert.deepEqual(query.fields.find((candidate)=>candidate.name==='id')!.operators,['eq','neq','in']);
  }
  input.resources[0]!.fields![0]!.name='bad";inject';
  assert.throws(()=>buildContract(input),{code:'SDK_UNAVAILABLE'});
});

test('HTTP error statuses preserve safe envelopes/request IDs with no retries or credential/body leakage',async()=>{
  const {compileSdk}=await import('./sdk-compile-helper.js');
  const compiled=await compileSdk(render(buildContract(fixture())));
  const original=globalThis.fetch;
  try {
    let requests=0;
    const client=compiled.module.createClient({baseUrl:'https://example.test/prefix/api/project',getSessionToken:()=>`us_${'x'.repeat(43)}`});
    for(const status of [400,401,403,404,409,429,503,504]) {
      globalThis.fetch=async(url)=>{requests++;assert.ok(String(url).startsWith('https://example.test/prefix/api/project/'));return Response.json({code:'SAFE_ERROR',message:'Safe message',requestId:'body-id'},{status,headers:{'x-request-id':'header-id'}});};
      await assert.rejects(client.resources.tasks.list(),(error:Error & {status?:number;code?:string;requestId?:string})=>error instanceof compiled.module.ApiError && error.status===status && error.code==='SAFE_ERROR' && error.requestId==='body-id');
    }
    assert.equal(requests,8);
  } finally {globalThis.fetch=original;await compiled.cleanup();}
});

test('strict compilation of awkward names, empty creates, unusable PATCH and one-level relationship typing',async()=>{
  const {compileSdk}=await import('./sdk-compile-helper.js');
  const input=fixture();
  const customerFields=[field('class','text'),field('constructor','text'),field('a1b','text'),field('a_1b','text')];
  input.tables.push({id:'00000000-0000-4000-8000-000000000099',name:'constructor',fields:customerFields,applied:true,appliedRevision:1});
  input.resources.push({name:'constructor',fields:customerFields,operations:['get'],policies:{get:{mode:'authenticated'}}});
  input.resources[0]!.fields!.push(field('customer_id','uuid',{nullable:true,relationship:{tableId:'00000000-0000-4000-8000-000000000099',onDelete:'restrict'}}));
  input.resources[0]!.includes=[{name:'customer_id',referenceName:'constructor',fields:customerFields,policy:{mode:'authenticated'}}];
  input.tables.push({id:'empty',name:'empty_items',fields:[],applied:true,appliedRevision:1});
  input.resources.push({name:'empty_items',fields:[],operations:['create','update'],policies:{}});
  const compiled=await compileSdk(render(buildContract(input))+`
if (false) {
const fixtureClient=createClient({baseUrl:'https://example.test/api/project'});
fixtureClient.resources.tasks.list({include:['customer_id']});
fixtureClient.resources.empty_items.create({});
// @ts-expect-error unusable PATCH omitted
fixtureClient.resources.empty_items.update('id',{});
// @ts-expect-error recursive include unsupported
fixtureClient.resources.tasks.list({include:['customer_id.class']});
// @ts-expect-error target rows are not recursive read types
const recursive:Row_constructor['_related']={};
void recursive;
// @ts-expect-error disabled create omitted
fixtureClient.resources.constructor.create({});
}
`);
  await compiled.cleanup();
});

test('compact shared CRUD projection preserves SDK input/query/policy/status semantics',async()=>{
  const {crud}=await import('../src/modules/api-docs/crud.js');
  const {operationContract}=await import('../src/modules/typescript-client/contract.js');
  const resource=fixture().resources[0]!;
  resource.includes=[{name:'customer_id',referenceName:'customers',fields:[field('name','text')],policy:{mode:'authenticated'}}];
  assert.deepEqual(crud(resource,{compact:true}).map((item)=>operationContract(item.operation)),crud(resource).map((item)=>operationContract(item.operation)));
});
