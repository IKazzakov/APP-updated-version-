import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {handleApi} from '../server/api.js';
import {approveBrowserOrigin} from '../server/browser-origin.js';
import siteWorker from '../server/worker.js';
import {createNodeServer} from '../server/node.js';
import {createTestDatabase} from './server-db.js';

const alias='https://preview-67f2889c80972c44.movement-preview.pages.dev';
const origin='https://movement.test';
const profile={displayName:'Профиль',timeZone:'UTC'};
function request({user='alice',originHeader=alias,path='/api/profile',body=profile,headers={}}={}){
 return new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(user?{'oai-authenticated-user-id':user}:{}),...(originHeader===null?{}:{Origin:originHeader}),...headers},body:JSON.stringify(body)});
}
function fixture(t){const db=createTestDatabase();t.after(()=>db.close());return db;}
async function code(response){return (await response.json()).error?.code;}

test('direct handleApi requires a request-bound approval for Pages writes',async t=>{
 const db=fixture(t),now=Date.now(),env={DB:db};
 const other=request(),proof=approveBrowserOrigin(other);
 for(const options of [undefined,{now:()=>now},{originApproval:true},{originApproval:{}},{originApproval:JSON.parse(JSON.stringify(proof))},{originApproval:proof},{skipOriginCheck:true}]){
  const response=await handleApi(request(),env,options);assert.equal(response.status,403);assert.equal(await code(response),'ORIGIN_FORBIDDEN');
 }
 const spoof=request({path:'/api/profile?originApproval=true&skipOriginCheck=true',headers:{'x-origin-approval':'true','x-skip-origin-check':'true'},body:{...profile,originApproval:true,skipOriginCheck:true}});
 assert.equal((await handleApi(spoof,env)).status,403);
 assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,0);
 const same=request({originHeader:origin});const response=await handleApi(same,env,{originApproval:true,now:()=>now});
 assert.equal(response.status,200);assert.equal((await response.json()).profile.displayName,'Профиль');
 assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,1);
});

test('real proof validates only Origin and retains identity and body guards',async t=>{
 const db=fixture(t),env={DB:db};
 const missingIdentity=request({user:null});assert.equal((await handleApi(missingIdentity,env,{originApproval:approveBrowserOrigin(missingIdentity)})).status,401);
 const malformed=request({body:{...profile,originApproval:true}});const bad=await handleApi(malformed,env,{originApproval:approveBrowserOrigin(malformed)});
 assert.equal(bad.status,400);assert.equal(await code(bad),'INVALID_INPUT');
 const noProfile=request({path:'/api/repetitions',body:{events:[{id:crypto.randomUUID(),occurredAt:new Date().toISOString()}]}});
 const denied=await handleApi(noProfile,env,{originApproval:approveBrowserOrigin(noProfile)});assert.equal(denied.status,409);assert.equal(await code(denied),'PROFILE_REQUIRED');
 assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,0);
 const approved=request();const good=await handleApi(approved,env,{originApproval:approveBrowserOrigin(approved),now:()=>Date.now()});assert.equal(good.status,200);
});

test('Sites keeps its same-origin gate without implicit browser approval',async t=>{
 const db=fixture(t),env={DB:db};
 const forbidden=await siteWorker.fetch(request({headers:{'x-origin-approval':'true','x-skip-origin-check':'true'}}),env);
 assert.equal(forbidden.status,403);assert.equal(await code(forbidden),'ORIGIN_FORBIDDEN');assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,0);
 const same=await siteWorker.fetch(request({originHeader:origin}),env);assert.equal(same.status,200);
});

test('Node adapter retains its same-origin policy',async()=>{
 const root=await mkdtemp(join(tmpdir(),'movement-origin-'));await writeFile(join(root,'index.html'),'<html>test</html>');
 let app;
 try{
  app=await createNodeServer({databasePath:join(root,'test.sqlite'),assetsDirectory:root});
  await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const secret=[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const post=(path,body,from,extra={})=>fetch(base+path,{method:'POST',headers:{Origin:from,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  assert.equal((await post('/api/auth/guest',{secret},base)).status,200);
  const auth={Authorization:`Bearer ${secret}`};
  const forbidden=await post('/api/profile?skipOriginCheck=true',profile,alias,{...auth,'x-origin-approval':'true','x-skip-origin-check':'true'});
  assert.equal(forbidden.status,403);assert.equal(await code(forbidden),'ORIGIN_FORBIDDEN');
  const before=await fetch(base+'/api/state',{headers:auth}).then(r=>r.json());assert.equal(before.profile,null);
  assert.equal((await post('/api/profile',profile,base,auth)).status,200);
 }finally{if(app)await app.close();await rm(root,{recursive:true,force:true});}
});
