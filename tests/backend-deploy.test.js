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
 const request=(url,options)=>worker.fetch(new Request(url,options),{DB});
 const result=await smokeBackend('https://worker.test',request);assert.equal(result.guestState,true);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM profiles').get().n,0);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM device_sessions WHERE revoked_at IS NULL').get().n,0);
});
