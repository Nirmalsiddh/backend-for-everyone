import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,cp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
test('v0.12 platform upgrades add only an empty telemetry table and preserve project/field metadata',async(t)=>{
  if(!process.env.TEST_OBSERVABILITY_UPGRADE_DATABASE_URL){t.skip('Explicit empty disposable TEST_OBSERVABILITY_UPGRADE_DATABASE_URL required');return;}
  const {db,pool}=createPlatformDatabase(process.env.TEST_OBSERVABILITY_UPGRADE_DATABASE_URL);
  const folder=await mkdtemp(join(tmpdir(),'v13-upgrade-'));const source=fileURLToPath(new URL('../../migrations',import.meta.url));
  t.after(async()=>{await pool.end();await rm(folder,{recursive:true,force:true});});
  await cp(source,folder,{recursive:true});
  const journal=JSON.parse(await readFile(join(folder,'meta/_journal.json'),'utf8'));journal.entries=journal.entries.filter((e:{idx:number})=>e.idx<=10);
  await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));await migrate(db,{migrationsFolder:folder});
  const owner=randomUUID(),project=randomUUID();
  await pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[owner,owner+'@example.test']);await pool.query('INSERT INTO projects(id,owner_id,name,slug) VALUES($1,$2,$3,$4)',[project,owner,'Upgrade','upgrade-'+project]);
  const before=(await pool.query('SELECT * FROM projects WHERE id=$1',[project])).rows;
  const columns=(await pool.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='schema_fields' ORDER BY ordinal_position")).rows;
  await migrate(db,{migrationsFolder:source});assert.deepEqual((await pool.query('SELECT * FROM projects WHERE id=$1',[project])).rows,before);
  assert.deepEqual((await pool.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='schema_fields' ORDER BY ordinal_position")).rows,columns);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM runtime_request_events')).rows[0].n,0);
  await pool.query("INSERT INTO runtime_request_events(project_id,request_id,completed_at,route_category,method,status,duration_us,principal_kind) VALUES($1,$2,now(),'unresolved','GET',200,0,'anonymous')",[project,randomUUID()]);
  await pool.query('DELETE FROM projects WHERE id=$1',[project]);assert.equal((await pool.query('SELECT count(*)::int AS n FROM runtime_request_events')).rows[0].n,0);await pool.query('DELETE FROM users WHERE id=$1',[owner]);
});
