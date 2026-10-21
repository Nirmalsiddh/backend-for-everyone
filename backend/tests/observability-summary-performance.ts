// Explicit disposable PostgreSQL benchmark. Synthetic metadata only.
import { createPlatformDatabase } from '../src/database/platform-db/client.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { appendFileSync } from 'node:fs';
import { TelemetryStore } from '../src/modules/observability/store.js';
import { ObservabilityReadStore } from '../src/modules/observability/read-store.js';
import { ObservabilityRepository } from '../src/modules/observability/queries.js';
const url=process.env.TEST_DATABASE_URL;if(!url)throw Error('Disposable database required');
const {pool}=createPlatformDatabase(url);
pool.on('error',()=>{});
const owner=randomUUID(),project=randomUUID();
const output=(value:unknown)=>{const line=JSON.stringify(value);console.log(line);appendFileSync(new URL('../../OBSERVABILITY_MEASUREMENTS.jsonl',import.meta.url),line+'\n');};
try {
 await pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[owner,owner+'@example.test']);
 await pool.query('INSERT INTO projects(id,owner_id,name,slug) VALUES($1,$2,$3,$4)',[project,owner,'Summary benchmark','summary-'+project]);
 if((await pool.query('SELECT count(*)::int AS n FROM runtime_request_events')).rows[0].n)throw Error('Empty disposable telemetry table required');
 for(const n of (process.env.SUMMARY_SIZES??'10000,100000,250000').split(',').map(Number)){
 await pool.query('TRUNCATE runtime_request_events');
 for(let offset=0;offset<n;offset+=1000)await pool.query(`INSERT INTO runtime_request_events(project_id,request_id,completed_at,route_category,operation,resource,method,status,error_code,duration_us,principal_kind)
 SELECT $1,gen_random_uuid(),date_trunc('milliseconds',now()-(g%604800)*interval '1 second'),'crud',
 (ARRAY['crud.list','crud.get','crud.create','crud.update','crud.delete'])[1+g%5],
 'resource_'||(g%20), 'GET',(ARRAY[200,201,204,302,400,401,403,404,409,429,500,503])[1+g%12],
 CASE WHEN g%3=0 THEN (ARRAY['VALUE_CONFLICT','AUTH_REQUIRED','INTERNAL_ERROR'])[1+(g/3)%3] ELSE NULL END,
 (g*7919)%1000000,'anonymous' FROM generate_series($2::int,$3::int) g`,[project,offset+1,Math.min(n,offset+1000)]);
 await pool.query('ANALYZE runtime_request_events');
 for(const window of ['1h','24h','7d']){
 let sql='',values:unknown[]=[];
 const capture=new ObservabilityRepository({async query(text,args){if(text.startsWith('SELECT id FROM projects'))return {rows:[{id:project}]};sql=text;values=args??[];return {rows:[{totals:{},operations:[],errors:[]}]};}});
 await capture.summary(project,owner,window);
 const base=' FROM runtime_request_events WHERE project_id=$1 AND completed_at >=$2 AND completed_at <=$3';
 const components={summary:sql,status:'SELECT count(*),count(*) FILTER(WHERE status>=400)'+base,
 percentiles:'SELECT percentile_cont(ARRAY[0.5,0.95]) WITHIN GROUP(ORDER BY duration_us)'+base,
 operations:'SELECT resource,operation,count(*),percentile_cont(0.95) WITHIN GROUP(ORDER BY duration_us)'+base+' GROUP BY resource,operation ORDER BY count(*) DESC LIMIT 20',
 errors:'SELECT error_code,count(*)'+base+' AND error_code IS NOT NULL GROUP BY error_code ORDER BY count(*) DESC LIMIT 20'};
 for(const [component,text] of (process.env.SKIP_PLANS ? [] : Object.entries(components))){
 const plan=(await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+text,values)).rows[0]['QUERY PLAN'][0];
 output({phase:'summary_hardening_original_plan',events:n,window,component,plan});
 }
 const repository=new ObservabilityRepository(new ObservabilityReadStore(pool));
 const times:number[]=[];let failures=0;
 for(let i=0;i<5;i++){const start=performance.now();try{const summary=await repository.summary(project,owner,window);if(window==='7d' && (summary.recordedRequests!==n || summary.topOperations.length!==20 || summary.topErrorCodes.length!==3))throw Error('Synthetic summary mismatch');times.push(performance.now()-start);}catch{failures++;}}
 times.sort((a,b)=>a-b);output({phase:process.env.MEASUREMENT_PHASE??'summary_hardening_final',events:n,window,samples:times.length,failures,p50Ms:times[Math.floor(times.length*.5)]??null,p95Ms:times.at(-1)??null});
 }
 output({phase:'summary_hardening_storage',events:n,...(await pool.query("SELECT pg_table_size('runtime_request_events')::float8 table_bytes,pg_indexes_size('runtime_request_events')::float8 index_bytes,pg_total_relation_size('runtime_request_events')::float8 total_bytes")).rows[0]});
 if(n===100000 && process.env.CHECK_CONTENTION){
 const writer=new TelemetryStore(url,()=>{});
 try {
 for(let i=0;i<5;i++)await pool.query(`INSERT INTO runtime_request_events(project_id,request_id,completed_at,route_category,method,status,duration_us,principal_kind) SELECT $1,gen_random_uuid(),now()-interval '8 days','unresolved','GET',200,0,'anonymous' FROM generate_series(1,1000)`,[project]);
 const repository=new ObservabilityRepository(new ObservabilityReadStore(pool));
 const times:number[]=[];let failures=0;
 for(let i=0;i<5;i++){const start=performance.now();try{await Promise.all([repository.summary(project,owner,'7d'),writer.cleanup(),writer.query(`INSERT INTO runtime_request_events(project_id,request_id,completed_at,route_category,method,status,duration_us,principal_kind) VALUES($1,gen_random_uuid(),now(),'unresolved','GET',200,0,'anonymous')`,[project])]);times.push(performance.now()-start);}catch{failures++;}}
 times.sort((a,b)=>a-b);output({phase:'summary_hardening_cleanup_contention',events:n,samples:times.length,failures,p50Ms:times[Math.floor(times.length*.5)]??null,p95Ms:times.at(-1)??null});
 }finally{await writer.close();}
 }
 }
}finally{await pool.query('DELETE FROM projects WHERE id=$1',[project]);await pool.query('DELETE FROM users WHERE id=$1',[owner]);await pool.end();}
