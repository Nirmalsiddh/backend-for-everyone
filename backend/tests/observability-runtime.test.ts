import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { CredentialEncryption } from '../src/security/encryption.js';
import { normalizeDraft } from '../src/modules/schema-builder/validation.js';
import type { RuntimeTarget } from '../src/runtime/types.js';
import type { WorkflowRepository } from '../src/modules/workflows/types.js';
import type { AuthRepository } from '../src/modules/project-auth/types.js';
import type { RequestEvent } from '../src/modules/observability/events.js';
import { env, memoryRepository } from './helpers.js';
import { memoryPlatformAuthRepository } from './platform-auth-helpers.js';
import { RuntimeError } from '../src/runtime/errors.js';
import { EventWriter } from '../src/modules/observability/writer.js';
test('success/204/handled failure keep original outcomes with broken or full telemetry; failed workflow/auth classification', async () => {
  const projectId=randomUUID(),connectionId=randomUUID(),rowId=randomUUID();let fail:Error|undefined;let large=false;
  const events:Readonly<RequestEvent>[]=[];
  const config={host:'private.example',port:5432,database:'fixture',username:'fixture',password:'private-password',schema:'public',ssl:true};
  const target:RuntimeTarget={resourceName:'records',endpointId:randomUUID(),projectId,enabledOperations:['list','get','create','update','delete'],blocked:false,
    applied:{definition:{schema:'public',...normalizeDraft({name:'records',fields:[{name:'label',type:'text',nullable:false}]})},catalog:{}},
    connection:{id:connectionId,projectId,label:'Fixture',...new CredentialEncryption(env.connectionEncryptionKey).encrypt(config,`${projectId}:${connectionId}`),lastTestStatus:'success',lastTestedAt:new Date(),createdAt:new Date(),updatedAt:new Date()}};
  const writer=new EventWriter(async()=>{throw new Error('private-driver');},()=>{});
  const app=buildApp({env,logger:false,projectRepository:memoryRepository(),platformAuthRepository:memoryPlatformAuthRepository(),
    runtimeAdmission:async(_slug,resolved)=>{resolved?.(projectId);},
    telemetry:{enqueue(e){events.push(e);writer.enqueue(e);}},
    runtimeRepository:{async authenticate(){return{projectId,keyId:randomUUID(),scope:'read_write'};},async resolve(){return target;}},
    runtimeExecutor:async()=>{if(fail)throw fail;return[{id:rowId,label:large?'x'.repeat(1048576):'private-世界'}];},
    workflowRepository:{async resolve(_id: string,path: string){return path==='action'?{endpoint:{path:'action'},blocked:true}:undefined;}} as unknown as WorkflowRepository,
    authRepository:{async bySlug(){return undefined;}} as unknown as AuthRepository});
  const headers={authorization:'Bearer pk_'+'a'.repeat(43)},url='/api/fixture/records';
  try{
    for(const [method,status,payload] of [['GET',200,undefined],['HEAD',200,undefined],['POST',201,{label:'private'}],['DELETE',204,undefined]] as const){
      const response=await app.inject({method,url:method==='DELETE'?url+'/'+rowId:url,headers,...(payload?{payload}:{})});
      assert.equal(response.statusCode,status,response.body);const e=events.at(-1)!;assert.equal(e.status,status);assert.equal(e.responseBytes,Buffer.byteLength(response.body));assert.equal(e.principalKind,'project_key');assert.equal(e.resource,'records');
    }
    fail=new RuntimeError(409,'VALUE_CONFLICT','Conflict');const conflict=await app.inject({method:'POST',url,headers,payload:{label:'private'}});assert.equal(conflict.statusCode,409);assert.equal(events.at(-1)!.errorCode,'VALUE_CONFLICT');
    fail=new Error('private-driver');assert.equal((await app.inject({url,headers})).statusCode,500);
    fail=undefined;large=true;assert.equal((await app.inject({url,headers})).statusCode,422);assert.equal(events.at(-1)!.errorCode,'RESPONSE_TOO_LARGE');large=false;
    const workflow=await app.inject({method:'POST',url:'/api/fixture/action',headers,payload:{private:'payload'}});assert.equal(workflow.statusCode,503);assert.equal(events.at(-1)!.routeCategory,'workflow');assert.equal(events.at(-1)!.resource,'action');
    for(const action of ['signup','login','me','logout']){const response=await app.inject({method:action==='me'?'GET':'POST',url:'/api/fixture/auth/'+action});assert.equal(response.statusCode,401);assert.equal(events.at(-1)!.operation,'auth.'+action);assert.equal(events.at(-1)!.principalKind,'anonymous');}
    assert.equal(events.length,12);assert.ok(!JSON.stringify(events).includes('private'));await writer.flush();assert.ok(writer.writeFailures>0);
    fail=undefined;for(let i=0;i<300;i++)writer.enqueue(events[0]!);assert.equal(writer.depth,64);const before=events.length;
    const response=await app.inject({url,headers});assert.equal(response.statusCode,200);assert.equal(events.length,before+1);assert.ok(writer.droppedEvents>0);
  }finally{await app.close();await writer.close();}
});

test('workflow business responses never supply telemetry codes or bodies; UTF-8 size uses serialized payload',async()=>{
  const {TransactionAbort}=await import('../src/database/customer-db/transaction-runner.js');
  const projectId=randomUUID(),connectionId=randomUUID(),now=new Date(),versionId=randomUUID(),workflowId=randomUUID();
  const definition={auth:'key_only' as const,input:{},steps:[{id:randomUUID(),name:'respond',type:'response' as const,status:200,body:{kind:'literal' as const,value:'private-世界'}}]};
  const target={endpoint:{id:workflowId,projectId,connectionId,path:'echo',method:'POST' as const,enabled:true,draftDefinition:definition,draftRevision:1,publishedVersionId:versionId,createdAt:now,updatedAt:now},
    version:{id:versionId,workflowEndpointId:workflowId,version:1,definition,definitionHash:'a'.repeat(64),schemaDependencies:[],publishedAt:now},tables:[],blocked:false,
    connection:{id:connectionId,projectId,label:'Fixture',...new CredentialEncryption(env.connectionEncryptionKey).encrypt({schema:'public'},`${projectId}:${connectionId}`),lastTestStatus:'success' as const,lastTestedAt:now,createdAt:now,updatedAt:now}};
  const events:Readonly<RequestEvent>[]=[];
  const app=buildApp({env,logger:false,projectRepository:memoryRepository(),platformAuthRepository:memoryPlatformAuthRepository(),telemetry:{enqueue(e){events.push(e);}},
    runtimeRepository:{async authenticate(){return{projectId,keyId:randomUUID(),scope:'read_write'};},async resolve(){return undefined;}},
    workflowRepository:{async resolve(){return target;}} as unknown as WorkflowRepository,
    transactionRunner:async(_config,work)=>{try{return await work({async connect(){},async end(){},on(){},async query(){return{rows:[]};}});}catch(error){if(error instanceof TransactionAbort)return error.result;throw error;}}});
  try{
    const request={method:'POST' as const,url:'/api/fixture/echo',headers:{authorization:'Bearer pk_'+'a'.repeat(43)},payload:{}};
    const success=await app.inject(request);assert.equal(success.statusCode,200);assert.equal(success.json(),'private-世界');assert.equal(events[0]!.responseBytes,Buffer.byteLength(success.body));
    definition.steps[0]!.status=409;
    const failure=await app.inject(request);assert.equal(failure.statusCode,409);assert.equal(failure.json(),'private-世界');assert.equal(events.length,2);assert.equal(events[1]!.errorCode,null);assert.equal(events[1]!.operation,'workflow.execute');assert.equal(events[1]!.resource,'echo');assert.ok(!JSON.stringify(events).includes('private'));
  }finally{await app.close();}
});
