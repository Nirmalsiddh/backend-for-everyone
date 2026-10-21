import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observabilityQueryAllowed, validRequestId } from '../src/lib/observability';
import { managementDto, supported } from '../src/lib/server/adapter';
const project='11111111-1111-4111-8111-111111111111';
test('observability proxy allowlists methods, query keys and recursively projects DTOs',()=>{
  const base=`projects/${project}/observability`;
  assert.ok(supported(base+'/requests','GET'));assert.ok(!supported(base+'/requests','POST'));
  assert.ok(observabilityQueryAllowed(base+'/requests',['window','cursor','resource']));
  assert.ok(!observabilityQueryAllowed(base+'/summary',['cursor']));assert.ok(!observabilityQueryAllowed(base+'/requests',['secret']));
  const projected=managementDto(base+'/requests','GET',{items:[{requestId:project,status:200,body:'private',authorization:'private'}],nextCursor:null,secret:'private'});
  assert.ok(!JSON.stringify(projected).includes('private'));
  assert.ok(validRequestId(project));assert.ok(!validRequestId('private'));
});
