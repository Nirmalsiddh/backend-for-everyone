import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { signupLogin, login } from './platform-account';
import { compileSdk } from './sdk-compile';

test('standalone TypeScript download: applied isolation, normal index invariance, methods, auth and safe refresh', async ({ page, context }) => {
  if(process.env.E2E_PLATFORM_ACCOUNT_EMAIL)await login(page,process.env.E2E_PLATFORM_ACCOUNT_EMAIL);else await signupLogin(page);
  const call=async(path:string,method='GET',body?:unknown)=>{
    const response=await page.evaluate(async({path,method,body})=>{
      const response=await fetch(path,{method,headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,body:response.status===204?null:await response.json()};
    },{path,method,body});
    expect(response.status,JSON.stringify(response.body)).toBeLessThan(300);return response.body;
  };
  const suffix=randomUUID().slice(0,8);
  const project=await call('/api/management/projects','POST',{name:'TypeScript '+suffix,slug:'sdk-'+suffix});
  const management='/api/management/projects/'+project.id;
  const url=new URL(process.env.E2E_CUSTOMER_DATABASE_URL!);
  await call(management+'/database-connection','POST',{label:'SDK disposable fixture',host:url.hostname,port:Number(url.port||5432),database:url.pathname.slice(1),username:decodeURIComponent(url.username),password:decodeURIComponent(url.password),schema:process.env.E2E_CUSTOMER_SCHEMA,ssl:false});
  async function table(name:string,fields:object[]) {
    const table=await call(management+'/schema/tables','POST',{name,fields});
    const path=management+'/schema/tables/'+table.id;
    const preview=await call(path+'/preview','POST');
    await call(path+'/apply','POST',{expectedDraftRevision:1,planHash:preview.planHash});
    await call(path+'/api','PUT',{enabledOperations:['list','get','create','update','delete'],expectedAppliedRevision:1,expectedConfigRevision:0});
    return {...table,path};
  }
  const customers=await table('sdk_customers',[{name:'name',type:'text'}]);
  const orders=await table('sdk_orders',[{name:'name',type:'text'},{name:'price',type:'decimal',options:{precision:24,scale:2}},{name:'counter',type:'bigint'},{name:'owner_id',type:'uuid'},{name:'customer_id',type:'uuid',relationship:{tableId:customers.id,onDelete:'restrict'}}]);
  const generated=await call(management+'/sdk/typescript');
  expect(generated.source).toContain('Row_sdk_orders');expect(generated.source).toContain('Row_sdk_customers | null');
  expect(generated.source).not.toContain('auth: {');
  const key=(await call(management+'/api-keys','POST',{name:'SDK acceptance',scope:'read_write'})).key;
  expect(generated.source).not.toContain(key);
  const compiled=await compileSdk(generated.source);
  try {
    const client=compiled.module.createClient({baseUrl:process.env.PUBLIC_RUNTIME_ORIGIN+'/api/'+project.slug,apiKey:key});
    const customer=await client.resources.sdk_customers.create({name:'Synthetic SDK customer'});
    const order=await client.resources.sdk_orders.create({name:'Synthetic order',price:'123456789012345678.91',counter:'9007199254740993',customer_id:customer.id});
    const result=await client.resources.sdk_orders.list({filter:{price:{gte:'123456789012345678.90'},counter:{in:['9007199254740993']}},include:['customer_id'],sort:'price',limit:1});
    expect(result.data[0]._related.customer_id.name).toBe('Synthetic SDK customer');
    expect((await client.resources.sdk_orders.get(order.id)).counter).toBe('9007199254740993');
  } finally {await compiled.cleanup();}
  await page.goto('/projects/'+project.id+'/docs');
  const area=page.getByRole('region',{name:'TypeScript client'});
  await area.getByRole('button',{name:'Generate TypeScript client',exact:true}).click();
  await expect(area.getByText('Filename: '+project.slug+'-client.ts',{exact:true})).toBeVisible();
  await area.getByText('Source preview',{exact:true}).click();
  expect(await area.getByLabel('TypeScript source').innerText()).toBe(generated.source);
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await area.getByRole('button',{name:'Copy TypeScript client'}).click();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(generated.source);
  const downloadEvent=page.waitForEvent('download');
  await area.getByRole('button',{name:'Download .ts'}).click();
  const download=await downloadEvent;expect(download.suggestedFilename()).toBe(generated.filename);
  expect(await readFile((await download.path())!,'utf8')).toBe(generated.source);
  const draftFields=orders.fields.map(({position:_position,default:def,...field}:any)=>({...field,...(def?{default:def}:{})}));
  await call(orders.path+'/draft','PUT',{expectedDraftRevision:1,name:'sdk_orders',fields:[...draftFields,{name:'draft_only',type:'text'}]});
  expect((await call(management+'/sdk/typescript')).source).toBe(generated.source);
  let preview=await call(orders.path+'/preview','POST');
  await call(orders.path+'/apply','POST',{expectedDraftRevision:2,planHash:preview.planHash});
  const applied=await call(management+'/sdk/typescript');expect(applied.source).toContain('"draft_only"');expect(applied.source).not.toBe(generated.source);
  const current=await call(orders.path);
  const fields=current.fields.map(({position:_position,default:def,...field}:any)=>({...field,...(def?{default:def}:{})}));
  await call(orders.path+'/draft','PUT',{expectedDraftRevision:2,name:'sdk_orders',fields,indexes:[{fieldIds:[fields.find((f:any)=>f.name==='price').id],unique:false}]});
  preview=await call(orders.path+'/preview','POST');
  await call(orders.path+'/apply','POST',{expectedDraftRevision:3,planHash:preview.planHash});
  expect((await call(management+'/sdk/typescript')).source).toBe(applied.source);
  await call(orders.path+'/api','PUT',{enabledOperations:['list'],expectedAppliedRevision:2,expectedConfigRevision:1});
  const disabled=await call(management+'/sdk/typescript');expect(disabled.contractHash).not.toBe(applied.contractHash);
  await call(management+'/auth','PUT',{enabled:true,signupEnabled:true,sessionLifetimeSeconds:86400,expectedRevision:0});
  await call(management+'/auth/provision','POST',{expectedRevision:1});
  const withAuth=await call(management+'/sdk/typescript');expect(withAuth.source).toContain('signup: (');
  const auth=await call(management+'/auth');
  await call(management+'/auth','PUT',{enabled:true,signupEnabled:false,sessionLifetimeSeconds:86400,expectedRevision:auth.revision});
  expect((await call(management+'/sdk/typescript')).source).not.toContain('signup: (');
  await area.getByRole('button',{name:'Refresh TypeScript client'}).click();
  await expect(area.getByText(/Contract hash:/)).toBeVisible();
  await page.route('**/sdk/typescript',route=>route.fulfill({status:503,json:{code:'SDK_UNAVAILABLE',message:'Unavailable'}}),{times:1});
  await area.getByRole('button',{name:'Refresh TypeScript client'}).click();
  await expect(area.getByRole('alert')).toBeVisible();
  await expect(area.getByRole('button',{name:'Download .ts'})).toHaveCount(0);
  await expect(area.getByLabel('TypeScript source')).toHaveCount(0);
  const projects=await call('/api/management/projects');
  const other=projects.items.find((candidate:any)=>candidate.id!==project.id) ?? await call('/api/management/projects','POST',{name:'SDK switch '+suffix,slug:'sdk-switch-'+suffix});
  let release!:()=>void;
  const held=new Promise<void>((resolve)=>{release=resolve;});
  await page.route('**/sdk/typescript',async(route)=>{await held;await route.fulfill({status:200,json:generated}).catch(()=>{});},{times:1});
  await area.getByRole('button',{name:'Generate TypeScript client',exact:true}).click();
  await expect(area.getByRole('button',{name:'Generating…',exact:true})).toBeDisabled();
  await page.goto('/projects/'+other.id+'/docs');release();
  await expect(page.getByRole('region',{name:'TypeScript client'}).getByRole('button',{name:'Generate TypeScript client',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Download .ts'})).toHaveCount(0);

});
