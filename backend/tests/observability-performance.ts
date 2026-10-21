// Explicitly invoked local benchmark; synthetic structural metadata only.
import { createPlatformDatabase } from '../src/database/platform-db/client.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ObservabilityReadStore } from '../src/modules/observability/read-store.js';
import { TelemetryStore } from '../src/modules/observability/store.js';
import { ObservabilityRepository } from '../src/modules/observability/queries.js';
import { EventWriter } from '../src/modules/observability/writer.js';
import { buildEvent, type EventContext } from '../src/modules/observability/events.js';
if(!process.env.TEST_DATABASE_URL)throw new Error('Explicit disposable database required');
const store=new TelemetryStore(process.env.TEST_DATABASE_URL,()=>{}),owner=randomUUID(),project=randomUUID(),request=randomUUID();

// Fixture creation uses the ordinary platform pool; measured reads/writes retain production telemetry budgets.
const {pool:fixture}=createPlatformDatabase(process.env.TEST_DATABASE_URL);
fixture.on('error',()=>{});
const repository=new ObservabilityRepository(new ObservabilityReadStore(fixture));
const measure=async(name:string,work:()=>Promise<unknown>)=>{
 const values:number[]=[];let failures=0;
 for(let i=0;i<5;i++){const start=performance.now();try{await work();values.push(performance.now()-start);}catch{failures++;}}
 values.sort((a,b)=>a-b);console.log(JSON.stringify({name,samples:values.length,failures,p50Ms:values[Math.floor(values.length*.5)]??null,p95Ms:values.at(-1)??null}));
};
try{
 await fixture.query('INSERT INTO users(id,email) VALUES($1,$2)',[owner,owner+'@example.test']);await fixture.query('INSERT INTO projects(id,owner_id,name,slug) VALUES($1,$2,$3,$4)',[project,owner,'Benchmark','benchmark-'+project]);
 for(const n of [1000,10000,100000]){
  // Only a dedicated disposable telemetry table may be truncated for clean storage samples.
  const other=(await fixture.query('SELECT EXISTS(SELECT 1 FROM runtime_request_events WHERE project_id<>$1) AS present',[project])).rows[0];
  if(other.present)throw new Error('Benchmark requires a dedicated disposable database');
  await fixture.query('TRUNCATE runtime_request_events');
  for(let i=0;i<n;i+=32)await fixture.query(`INSERT INTO runtime_request_events(id,project_id,request_id,completed_at,route_category,operation,resource,method,status,error_code,duration_us,principal_kind)
   SELECT gen_random_uuid(),$1,$2,date_trunc('milliseconds',now()-((g%604800)*interval '1 second')),'crud','crud.list','records','GET',CASE WHEN g%10=0 THEN 409 ELSE 200 END,CASE WHEN g%10=0 THEN 'VALUE_CONFLICT' ELSE NULL END,g%100000,'project_key' FROM generate_series($3::int,$4::int) AS g`,[project,request,i+1,Math.min(i+32,n)]);
  // Fresh bulk fixtures need current planner statistics, as normal autovacuum supplies over time.
  await fixture.query('ANALYZE runtime_request_events');
  for(const window of ['1h','24h','7d'])await measure(`${n} summary ${window}`,()=>repository.summary(project,owner,window));
  await measure(`${n} recent`,()=>repository.requests(project,owner,{}));await measure(`${n} lookup`,()=>repository.lookup(project,owner,request));
  console.log(JSON.stringify({name:'storage',events:n,...(await fixture.query("SELECT pg_table_size('runtime_request_events')::float8 AS table_bytes,pg_indexes_size('runtime_request_events')::float8 AS index_bytes,pg_total_relation_size('runtime_request_events')::float8 AS total_bytes")).rows[0]}));
 }
 for(const rate of [10,50,100]){
  const batchMs:number[]=[],enqueueUs:number[]=[];let maxDepth=0,written=0,maxConnections=0;const batchSizes:number[]=[];
  const writer=new EventWriter(async(events)=>{const start=performance.now();await store.insert(events);batchMs.push(performance.now()-start);written+=events.length;batchSizes.push(events.length);maxConnections=Math.max(maxConnections,store.pool.totalCount);},()=>{});
  for(let i=0;i<rate*2;i++){
   const c:EventContext={projectId:project,category:'crud',operation:'crud.list',resource:'records',principal:'project_key',errorCode:null,responseBytes:0,started:process.hrtime.bigint(),recorded:false};const event=buildEvent(c,randomUUID(),'GET',200)!;
   const start=performance.now();writer.enqueue(event);enqueueUs.push((performance.now()-start)*1000);maxDepth=Math.max(maxDepth,writer.depth);
   await new Promise(r=>setTimeout(r,1000/rate));
  }
  await writer.close();enqueueUs.sort((a,b)=>a-b);console.log(JSON.stringify({name:'writer',rate,written,maxDepth,maxConnections,maxBatch:Math.max(...batchSizes),averageBatch:written/batchSizes.length,drops:writer.droppedEvents,failures:writer.writeFailures,p50EnqueueUs:enqueueUs[Math.floor(enqueueUs.length*.5)],p95EnqueueUs:enqueueUs[Math.floor(enqueueUs.length*.95)],averageBatchMs:batchMs.reduce((a,b)=>a+b,0)/batchMs.length}));
 }
 const stale=async()=>{
   for(let i=0;i<5000;i+=32)await fixture.query(`INSERT INTO runtime_request_events(project_id,request_id,completed_at,route_category,method,status,duration_us,principal_kind)
     SELECT $1,gen_random_uuid(),now()-interval '8 days','unresolved','GET',200,0,'anonymous' FROM generate_series(1,$2::int)`,[project,Math.min(32,5000-i)]);
 };
 await stale();await measure('cleanup1000',()=>store.cleanup());
 await stale();await measure('cleanup1000_concurrent_read_insert',()=>Promise.all([
   store.cleanup(),repository.requests(project,owner,{window:'1h'}),store.insert([buildEvent({projectId:project,category:'crud',operation:'crud.list',resource:'records',principal:'anonymous',errorCode:null,responseBytes:0,started:process.hrtime.bigint(),recorded:false},randomUUID(),'GET',200)!])
 ]));
}catch{console.log(JSON.stringify({name:'benchmark_setup_failed',safeFailure:true}));process.exitCode=1;}finally{while ((await fixture.query('DELETE FROM runtime_request_events WHERE id IN (SELECT id FROM runtime_request_events WHERE project_id=$1 LIMIT 1000) RETURNING id',[project])).rows.length) { /* Bounded fixture cleanup. */ }await fixture.query('DELETE FROM projects WHERE id=$1',[project]);await fixture.query('DELETE FROM users WHERE id=$1',[owner]);await store.close();await fixture.end();}
