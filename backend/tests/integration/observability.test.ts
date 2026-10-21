import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from '../../src/app.js';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { ObservabilityReadStore } from '../../src/modules/observability/read-store.js';
import { TelemetryStore } from '../../src/modules/observability/store.js';
import { EventWriter } from '../../src/modules/observability/writer.js';
import { ObservabilityRepository } from '../../src/modules/observability/queries.js';
import { runtimeAdmission } from '../../src/operations/runtime-admission.js';
import { PostgresProjectRepository } from '../../src/modules/projects/repository.js';
import { PostgresConnectionRepository } from '../../src/modules/database-connections/repository.js';
import { PostgresSchemaRepository } from '../../src/modules/schema-builder/repository.js';
import { PostgresEndpointRepository } from '../../src/modules/endpoints/repository.js';
import { PostgresApiKeyRepository } from '../../src/modules/api-keys/repository.js';
import { PostgresRuntimeRepository } from '../../src/runtime/repository.js';
import { PostgresDocsRepository } from '../../src/modules/api-docs/repository.js';
import { memoryPlatformAuthRepository } from '../platform-auth-helpers.js';
import { env, auth } from '../helpers.js';

test('observability PostgreSQL: customer commit/failure isolation, privacy, retention, ownership and contract invariance', async (t) => {
  if(!process.env.TEST_DATABASE_URL || !process.env.TEST_CUSTOMER_DATABASE_URL) throw new Error('Explicit disposable databases required');
  const {db,pool}=createPlatformDatabase(process.env.TEST_DATABASE_URL);
  await migrate(db,{migrationsFolder:fileURLToPath(new URL('../../migrations',import.meta.url))});
  const customer=new pg.Client({connectionString:process.env.TEST_CUSTOMER_DATABASE_URL});await customer.connect();
  const schema='obs_'+randomUUID().replaceAll('-','');await customer.query(`CREATE SCHEMA "${schema}"`);
  const owner=randomUUID(),other=randomUUID();
  await pool.query('INSERT INTO users(id,email) VALUES($1,$2),($3,$4)',[owner,owner+'@example.test',other,other+'@example.test']);
  const projects=new PostgresProjectRepository(db);
  const project=await projects.create(owner,{name:'Observability',slug:'obs-'+randomUUID()});
  const second=await projects.create(other,{name:'Other',slug:'obs-'+randomUUID()});
  const store=new TelemetryStore(process.env.TEST_DATABASE_URL,()=>{});
  let fail=false,loseTelemetryAck=false;const logs:string[]=[];
  const writer=new EventWriter(async(events)=>{if(fail) await store.query('INSERT INTO nonexistent_telemetry_table VALUES (1)');else {await store.insert(events);if(loseTelemetryAck)throw new Error('Synthetic lost telemetry acknowledgement');}},(message)=>logs.push(message));
  const repository=new ObservabilityRepository(new ObservabilityReadStore(pool));
  const app=buildApp({env,logger:false,projectRepository:projects,platformAuthRepository:memoryPlatformAuthRepository(owner),
    connectionRepository:new PostgresConnectionRepository(db),schemaRepository:new PostgresSchemaRepository(db),endpointRepository:new PostgresEndpointRepository(db),
    apiKeyRepository:new PostgresApiKeyRepository(db),runtimeRepository:new PostgresRuntimeRepository(db),docsRepository:new PostgresDocsRepository(db),
    runtimeAdmission:runtimeAdmission(db),telemetry:writer,observabilityRepository:repository});
  t.after(async()=>{await app.close();await writer.close();await store.close();await customer.query(`DROP SCHEMA "${schema}" CASCADE`);await customer.end();
    await pool.query('DELETE FROM schema_tables WHERE project_id=$1',[project.id]);await pool.query('DELETE FROM database_connections WHERE project_id=$1',[project.id]);
    await pool.query('DELETE FROM projects WHERE id=ANY($1::uuid[])',[[project.id,second.id]]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,other]]);await pool.end();});
  async function call(path:string,method:'GET'|'POST'|'PUT'='GET',payload?:unknown){const r=await app.inject({method,url:'/internal/projects/'+project.id+path,headers:auth,...(payload===undefined?{}:{payload:payload as object})});assert.ok(r.statusCode<300,r.body);return r.json();}
  const u=new URL(process.env.TEST_CUSTOMER_DATABASE_URL);
  await call('/database-connection','POST',{label:'Disposable',host:u.hostname,port:Number(u.port||5432),database:u.pathname.slice(1),username:decodeURIComponent(u.username),password:decodeURIComponent(u.password)||'synthetic-local-password',schema,ssl:false});
  const table=await call('/schema/tables','POST',{name:'obs_records',fields:[{name:'label',type:'text',nullable:false,unique:true}]});
  const path='/schema/tables/'+table.id,preview=await call(path+'/preview','POST');
  await call(path+'/apply','POST',{expectedDraftRevision:preview.draftRevision,planHash:preview.planHash});
  await call(path+'/api','PUT',{enabledOperations:['list','create','get','update','delete'],expectedAppliedRevision:1,expectedConfigRevision:0});
  const key=(await call('/api-keys','POST',{name:'Synthetic fixture',scope:'read_write'})).key;
  const readKey=(await call('/api-keys','POST',{name:'Read-only synthetic fixture',scope:'read'})).key;
  const before={sdk:await call('/sdk/typescript'),openapi:await call('/openapi'),table:await call(path),endpoint:await call(path+'/api')};
  const headers={authorization:'Bearer '+key};const url='/api/'+project.slug+'/obs_records';
  const sentinel='synthetic-private-email@example.test';
  fail=true;
  const created=await app.inject({method:'POST',url,headers,payload:{label:sentinel}});assert.equal(created.statusCode,201,created.body);
  await writer.flush();assert.ok(writer.writeFailures>=1);
  assert.equal((await customer.query(`SELECT count(*)::integer AS n FROM "${schema}".obs_records`)).rows[0].n,1);
  const conflict=await app.inject({method:'POST',url,headers,payload:{label:sentinel}});assert.equal(conflict.statusCode,409);assert.equal(conflict.json().code,'VALUE_CONFLICT');
  await writer.flush();assert.ok(logs.every((line)=>!line.includes(sentinel)&&!line.includes(key)));
  assert.deepEqual(await call('/sdk/typescript'),before.sdk);assert.deepEqual(await call('/openapi'),before.openapi);
  fail=false;
  const responses=[];
  responses.push(await app.inject({url,headers}));
  responses.push(await app.inject({method:'POST',url,headers,payload:{label:'second-safe-value'}}));
  responses.push(await app.inject({method:'POST',url,headers,payload:{label:sentinel}}));
  responses.push(await app.inject({url,headers:{authorization:'Bearer pk_'+'x'.repeat(43)}}));
  responses.push(await app.inject({url:url+'?filter[label][eq]='+encodeURIComponent(sentinel),headers}));
  responses.push(await app.inject({url:url+'/'+randomUUID(),headers}));
  const row=created.json();responses.push(await app.inject({method:'DELETE',url:url+'/'+row.id,headers}));
  responses.push(await app.inject({method:'POST',url,headers:{authorization:'Bearer '+readKey},payload:{label:'synthetic-read-scope-value'}}));
  responses.push(await app.inject({method:'POST',url,headers:{...headers,cookie:'synthetic-private-cookie','user-agent':'synthetic-private-agent',origin:'https://synthetic-private-origin.test'},payload:{label:'synthetic-private-json-value',unexpected:{email:'synthetic-json@example.test',password:'synthetic-private-json-password'}}}));
  await writer.flush();
  const events=(await pool.query('SELECT * FROM runtime_request_events WHERE project_id=$1',[project.id])).rows;
  assert.equal(events.length,responses.length);
  for(const response of responses){const matches=events.filter(e=>e.request_id===response.headers['x-request-id']);assert.equal(matches.length,1);assert.equal(matches[0].status,response.statusCode);assert.equal(Number(matches[0].response_bytes),Buffer.byteLength(response.body));}
  const stored=JSON.stringify(events);
  for(const secret of [sentinel,key,readKey,row.id,'pk_'+'x'.repeat(43),'synthetic-read-scope-value','synthetic-private-cookie','synthetic-private-agent','synthetic-private-origin','synthetic-private-json-value','synthetic-json@example.test','synthetic-private-json-password'])assert.ok(!stored.includes(secret));
  const invalid=events.find(e=>e.status===401);assert.equal(invalid.principal_kind,'anonymous');assert.equal(invalid.error_code,'UNAUTHORIZED');
  const summary=await call('/observability/summary?window=24h');assert.equal(summary.recordedRequests,responses.length);assert.equal(summary['4xx'],5);assert.ok(summary.p95DurationMs>=0);
  const first=await call('/observability/requests?limit=2');assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  const next=await call('/observability/requests?limit=2&cursor='+first.nextCursor);assert.ok(next.items.every((e:{id:string})=>!first.items.some((p:{id:string})=>p.id===e.id)));
  const id=responses[0]!.headers['x-request-id'] as string;assert.equal((await call('/observability/requests/'+id)).items.length,1);
  assert.ok(!JSON.stringify(await call('/observability/requests')).includes(sentinel));
  const denied=await app.inject({url:'/internal/projects/'+second.id+'/observability/requests/'+id,headers:auth});assert.equal(denied.statusCode,404);
  for(const credentials of [headers,{authorization:'Bearer us_'+'s'.repeat(43)}]) assert.equal((await app.inject({url:'/internal/projects/'+project.id+'/observability/summary',headers:credentials})).statusCode,401);
  assert.equal((await app.inject({url:'/internal/projects/'+project.id+'/observability/requests?cursor=invalid',headers:auth})).statusCode,400);
  await app.inject({url:'/api/unknown-project/obs_records',headers});await app.inject({method:'OPTIONS',url,headers});await writer.flush();assert.equal((await call('/observability/summary')).recordedRequests,responses.length);
  const expiredRequest=randomUUID();
  await pool.query(`INSERT INTO runtime_request_events(id,project_id,request_id,completed_at,route_category,method,status,duration_us,principal_kind)
    SELECT gen_random_uuid(),$1,$2,now()-interval '8 days','unresolved','GET',200,1,'anonymous' FROM generate_series(1,1001)`,[project.id,expiredRequest]);
  assert.equal((await app.inject({url:'/internal/projects/'+project.id+'/observability/requests/'+expiredRequest,headers:auth})).statusCode,404);
  assert.equal((await call('/observability/summary?window=7d')).recordedRequests,responses.length);
  const lease=await pool.connect();
  try {await lease.query('SELECT pg_advisory_lock(783190246)');assert.equal(await store.cleanup(),0);}
  finally {await lease.query('SELECT pg_advisory_unlock(783190246)');lease.release();}
  await store.cleanup();assert.equal((await pool.query("SELECT count(*)::int AS n FROM runtime_request_events WHERE project_id=$1 AND completed_at<now()-interval '7 days'",[project.id])).rows[0].n,1);
  await store.cleanup();assert.equal((await pool.query("SELECT count(*)::int AS n FROM runtime_request_events WHERE project_id=$1 AND completed_at<now()-interval '7 days'",[project.id])).rows[0].n,0);
  await pool.query(`INSERT INTO runtime_request_events(id,project_id,request_id,completed_at,event_version,route_category,operation,resource,method,status,error_code,duration_us,response_bytes,principal_kind)
    SELECT gen_random_uuid(),project_id,request_id,completed_at,event_version,route_category,operation,resource,method,status,error_code,duration_us,response_bytes,principal_kind FROM runtime_request_events WHERE project_id=$1 AND request_id=$2 LIMIT 1`,[project.id,id]);
  assert.equal((await call('/observability/requests/'+id)).items.length,2);
  const latency: Record<'enabled'|'disabled', number[]> = {enabled:[],disabled:[]};
  const measured = [false,true].map((enabled) => buildApp({ env,logger:false,projectRepository:projects,platformAuthRepository:memoryPlatformAuthRepository(owner),
    runtimeRepository:new PostgresRuntimeRepository(db),runtimeAdmission:async(_slug,resolved)=>{resolved?.(project.id);},
    ...(enabled?{telemetry:writer}:{}) }));
  try {
    for (const application of measured) for(let i=0;i<3;i++) assert.equal((await application.inject({url,headers})).statusCode,200);
    for(let i=0;i<30;i++) for(const index of i%2 ? [1,0] : [0,1]) {
      const start=performance.now();const r=await measured[index]!.inject({url,headers});assert.equal(r.statusCode,200);
      latency[index?'enabled':'disabled'].push(performance.now()-start);
    }
  } finally { for(const application of measured) await application.close(); }
  const differences=latency.enabled.map((value,i)=>value-latency.disabled[i]!).sort((a,b)=>a-b);
  latency.enabled.sort((a,b)=>a-b);latency.disabled.sort((a,b)=>a-b);
  console.log(JSON.stringify({benchmark:'observability-runtime-overhead',samples:30,method:'interleaved real CRUD/customer PostgreSQL; three warmups; benchmark admission bypasses rate limiter equally',
    disabledP50Ms:latency.disabled[15],disabledP95Ms:latency.disabled[28],enabledP50Ms:latency.enabled[15],enabledP95Ms:latency.enabled[28],pairedDeltaP50Ms:differences[15],pairedDeltaP95Ms:differences[28]}));
  await writer.flush();
  loseTelemetryAck=true;
  const ambiguous=await app.inject({url,headers});assert.equal(ambiguous.statusCode,200);
  await writer.flush();loseTelemetryAck=false;await writer.flush();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM runtime_request_events WHERE project_id=$1 AND request_id=$2',[project.id,ambiguous.headers['x-request-id']])).rows[0].n,1);
  for (let i=0;i<100;i++) await pool.query(`INSERT INTO runtime_request_events(project_id,request_id,completed_at,route_category,operation,resource,method,status,duration_us,principal_kind)
    SELECT $1,gen_random_uuid(),now(),'crud','crud.list','obs_records','GET',200,1,'project_key' FROM generate_series(1,1000)`,[project.id]);
  const tied=await call('/observability/requests?limit=100');assert.equal(tied.items.length,100);
  const tiedNext=await call('/observability/requests?limit=100&cursor='+tied.nextCursor);assert.equal(tiedNext.items.length,100);
  assert.ok(tiedNext.items.every((e:{id:string})=>!tied.items.some((p:{id:string})=>p.id===e.id)));
  assert.deepEqual(await call('/sdk/typescript'),before.sdk);assert.deepEqual(await call('/openapi'),before.openapi);assert.deepEqual(await call(path),before.table);assert.deepEqual(await call(path+'/api'),before.endpoint);
  await pool.query('DELETE FROM runtime_request_events WHERE project_id=$1',[project.id]);
});

test('telemetry timeout terminates database work; outage drops batches and releases pool',async()=>{
  if(!process.env.TEST_DATABASE_URL)throw new Error('Explicit disposable database required');
  const store=new TelemetryStore(process.env.TEST_DATABASE_URL,()=>{});
  try{
    await store.query('SELECT 1');
    const started=performance.now();await assert.rejects(()=>store.query('SELECT pg_sleep(2)'));assert.ok(performance.now()-started<1000);
    assert.equal((await store.query('SELECT 1 AS n')).rows[0].n,1);
    const control=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await control.connect();
    try{
      const pid=(await store.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const failed=assert.rejects(store.query('SELECT pg_sleep(2)'));
      await control.query('SELECT pg_terminate_backend($1)',[pid]);
      await failed;
    }finally{await control.end();}

  }finally{await store.close();}
  const url=new URL(process.env.TEST_DATABASE_URL);url.port='1';
  const unavailable=new TelemetryStore(url.toString(),()=>{});
  const writer=new EventWriter(events=>unavailable.insert(events),()=>{});
  try{
    const {buildEvent}=await import('../../src/modules/observability/events.js');
    const event=buildEvent({projectId:randomUUID(),category:'unresolved',operation:null,resource:null,principal:'anonymous',errorCode:null,responseBytes:null,started:process.hrtime.bigint(),recorded:false},randomUUID(),'GET',200)!;
    writer.enqueue(event);await writer.flush();assert.equal(writer.writeFailures,1);assert.equal(writer.depth,0);await writer.flush();assert.equal(writer.writeFailures,1);
  }finally{await writer.close();await unavailable.close();}
});

test('observability management reads have independent bounded deadlines and restore management settings',async()=>{
  if(!process.env.TEST_DATABASE_URL)throw new Error('Explicit disposable database required');
  const {pool}=createPlatformDatabase(process.env.TEST_DATABASE_URL);
  const reads=new ObservabilityReadStore(pool);
  try {
    // A read longer than the writer statement budget is valid for management.
    await reads.query('SELECT pg_sleep(0.25)');
    const start=performance.now();
    await assert.rejects(reads.query('SELECT pg_sleep(2)'),{message:'Observability unavailable'});
    assert.ok(performance.now()-start<1600);
    assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout,'5s');
    assert.equal((await reads.query('SELECT 1 AS healthy')).rows[0].healthy,1);
  } finally {await pool.end();}
});

test('management summary preserves exact counts, percentiles, operation/error groups and retention',async()=>{
  if(!process.env.TEST_DATABASE_URL)throw new Error('Explicit disposable database required');
  const {pool}=createPlatformDatabase(process.env.TEST_DATABASE_URL);
  const owner=randomUUID(),project=randomUUID();
  try {
    await pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[owner,owner+'@example.test']);
    await pool.query('INSERT INTO projects(id,owner_id,name,slug) VALUES($1,$2,$3,$4)',[project,owner,'Summary correctness','summary-'+project]);
    await pool.query(`INSERT INTO runtime_request_events(project_id,request_id,completed_at,route_category,operation,resource,method,status,error_code,duration_us,principal_kind)
      SELECT $1,gen_random_uuid(),now()-interval '1 minute','crud',CASE WHEN g%2=0 THEN 'crud.get' ELSE 'crud.list' END,'records','GET',
      (ARRAY[200,302,409,503])[1+g%4],CASE WHEN g%2=0 THEN 'VALUE_CONFLICT' ELSE NULL END,g*1000,'anonymous' FROM generate_series(1,20) g`,[project]);
    await pool.query(`INSERT INTO runtime_request_events(project_id,request_id,completed_at,route_category,method,status,duration_us,principal_kind)
      VALUES($1,gen_random_uuid(),now()-interval '8 days','unresolved','GET',500,999999,'anonymous')`,[project]);
    const repository=new ObservabilityRepository(new ObservabilityReadStore(pool));
    for(const window of ['1h','24h','7d']){
      const summary=await repository.summary(project,owner,window);
      assert.equal(summary.recordedRequests,20);
      for(const status of ['2xx','3xx','4xx','5xx'])assert.equal(summary[status],5);
      assert.equal(summary.p50DurationMs,10.5);assert.ok(Math.abs(summary.p95DurationMs-19.05)<1e-9);
      assert.equal(summary.topOperations.length,2);
      assert.ok(summary.topOperations.every((item:{recordedRequests:number})=>item.recordedRequests===10));
      assert.deepEqual(summary.topErrorCodes,[{errorCode:'VALUE_CONFLICT',count:10}]);
    }
  } finally {await pool.query('DELETE FROM projects WHERE id=$1',[project]);await pool.query('DELETE FROM users WHERE id=$1',[owner]);await pool.end();}
});
