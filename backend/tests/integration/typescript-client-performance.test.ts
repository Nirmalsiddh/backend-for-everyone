import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createPlatformDatabase } from '../../src/database/platform-db/client.js';
import { users,projects,databaseConnections,schemaTables,endpoints } from '../../src/database/platform-db/schema.js';
import { PostgresDocsRepository } from '../../src/modules/api-docs/repository.js';
import { buildContract } from '../../src/modules/typescript-client/contract.js';
import { render } from '../../src/modules/typescript-client/render.js';
import { field } from '../api-docs-fixtures.js';
test('SDK total generation measurements from real owner-scoped PostgreSQL snapshots',async(t)=>{
  const {db,pool}=createPlatformDatabase(process.env.TEST_DATABASE_URL!);
  const owner=randomUUID(),project=randomUUID(),connection=randomUUID();
  t.after(async()=>{try {
    await db.delete(schemaTables).where(eq(schemaTables.projectId,project));
    await db.delete(databaseConnections).where(eq(databaseConnections.projectId,project));
    await db.delete(projects).where(eq(projects.id,project));await db.delete(users).where(eq(users.id,owner));
  }finally{await pool.end();}});
  await migrate(db,{migrationsFolder:fileURLToPath(new URL('../../migrations',import.meta.url))});
  await db.insert(users).values({id:owner,email:owner+'@example.test'});
  await db.insert(projects).values({id:project,ownerId:owner,name:'SDK benchmark',slug:'sdk-'+project});
  await db.insert(databaseConnections).values({id:connection,projectId:project,label:'Never decrypted',encryptedConfig:'unusable-secret',encryptionIv:'11'.repeat(12),encryptionTag:'11'.repeat(12),encryptionVersion:1,lastTestStatus:'success',lastTestedAt:new Date()});
  for(const [count,width,relationships]of [[1,10,false],[20,20,false],[20,100,false],[20,100,true]]as const){
    await db.delete(schemaTables).where(eq(schemaTables.projectId,project));
    const ids=Array.from({length:count},()=>randomUUID());
    for(let index=0;index<count;index++){
      const name='resource_'+index;
      const fields=Array.from({length:width},(_,position)=>field('field_'+position,relationships&&index>0?'uuid':'text',{id:randomUUID(),position,nullable:true,...(relationships&&index>0?{relationship:{tableId:ids[position%index]!,onDelete:'restrict' as const}}:{})}));
      await db.insert(schemaTables).values({id:ids[index]!,projectId:project,connectionId:connection,schemaName:'sdk_measurement',name,draftRevision:1,appliedRevision:1,appliedPhysicalRevision:1,appliedDefinition:{definition:{schema:'sdk_measurement',name,fields},catalog:{}}});
      await db.insert(endpoints).values({projectId:project,tableId:ids[index]!,resourceName:name,enabledOperations:['list','get','create','update','delete'],policies:{}});
    }
    const start=performance.now();
    const snapshot=await new PostgresDocsRepository(db).snapshot(project,owner,{workflows:false});
    const fetched=performance.now();assert.ok(snapshot);
    const contract=buildContract(snapshot),built=performance.now(),source=render(contract),end=performance.now();
    const response={filename:'benchmark-client.ts',generatorVersion:'1',contractHash:contract.hash,tableRevisions:contract.tableRevisions,source};
    assert.ok(!source.includes('unusable-secret'));
    console.log(JSON.stringify({benchmark:'sdk-total',tables:count,fields:width,relationships,snapshotMs:fetched-start,contractMs:built-fetched,renderMs:end-built,totalMs:end-start,sourceBytes:Buffer.byteLength(source),responseBytes:Buffer.byteLength(JSON.stringify(response))}));
  }
});
