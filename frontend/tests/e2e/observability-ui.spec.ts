import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { signupLogin, login } from './platform-account';
test('observability handles pending, pagination, safe text, refresh failure and late project responses',async({page})=>{
  if(process.env.E2E_PLATFORM_ACCOUNT_EMAIL)await login(page,process.env.E2E_PLATFORM_ACCOUNT_EMAIL);else await signupLogin(page);
  const owned=await page.evaluate(async()=>{const r=await fetch('/api/management/projects');return (await r.json()).items as {id:string;name:string}[];});
  while(owned.length<2){const suffix=randomUUID();const project=await page.evaluate(async(suffix)=>{const r=await fetch('/api/management/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'UI '+suffix,slug:'ui-'+suffix})});if(!r.ok)throw new Error('Fixture project unavailable');return r.json();},suffix);owned.push(project);}
  const first=owned[0]!.id,second=owned[1]!.id,requestId=randomUUID();
  let release=()=>{},fail=false;
  const pending=new Promise<void>((resolve)=>{release=resolve;});
  const event={id:randomUUID(),requestId,completedAt:new Date().toISOString(),eventVersion:1,routeCategory:'crud',operation:'crud.list',resource:'<script>private_marker</script>',method:'GET',status:409,errorCode:'VALUE_CONFLICT',durationMs:12.3,responseBytes:42,principalKind:'project_key'};
  const counts={recordedRequests:1,'2xx':0,'3xx':0,'4xx':1,'5xx':0};
  await page.route('**/api/management/projects/*/observability/**',async(route)=>{
    const url=new URL(route.request().url());
    if(url.pathname.includes(first))await pending;
    if(fail){await route.fulfill({status:503,json:{code:'OBSERVABILITY_UNAVAILABLE',message:'Observability is temporarily unavailable'}});return;}
    if(url.pathname.endsWith('/summary')){await route.fulfill({json:{window:url.searchParams.get('window')??'24h',asOf:new Date().toISOString(),...counts,p50DurationMs:12.3,p95DurationMs:12.3,topOperations:[],topErrorCodes:[]}});return;}
    if(url.pathname.endsWith('/requests')){await route.fulfill({json:{items:[{...event,resource:url.pathname.includes(first)?'late_old_project':event.resource}],nextCursor:url.searchParams.has('cursor')?null:'opaque-next'}});return;}
    await route.fulfill({status:404,json:{code:'NOT_FOUND',message:'Request event not found'}});
  });
  await page.goto('/projects/'+first+'/observability');await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeDisabled();await expect(page.getByRole('status').first()).toContainText('Loading');
  await page.getByRole('link',{name:'All projects',exact:true}).click();await page.getByRole('link',{name:owned[1]!.name,exact:true}).click();await page.getByRole('link',{name:'Observability',exact:true}).click();await expect(page.getByRole('heading',{name:'Recent requests',exact:true})).toBeVisible();
  const late=page.waitForResponse((response)=>response.url().includes(first+'/observability/requests'));
  release();await late;await expect(page.locator('main')).not.toContainText('late_old_project');
  await expect(page.locator('main')).toContainText('<script>private_marker</script>');await expect(page.locator('main script')).toHaveCount(0);
  await page.getByRole('table',{name:'Recent requests',exact:true}).getByRole('button',{name:'Inspect '+requestId}).click();await expect(page.getByRole('region',{name:'Request details'})).toBeVisible();
  await page.getByLabel('Time window').selectOption('1h');await expect(page.getByRole('region',{name:'Request details'})).toHaveCount(0);
  await page.getByRole('button',{name:'Next page',exact:true}).click();await expect(page.getByRole('button',{name:'Next page',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Newest requests',exact:true})).toBeEnabled();
  await page.getByLabel('Exact request ID').fill(requestId);await page.getByRole('button',{name:'Find request',exact:true}).click();await expect(page.getByText('No retained request found.')).toBeVisible();
  fail=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByRole('alert').first()).toContainText('OBSERVABILITY_UNAVAILABLE',{timeout:15000});
});
