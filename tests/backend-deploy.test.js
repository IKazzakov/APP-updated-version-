import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionDatabase,smokeBackend} from '../scripts/deploy-backend.mjs';
import worker from '../server/cloudflare.js';
import {createTestDatabase} from './server-db.js';

test('deployment reuses an existing D1 database rather than creating a replacement',async()=>{
 const calls=[],uuid=crypto.randomUUID();
 const request=async(url,options)=>{calls.push({url,method:options.method||'GET'});return new Response(JSON.stringify({success:true,result:url.endsWith('/workers/subdomain')?{subdomain:'test-account'}:[{name:'app',uuid}]}));};
 assert.deepEqual(await provisionDatabase({accountId:'account',token:'private',name:'app',request}),{databaseId:uuid,subdomain:'test-account'});
 assert.equal(calls.some(c=>c.method==='POST'),false);
});
test('first deployment provisions a database once; a lost create reply recovers it by name',async()=>{
 let created=false,posts=0;const uuid=crypto.randomUUID();
 const request=async(url,options)=>{
  let result;
  if(url.endsWith('/workers/subdomain'))result={subdomain:'test-account'};
  else if(options.method==='POST'){posts++;created=true;throw new TypeError('connection lost');}
  else result=created?[{name:'app',uuid}]:[];
  return new Response(JSON.stringify({success:true,result}));
 };
 assert.equal((await provisionDatabase({accountId:'account',token:'private',name:'app',request})).databaseId,uuid);assert.equal(posts,1);
});
test('deployment stops for ambiguous databases and missing account subdomain',async()=>{
 for(const mode of ['duplicate','subdomain']){
  const request=async url=>new Response(JSON.stringify({success:true,result:url.endsWith('/workers/subdomain')?(mode==='subdomain'?{}:{subdomain:'test-account'}):[{name:'app',uuid:crypto.randomUUID()},{name:'app',uuid:crypto.randomUUID()}]}));
  await assert.rejects(provisionDatabase({accountId:'account',token:'private',name:'app',request}),mode==='duplicate'?/Several databases/:/workers.dev/);
 }
});
test('post-deployment smoke proves JSON, auth and DB writes without adding sample profiles',async t=>{
 const DB=createTestDatabase();t.after(()=>DB.close());
 const request=(url,options)=>worker.fetch(new Request(url,options),{DB});
 const result=await smokeBackend('https://worker.test',request);assert.equal(result.guestState,true);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM profiles').get().n,0);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM device_sessions WHERE revoked_at IS NULL').get().n,0);
});
