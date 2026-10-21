import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { EventEmitter } from 'node:events';
import { ObservabilityReadStore } from '../src/modules/observability/read-store.js';

test('dashboard reads scope their budget to a read-only transaction and restore pool state', async () => {
  const calls:string[]=[];let released=false;
  const client=Object.assign(new EventEmitter(),{
    async query(sql:string){calls.push(sql);return {rows:[{ok:true}]};},
    release(){released=true;},
  });
  const store=new ObservabilityReadStore({connect:async()=>client} as unknown as pg.Pool);
  assert.deepEqual((await store.query('SELECT 1')).rows,[{ok:true}]);
  assert.deepEqual(calls,['BEGIN READ ONLY',"SET LOCAL statement_timeout = '1000ms'","SET LOCAL lock_timeout = '100ms'",'SELECT 1','COMMIT']);
  assert.equal(released,true);assert.equal(client.listenerCount('error'),0);
});

test('dashboard read failure rolls back and sanitizes driver errors',async()=>{
  const calls:string[]=[];
  const client=Object.assign(new EventEmitter(),{async query(sql:string){calls.push(sql);if(sql==='SELECT secret')throw Error('sensitive driver message');return {rows:[]};},release(){}});
  const store=new ObservabilityReadStore({connect:async()=>client} as unknown as pg.Pool);
  await assert.rejects(store.query('SELECT secret'),{message:'Observability unavailable'});
  assert.equal(calls.at(-1),'ROLLBACK');
});

test('dashboard acquisition deadline releases a late connection without running SQL',async()=>{
  let released=false;
  const store=new ObservabilityReadStore({connect:()=>new Promise(resolve=>setTimeout(()=>resolve({release(){released=true;}}),300))} as unknown as pg.Pool);
  await assert.rejects(store.query('SELECT 1'),{message:'Observability unavailable'});
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(released,true);
});

test('dashboard absolute deadline destroys a stalled checked-out connection',async()=>{
  let rejectQuery:((error:Error)=>void)|undefined;let destroyed=false;
  const client=Object.assign(new EventEmitter(),{
    async query(sql:string){if(sql==='SELECT stalled')return new Promise<never>((_,reject)=>{rejectQuery=reject;});return {rows:[]};},
    release(destroy?:boolean){destroyed=destroy===true;rejectQuery?.(new Error('connection terminated'));},
  });
  const store=new ObservabilityReadStore({connect:async()=>client} as unknown as pg.Pool);
  await assert.rejects(store.query('SELECT stalled'),{message:'Observability unavailable'});
  assert.equal(destroyed,true);
});
