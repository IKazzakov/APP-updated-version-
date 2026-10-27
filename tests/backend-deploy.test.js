import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canonicalDeployment,validateDeploymentConfig,provisionDatabase,smokeBackend} from '../scripts/deploy-backend.mjs';
import worker from '../server/cloudflare.js';
import {createTestDatabase} from './server-db.js';

const repositoryConfig=JSON.parse(await readFile(new URL('../wrangler.backend.json',import.meta.url),'utf8'));

test('the repository deploys only the canonical Worker, database and account namespace',()=>{
 assert.equal(validateDeploymentConfig(repositoryConfig,{}),canonicalDeployment);
 assert.equal(canonicalDeployment.url,'https://movement-test-api-staging.rojoscarlos93.workers.dev');
 for(const change of [
  {name:'movement-test-api'},
  {d1_databases:[{...repositoryConfig.d1_databases[0],database_name:'movement-test-app'}]},
  {d1_databases:[{...repositoryConfig.d1_databases[0],binding:'OTHER'}]},
  {d1_databases:[...repositoryConfig.d1_databases,...repositoryConfig.d1_databases]},
  {ratelimits:[{...repositoryConfig.ratelimits[0],namespace_id:'250201'}]},
 ])assert.throws(()=>validateDeploymentConfig({...repositoryConfig,...change},{}),/canonical/);
});

test('old target selectors fail rather than changing the single deployment target',()=>{
 for(const target of ['production','staging','other']){
  const config=structuredClone(repositoryConfig);
  assert.throws(()=>validateDeploymentConfig(config,{BACKEND_TARGET:target}),/BACKEND_TARGET is no longer supported/);
  assert.deepEqual(config,repositoryConfig);
 }
});

test('deployment reuses the existing canonical D1 database and never selects the old database',async()=>{
 const calls=[],uuid=crypto.randomUUID();
 const request=async(url,options)=>{calls.push({url,method:options.method||'GET'});return new Response(JSON.stringify({success:true,result:url.endsWith('/workers/subdomain')?{subdomain:canonicalDeployment.subdomain}:[{name:'movement-test-app',uuid:crypto.randomUUID()},{name:canonicalDeployment.database,uuid}]}));};
 assert.deepEqual(await provisionDatabase({accountId:'account',token:'private',request}),{databaseId:uuid,subdomain:canonicalDeployment.subdomain});
 assert.equal(calls.some(c=>c.method==='POST'),false);
});

test('a missing canonical database stops deployment without creating an empty replacement',async()=>{
 const methods=[];
 const request=async(url,options)=>{
  methods.push(options.method||'GET');
  return new Response(JSON.stringify({success:true,result:url.endsWith('/workers/subdomain')?{subdomain:canonicalDeployment.subdomain}:[{name:'movement-test-app',uuid:crypto.randomUUID()}]}));
 };
 await assert.rejects(provisionDatabase({accountId:'account',token:'private',request}),/existing canonical D1 database is missing/);
 assert.deepEqual(methods,['GET','GET']);
});

test('deployment refuses another database name before making a Cloudflare request',async()=>{
 let calls=0;
 await assert.rejects(provisionDatabase({accountId:'account',token:'private',name:'movement-test-app',request:async()=>{calls++;}}),/outside the canonical service/);
 assert.equal(calls,0);
});

test('deployment stops for ambiguous databases or an account outside the canonical hostname',async()=>{
 for(const mode of ['duplicate','missing-subdomain','wrong-account']){
  const request=async url=>new Response(JSON.stringify({success:true,result:url.endsWith('/workers/subdomain')?(mode==='missing-subdomain'?{}:{subdomain:mode==='wrong-account'?'another-account':canonicalDeployment.subdomain}):[{name:canonicalDeployment.database,uuid:crypto.randomUUID()},{name:canonicalDeployment.database,uuid:crypto.randomUUID()}]}));
  await assert.rejects(provisionDatabase({accountId:'account',token:'private',request}),mode==='duplicate'?/Several databases/:/canonical workers.dev server/);
 }
});
test('post-deployment smoke proves JSON, auth and DB writes without adding sample profiles',async t=>{
 const DB=createTestDatabase();t.after(()=>DB.close());
 const guards=[];
 const request=(url,options)=>{
  if(workoutRoutes.includes(new URL(url).pathname+new URL(url).search)){
   assert.equal(options.method,'GET');assert.equal(options.headers.Accept,'application/json');
   guards.push({path:new URL(url).pathname+new URL(url).search,authenticated:!!options.headers.Authorization});
  }
  return worker.fetch(new Request(url,options),{DB});
 };
 const result=await smokeBackend('https://worker.test',request);
 assert.deepEqual(result,{health:true,anonymousRejected:true,guestState:true,logout:true,workoutRouteGuards:true});
 assert.deepEqual(guards,workoutRoutes.flatMap(path=>[{path,authenticated:false},{path,authenticated:true}]));
 assertSmokeData(DB);
});

const workoutRoutes=['/api/v2/workouts/catalog','/api/v2/activity','/api/v2/workouts/history?limit=1'];
function assertSmokeData(DB){
 for(const table of ['profiles','workout_sessions','workout_steps','workout_events','activity_events','activity_event_parts','activity_days','activity_totals','repetition_events','daily_progress','daily_rewards','weekly_bonuses']){
  assert.equal(DB.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
 }
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM device_sessions').get().n,1);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM device_sessions WHERE revoked_at IS NULL').get().n,0);
}

test('release smoke rejects broken programme guards on every route and revokes its session',async t=>{
 for(const path of workoutRoutes)for(const authenticated of [false,true]){
  const expectedStatus=authenticated?409:401,code=authenticated?'PROFILE_REQUIRED':'DEVICE_AUTH_REQUIRED';
  const json=(data,status=expectedStatus,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'private, no-store',...headers}});
  const faults=[
   ['HTML',()=>new Response('<!doctype html><title>App</title>',{status:200,headers:{'content-type':'text/html'}})],
   ['malformed JSON',()=>new Response('{broken',{status:expectedStatus,headers:{'content-type':'application/json'}})],
   ['wrong MIME type',()=>json({error:{code}},expectedStatus,{'content-type':'text/html'})],
   ['missing MIME type',()=>{const response=json({error:{code}});response.headers.delete('content-type');return response;}],
   ['unexpected 200',()=>json({error:{code}},200)],
   ['unexpected 201',()=>json({error:{code}},201)],
   ['missing route',()=>json({error:{code:'NOT_FOUND'}},404)],
   ['server error',()=>json({error:{code:'SERVER_ERROR'}},500)],
   ['wrong guard status',()=>json({error:{code}},authenticated?401:409)],
   ['wrong error code',()=>json({error:{code:'ANOTHER_ERROR'}})],
   ['wrong JSON shape',()=>json(null)],
   ['transport failure',()=>{throw new Error('Simulated transport failure');}],
  ];
  if(authenticated)faults.push(
   ['missing cache policy',()=>json({error:{code}},409,{'cache-control':''})],
   ['public cache policy',()=>json({error:{code}},409,{'cache-control':'public, no-store'})],
   ['storable private response',()=>json({error:{code}},409,{'cache-control':'private, max-age=60'})],
  );
  for(const [name,fault] of faults)await t.test(`${path} ${authenticated?'guest':'anonymous'}: ${name}`,async t=>{
   const DB=createTestDatabase();t.after(()=>DB.close());let injected=0,logout=0;
   const request=(url,options)=>{
    const route=new URL(url).pathname+new URL(url).search;
    if(route==='/api/auth/logout')logout++;
    if(route===path&&!!options.headers.Authorization===authenticated){injected++;return fault();}
    return worker.fetch(new Request(url,options),{DB});
   };
   await assert.rejects(smokeBackend('https://worker.test',request));
   assert.equal(injected,1);assert.equal(logout,1);assertSmokeData(DB);
  });
 }
});

test('release smoke rejects an old Worker even though anonymous route auth still works',async t=>{
 const DB=createTestDatabase();t.after(()=>DB.close());const authenticated=[];
 const request=(url,options)=>{
  const route=new URL(url).pathname+new URL(url).search;
  if(workoutRoutes.includes(route)&&options.headers.Authorization){
   authenticated.push(route);
   return worker.fetch(new Request(url.replace('/api/v2/','/api/'),options),{DB});
  }
  return worker.fetch(new Request(url,options),{DB});
 };
 await assert.rejects(smokeBackend('https://worker.test',request),/Workout route/);
 assert.deepEqual(authenticated,[workoutRoutes[0]]);assertSmokeData(DB);
});
