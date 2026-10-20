import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { signupLogin, login } from './platform-account';
import { serializeRuntimeQuery, type PublicFilter } from '../../../shared/runtime-query.js';

test('advanced querying applied grammar, Playground, Docs, ownership and include acceptance', async ({ page }) => {
  if (process.env.E2E_PLATFORM_ACCOUNT_EMAIL) await login(page, process.env.E2E_PLATFORM_ACCOUNT_EMAIL);
  else await signupLogin(page);
  const call = async (path: string, method = 'GET', body?: unknown, credential?: string, expected = 200) => {
    const response = await page.evaluate(async ({ path, method, body, credential }) => {
      const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(credential ? { authorization: 'Bearer ' + credential } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    }, { path, method, body, credential });
    expect(response.status, JSON.stringify(response.body)).toBe(expected); return response.body;
  };
  const suffix = randomUUID().slice(0,8);
  const project = await call('/api/management/projects','POST',{ name:'Advanced query '+suffix,slug:'query-'+suffix },undefined,201);
  const management = '/api/management/projects/'+project.id;
  const projectPath = '/projects/'+project.id;
  const url = new URL(process.env.E2E_CUSTOMER_DATABASE_URL!);
  await call(management+'/database-connection','POST',{ label:'Disposable query acceptance',host:url.hostname,port:Number(url.port||5432),database:url.pathname.slice(1),username:decodeURIComponent(url.username),password:decodeURIComponent(url.password),schema:process.env.E2E_CUSTOMER_SCHEMA,ssl:false },undefined,201);
  async function table(name: string, fields: object[], indexed = false) {
    const table = await call(management+'/schema/tables','POST',{name,fields},undefined,201);
    const path = management+'/schema/tables/'+table.id;
    let revision = 1;
    if (indexed) {
      await call(path+'/draft','PUT',{ expectedDraftRevision:1,name,fields:table.fields.map(({ position: _position, default: def, ...field }: any) => ({ ...field, ...(def ? {default:def} : {}) })),indexes:[{ fieldIds:[table.fields.find((field: any)=>field.name==='price').id],unique:false }] });
      revision = 2;
    }
    const preview = await call(path+'/preview','POST');
    await call(path+'/apply','POST',{ expectedDraftRevision:revision,planHash:preview.planHash });
    await call(path+'/api','PUT',{enabledOperations:['list','get','create','update','delete'],expectedAppliedRevision:revision,expectedConfigRevision:0});
    return {...table,path,revision};
  }
  const supplier = await table('query_suppliers',[{name:'name',type:'text'}]);
  const products = await table('query_products',[
    {name:'name',type:'text'},{name:'price',type:'decimal',options:{precision:20,scale:2}},
    {name:'stock',type:'integer'},{name:'active',type:'boolean'}, {name:'category',type:'varchar',options:{length:100}},
    {name:'created_at',type:'timestamp'},{name:'owner_id',type:'uuid'},
    {name:'supplier_id',type:'uuid',relationship:{tableId:supplier.id,onDelete:'restrict'}},
  ],true);
  const key = (await call(management+'/api-keys','POST',{name:'Query acceptance',scope:'read_write'},undefined,201)).key;
  const runtime = '/api/runtime/'+project.slug;
  const run = async (resource: string, query = '', credential = key, method = 'GET', body?: unknown, expected = 200) => {
    // Stay below the unchanged project rate; never relax product admission.
    await new Promise((resolve)=>setTimeout(resolve,230));
    return call(runtime+'/'+resource+(query?'?'+query:''),method,body,credential,expected);
  };
  const related = await run('query_suppliers','',key,'POST',{name:'Synthetic supplier'},201);
  const records = [];
  for (let index=0;index<4;index++) records.push(await run('query_products','',key,'POST',{
    name:'Item '+index,price:String((index+1)*100),stock:index,active:index%2===0,category:index===3?null:index===0?'ACME, Inc.':'A&B',created_at:'2026-01-01T00:00:00.123456Z',supplier_id:related.id,
  },201));
  const filtered = async (filters: PublicFilter[], options: { sort?: string; direction?: string; limit?: string; offset?: string; includes?: string[] } = {}) => run('query_products',serializeRuntimeQuery({filters,...options}));
  expect((await filtered([{field:'name',operator:'legacy_eq',value:'Item 0'}])).data).toHaveLength(1);
  expect((await filtered([{field:'name',operator:'eq',value:'Item 0'}])).data).toHaveLength(1);
  expect((await filtered([{field:'name',operator:'neq',value:'Item 0'}])).data).toHaveLength(3);
  const range: PublicFilter[] = [{field:'price',operator:'gte',value:'100'},{field:'price',operator:'lte',value:'300'}];
  const first = await filtered(range,{sort:'price',direction:'desc',limit:'1'});
  expect(first.data[0].price).toBe('300.00'); expect(first.pagination.hasMore).toBe(true);
  expect((await filtered(range,{sort:'price',direction:'desc',limit:'1',offset:'1'})).data[0].price).toBe('200.00');
  expect((await filtered([{field:'active',operator:'eq',value:'false'}])).data).toHaveLength(2);
  expect((await filtered([{field:'category',operator:'in',values:['ACME, Inc.','A&B']}])).data).toHaveLength(3);
  for (const [value,count] of [['true',1],['false',3]] as const) expect((await filtered([{field:'category',operator:'is_null',value}])).data).toHaveLength(count);
  const expanded = await filtered(range,{includes:['supplier_id']}); expect(expanded.data[0]._related.supplier_id.name).toBe('Synthetic supplier');
  const invalid = await run('query_products',new URLSearchParams({'filter[price][wat]':'hidden-supplied-value'}).toString(),key,'GET',undefined,400);
  expect(invalid.code).toBe('INVALID_FILTER'); expect(JSON.stringify(invalid)).not.toContain('hidden-supplied-value'); expect(invalid.requestId).toBeTruthy();
  const six = new URLSearchParams(Object.fromEntries(['eq','neq','gt','gte','lt','lte'].map((op)=>[`filter[stock][${op}]`,'1'])));
  expect((await run('query_products',six.toString(),key,'GET',undefined,400)).code).toBe('QUERY_TOO_COMPLEX');
  await page.goto(projectPath+'/docs'); await expect(page.getByText(/maximum five clauses/).first()).toBeVisible();
  await page.getByText('Applied filter operators',{exact:true}).first().click();
  await expect(page.getByText(/IN uses one JSON array of strings/).first()).toBeVisible();
  await page.goto(projectPath+'/playground');
  const endpoint = page.getByRole('combobox',{name:'Endpoint',exact:true});
  await endpoint.selectOption((await endpoint.locator('option').filter({hasText:/^GET query_products$/}).getAttribute('value'))!);
  await page.getByRole('combobox',{name:'Credential mode',exact:true}).selectOption('key'); await page.getByLabel('Runtime credential',{exact:true}).fill(key);
  let executions = 0; page.on('request',(request)=>{if(request.url().includes('/api/runtime/')) executions++;});
  await page.getByRole('button',{name:'Add filter',exact:true}).click();
  await page.getByLabel('Field 1',{exact:true}).selectOption('price'); await page.getByLabel('Operator 1',{exact:true}).selectOption('gte'); await page.getByLabel('Value 1',{exact:true}).fill('200');
  await page.getByRole('checkbox',{name:'supplier_id',exact:true}).check();
  await page.getByLabel('Sort field',{exact:true}).fill('price'); await page.getByRole('combobox',{name:'Direction',exact:true}).selectOption('desc');
  await page.getByRole('button',{name:'Add filter',exact:true}).click();
  await page.getByLabel('Field 2',{exact:true}).selectOption('price'); await page.getByLabel('Operator 2',{exact:true}).selectOption('lte'); await page.getByLabel('Value 2',{exact:true}).fill('500');
  expect(executions).toBe(0);
  let releaseRequest!: () => void;
  const held = new Promise<void>((resolve)=>{releaseRequest=resolve;});
  await page.route('**/api/runtime/**',async(route)=>{await held;await route.continue();},{times:1});
  const requested = page.waitForRequest((request)=>request.url().includes('/api/runtime/')&&request.method()==='GET');
  await page.getByRole('button',{name:'Send request',exact:true}).click();
  await expect(page.getByLabel('Field 1',{exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Add filter',exact:true})).toBeDisabled();
  releaseRequest();
  const sent = new URL((await requested).url()); expect(sent.searchParams.get('filter[price][gte]')).toBe('200'); expect(sent.searchParams.get('filter[price][lte]')).toBe('500'); expect(sent.searchParams.get('include')).toBe('supplier_id');
  await expect(page.getByTestId('response-status')).toHaveText('HTTP 200');
  const result = JSON.parse(await page.getByTestId('response-body').innerText()); expect(result.data[0].price).toBe('400.00'); expect(result.data[0]._related.supplier_id.id).toBe(related.id);
  await page.getByRole('button',{name:'Remove filter 2',exact:true}).click();
  const beforeEdit = executions;
  await page.getByLabel('Field 1',{exact:true}).selectOption('category'); await page.getByLabel('Operator 1',{exact:true}).selectOption('in');
  await page.getByLabel('Filter 1 value 1',{exact:true}).fill('ACME, Inc.'); await page.getByRole('button',{name:'Add IN value',exact:true}).click(); await page.getByLabel('Filter 1 value 2',{exact:true}).fill('A&B');
  for (let index=2;index<25;index++) await page.getByRole('button',{name:'Add IN value',exact:true}).click();
  await expect(page.getByRole('button',{name:'Add IN value',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Remove filter 1 value 25',exact:true}).click();
  await expect(page.getByRole('button',{name:'Add IN value',exact:true})).toBeEnabled();
  expect(executions).toBe(beforeEdit);
  await expect(page.getByTestId('response-status')).toHaveCount(0);
  await page.getByRole('button',{name:'Send request',exact:true}).click(); await expect(page.getByTestId('response-status')).toHaveText('HTTP 200');
  const inResult = JSON.parse(await page.getByTestId('response-body').innerText());
  expect(inResult.data).toHaveLength(3); expect(inResult.data[0]._related.supplier_id.id).toBe(related.id);
  await page.getByLabel('Operator 1',{exact:true}).selectOption('is_null'); await expect(page.getByLabel('NULL selection 1',{exact:true})).toBeVisible();
  await page.getByLabel('NULL selection 1',{exact:true}).selectOption('true'); await page.getByRole('button',{name:'Send request',exact:true}).click(); await expect(page.getByTestId('response-status')).toHaveText('HTTP 200');
  expect(JSON.parse(await page.getByTestId('response-body').innerText()).data).toHaveLength(1);
  for(let index=0;index<4;index++) await page.getByRole('button',{name:'Add filter',exact:true}).click();
  await expect(page.getByRole('button',{name:'Add filter',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Remove filter 5',exact:true}).click(); await expect(page.getByRole('button',{name:'Add filter',exact:true})).toBeEnabled();
  await endpoint.selectOption((await endpoint.locator('option').filter({hasText:/^GET query_suppliers$/}).getAttribute('value'))!);
  await expect(page.getByLabel('Field 1',{exact:true})).toHaveCount(0);
  // Owner filtering remains additive under real application sessions.
  await call(management+'/auth','PUT',{enabled:true,signupEnabled:true,expectedRevision:0}); await call(management+'/auth/provision','POST',{expectedRevision:1});
  const tokens = [];
  for (const who of ['alice','bob']) {
    const body = {email:who+'@example.test',password:'query-acceptance-password'};
    await run('auth/signup','',undefined,'POST',body,201); tokens.push(await run('auth/login','',undefined,'POST',body));
  }
  const ownerFieldId = products.fields.find((field: any)=>field.name==='owner_id').id;
  const policy = {mode:'owner',ownerFieldId,allowAdmin:false};
  await call(products.path+'/api','PUT',{enabledOperations:['list','get','create','update','delete'],expectedAppliedRevision:products.revision,expectedConfigRevision:1,policies:{list:policy,get:policy,create:policy,update:policy,delete:policy}});
  for (const token of tokens) await run('query_products','',token.token,'POST',{name:'Owned',price:'500'},201);
  const denied = await run('query_products',serializeRuntimeQuery({filters:[{field:'owner_id',operator:'neq',value:tokens[0].user.id}]}),tokens[0].token);
  expect(denied.data).toEqual([]);
  expect((await run('query_products',serializeRuntimeQuery({filters:[{field:'price',operator:'gte',value:'0'}]}),tokens[0].token)).data).toHaveLength(1);
  // Existing key-only fixture CRUD remains healthy independently of ownership policy.
  await run('query_suppliers/'+related.id,'',key,'PATCH',{name:'Updated supplier'});
  expect((await run('query_suppliers/'+related.id)).name).toBe('Updated supplier');
  expect(records).toHaveLength(4);
});
