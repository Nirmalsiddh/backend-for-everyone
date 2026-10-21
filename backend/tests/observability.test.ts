import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { EventWriter } from '../src/modules/observability/writer.js';
import { buildEvent, type EventContext, type RequestEvent } from '../src/modules/observability/events.js';
import { parseFilters, nextCursor } from '../src/modules/observability/queries.js';
import { buildApp } from '../src/app.js';
import { env, memoryRepository } from './helpers.js';
import { memoryPlatformAuthRepository } from './platform-auth-helpers.js';
import { RuntimeError } from '../src/runtime/errors.js';
function context(): EventContext { return { projectId: randomUUID(), category: 'crud', operation: 'crud.list', resource: null, principal: 'anonymous', errorCode: null, responseBytes: null, started: process.hrtime.bigint(), recorded: false }; }
function event(projectId = randomUUID()) { const c = context(); c.projectId = projectId; return buildEvent(c,randomUUID(),'GET',200)!; }
test('safe event builder is immutable, monotonic, allowlisted and records once', () => {
  const c = context(); const id = randomUUID();
  Object.assign(c,{ body: 'secret', password: 'secret' });
  const e = buildEvent(c,id,'GET',200)!;
  assert.equal(e.requestId,id); assert.equal(e.eventVersion,1); assert.ok(e.durationUs >= 0); assert.ok(Object.isFrozen(e));
  assert.ok(!JSON.stringify(e).includes('secret')); assert.equal(buildEvent(c,id,'GET',200),undefined);
  assert.equal(buildEvent(context(),id,'OPTIONS',204),undefined);
  const unknown = context(); delete unknown.projectId; assert.equal(buildEvent(unknown,id,'GET',401),undefined);
});
test('queue is bounded globally/per project, enqueue never calls DB, batches <=32', async () => {
  const batches: readonly Readonly<RequestEvent>[][] = []; let calls = 0;
  const writer = new EventWriter(async (batch) => { calls++; (batches as Readonly<RequestEvent>[][]).push([...batch]); }, () => {});
  const project = randomUUID(); for (let i=0;i<70;i++) writer.enqueue(event(project));
  assert.equal(writer.depth,64); assert.equal(writer.droppedEvents,6); assert.equal(calls,0);
  for (let i=0;i<250;i++) writer.enqueue(event());
  assert.equal(writer.depth,256); assert.equal(writer.droppedEvents,64);
  await writer.close(); assert.ok(batches.every((b) => b.length<=32)); assert.equal(writer.depth,0);
});
test('failed/ambiguous batch is dropped without retry and logs are rate limited', async () => {
  let inserts=0,logs=0;
  const writer = new EventWriter(() => { inserts++; throw new Error('private SQL driver'); }, () => { logs++; });
  writer.enqueue(event()); await writer.flush(); await writer.flush();
  writer.enqueue(event()); await writer.flush();
  assert.equal(inserts,2); assert.equal(writer.writeFailures,2); assert.equal(logs,1); await writer.close();
});
test('cursor binds window/filters and rejects malformed, future and unsupported fields', () => {
  const now=Date.now(), p=parseFilters({ window:'1h', resource:'orders' },now);
  const token=nextCursor(p,new Date(now-100).toISOString(),randomUUID());
  assert.ok(parseFilters({ window:'1h',resource:'orders',cursor:token },now).last);
  for (const cursor of ['', '!', 'e30', token+'!']) assert.throws(() => parseFilters({cursor},now));
  assert.throws(() => parseFilters({window:'7d',resource:'orders',cursor:token},now));
  const decoded=JSON.parse(Buffer.from(token,'base64url').toString()); decoded.anchor=new Date(now+60000).toISOString();
  assert.throws(() => parseFilters({window:'1h',resource:'orders',cursor:Buffer.from(JSON.stringify(decoded)).toString('base64url')},now));
  const original=JSON.parse(Buffer.from(token,'base64url').toString());
  for(const patch of [{version:2},{id:'invalid'},{anchor:'2026-02-31T00:00:00.000Z'},{last:'invalid'},{last:new Date(now+1).toISOString()},{anchor:new Date(now-8*86400000).toISOString()},{filter:{window:'1h'}},{extra:true}]) {
    const cursor=Buffer.from(JSON.stringify({...original,...patch})).toString('base64url');
    assert.throws(()=>parseFilters({window:'1h',resource:'orders',cursor},now));
  }
  for (const q of [{limit:'101'},{window:'30d'},{window:'__proto__'},{window:'toString'},{statusClass:'6'},{resource:'row@secret'},{operation:'arbitrary'},{failuresOnly:'yes'}]) assert.throws(() => parseFilters(q));
});
test('known-project failures record exactly once; unknown, management and OPTIONS do not', async () => {
  const projectId=randomUUID(); const events: Readonly<RequestEvent>[]=[];
  const app=buildApp({env,logger:false,platformAuthRepository:memoryPlatformAuthRepository(),projectRepository:memoryRepository(),
    telemetry:{ enqueue(e) {events.push(e);} },
    runtimeAdmission: async (slug,resolved) => { if (slug==='unknown') return; resolved?.(projectId); if(slug==='suspended') throw new RuntimeError(503,'PROJECT_SUSPENDED','Suspended'); if(slug==='limited') throw new RuntimeError(429,'RUNTIME_RATE_LIMITED','Limited'); if(slug==='busy') throw new RuntimeError(503,'CUSTOMER_CAPACITY_EXHAUSTED','Busy'); if(slug==='timeout') throw new RuntimeError(504,'QUERY_TIMEOUT','Timed out'); if(slug==='unexpected') throw new Error('private'); },
    runtimeRepository:{async authenticate(){return undefined;},async resolve(){return undefined;}} });
  try {
    for(const [slug,status,code] of [['known',401,'UNAUTHORIZED'],['suspended',503,'PROJECT_SUSPENDED'],['limited',429,'RUNTIME_RATE_LIMITED'],['busy',503,'CUSTOMER_CAPACITY_EXHAUSTED'],['timeout',504,'QUERY_TIMEOUT'],['unexpected',500,'INTERNAL_ERROR']] as const) {
      const n=events.length; const response=await app.inject({url:`/api/${slug}/orders?filter[email][eq]=private-sentinel`,headers:{authorization:'Bearer private-token'}});
      assert.equal(response.statusCode,status); assert.equal(events.length,n+1); const e=events.at(-1)!;
      assert.equal(e.requestId,response.headers['x-request-id']); assert.equal(e.requestId,response.json().requestId); assert.equal(e.errorCode,code); assert.equal(e.principalKind,'anonymous'); assert.equal(e.projectId,projectId); assert.equal(e.resource,null);
      assert.equal(e.responseBytes,Buffer.byteLength(response.body)); assert.ok(!JSON.stringify(e).includes('private'));
    }
    const n=events.length; await app.inject('/api/unknown/orders'); await app.inject('/internal/projects'); await app.inject({method:'OPTIONS',url:'/api/known/orders'}); assert.equal(events.length,n);
  } finally {await app.close();}
});

test('shutdown drops a stuck batch after a bounded drain without unhandled promises',async()=>{
  let release:()=>void=()=>{};
  const writer=new EventWriter(()=>new Promise<void>((resolve)=>{release=resolve;}),()=>{});
  writer.enqueue(event());const active=writer.flush();writer.enqueue(event());
  const started=performance.now();await writer.close();assert.ok(performance.now()-started<2000);assert.equal(writer.depth,0);assert.equal(writer.droppedEvents,1);
  release();await active;
});
