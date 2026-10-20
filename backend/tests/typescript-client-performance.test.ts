import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContract } from '../src/modules/typescript-client/contract.js';
import { compileSdk } from './sdk-compile-helper.js';
import { render } from '../src/modules/typescript-client/render.js';
import { field } from './api-docs-fixtures.js';
import type { DocsSnapshot } from '../src/modules/api-docs/types.js';
test('bounded on-demand SDK generation measurements including relationship-heavy contracts',async()=>{
  for (const [count,width,relationships] of [[1,10,false],[20,20,false],[20,100,false],[20,100,true]] as const) {
    const input:DocsSnapshot={project:{slug:'benchmark-project'},blocked:false,resources:[],tables:[],workflows:[]};
    for(let index=0;index<count;index++) {
      const name=`table_${index}`;
      const fields=Array.from({length:width},(_,i)=>field(`field_${i}`,'text',{nullable:true}));
      input.tables.push({id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,name,fields,applied:true,appliedRevision:1});
      input.resources.push({name,fields,operations:['list','get','create','update','delete'],policies:{}});
    }
    if(relationships)for(const resource of input.resources.slice(1)) {
      resource.includes=[];
      for(let index=0;index<width;index++) {
        const target=input.resources[index % input.resources.indexOf(resource)]!;
        resource.fields![index]!.type='uuid';resource.fields![index]!.relationship={tableId:input.tables.find((t)=>t.name===target.name)!.id,onDelete:'restrict'};
        resource.includes.push({name:resource.fields![index]!.name,referenceName:target.name,fields:target.fields!,policy:{mode:'key_only'}});
      }
    }
    const start=performance.now(),contract=buildContract(input),built=performance.now(),source=render(contract),end=performance.now();
    assert.ok(source.length>1000);
    if (relationships) { const compiled = await compileSdk(source); await compiled.cleanup(); }
    console.log(JSON.stringify({benchmark:'typescript-client',tables:count,fields:width,relationships,contractMs:built-start,renderMs:end-built,totalMs:end-start,sourceBytes:Buffer.byteLength(source),responseBytes:Buffer.byteLength(JSON.stringify({filename:'benchmark-project-client.ts',generatorVersion:'1',contractHash:contract.hash,tableRevisions:contract.tableRevisions,source}))}));
  }
});
