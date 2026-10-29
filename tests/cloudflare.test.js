import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/cloudflare.js';
import {createTestDatabase} from './server-db.js';
const origin='https://movement.test';
const secret=()=>[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
function fixture(t){
 const DB=createTestDatabase();t.after(()=>DB.close());
 const env={DB,ASSETS:{fetch:async()=>new Response('<html>app</html>',{headers:{'Content-Type':'text/html'}})}};
 const call=async(path,{token,body,headers={},method=body===undefined?'GET':'POST'}={})=>{
  const r=await worker.fetch(new Request(origin+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
  return {status:r.status,data:await r.json(),headers:r.headers};
 };
 return {env,call};
}
test('public backend returns health JSON and refuses caller-supplied Sites/test identities',async t=>{
 const {call}=fixture(t);
 const health=await call('/api/health');assert.equal(health.status,200);assert.equal(health.data.authentication,'device-token');assert.equal(health.data.storage,'d1');
 for(const headers of [{},{'x-test-user-id':'victim'},{'oai-authenticated-user-id':'victim'},{Authorization:'Bearer fake'}]){
  const r=await call('/api/state',{headers});assert.equal(r.status,401);assert.equal(r.data.error.code,'DEVICE_AUTH_REQUIRED');assert.match(r.headers.get('content-type'),/json/);
 }
});
test('device enrollment is idempotent, two identical names remain separate, tokens are stored as hashes and logout revokes re-enrollment',async t=>{
 const {call,env}=fixture(t),a=secret(),b=secret();
 const first=await call('/api/auth/guest',{body:{secret:a}}),retry=await call('/api/auth/guest',{body:{secret:a}});
 assert.equal(first.status,200);assert.equal(first.data.userId,retry.data.userId);
 const second=await call('/api/auth/guest',{body:{secret:b}});assert.notEqual(first.data.userId,second.data.userId);
 for(const token of [a,b])assert.equal((await call('/api/profile',{token,body:{displayName:'Одинаковое имя',timeZone:'UTC'}})).status,200);
 const event={id:crypto.randomUUID(),occurredAt:new Date().toISOString()};
 assert.equal((await call('/api/repetitions',{token:a,body:{events:[event]}})).status,200);
 assert.equal((await call('/api/state',{token:a,headers:{'x-test-user-id':second.data.userId,'oai-authenticated-user-id':second.data.userId}})).data.today.count,1);
 assert.equal((await call('/api/state',{token:b})).data.today.count,0);
 const stored=env.DB.sqlite.prepare('SELECT token_hash,user_id,revoked_at FROM device_sessions').all();
 assert.equal(stored.length,2);assert.ok(stored.every(r=>r.token_hash!==a&&r.token_hash!==b));
 assert.equal((await call('/api/auth/logout',{token:a,body:{}})).status,200);
 assert.equal((await call('/api/state',{token:a})).status,401);
 assert.equal((await call('/api/auth/guest',{body:{secret:a}})).data.error.code,'SESSION_REVOKED');
 assert.equal((await call('/api/state',{token:b})).status,200);
});
test('registration validates request shape, enforces origin and rate limits only new sessions',async t=>{
 const {call,env}=fixture(t),a=secret();
 assert.equal((await call('/api/auth/guest',{body:{secret:'guess'}})).status,400);
 assert.equal((await call('/api/auth/guest',{body:{secret:a,userId:'victim'}})).status,400);
 assert.equal((await call('/api/auth/guest',{body:{secret:a},headers:{Origin:'https://other.test'}})).status,403);
 assert.equal((await call('/api/auth/guest',{body:{secret:a,padding:'x'.repeat(2000)}})).status,413);
 assert.equal((await call('/api/auth/guest',{method:'GET'})).status,405);
 assert.equal((await call('/api/auth/guest',{body:{secret:a}})).status,200);
 env.AUTH_LIMITER={limit:async()=>({success:false})};
 assert.equal((await call('/api/auth/guest',{body:{secret:secret()}})).status,429);
 assert.equal((await call('/api/auth/guest',{body:{secret:a}})).status,200);
});
test('API errors never reach the HTML fallback; authenticated duels and rankings retain their API contract',async t=>{
 const {call}=fixture(t),a=secret(),b=secret();
 for(const token of [a,b]){await call('/api/auth/guest',{body:{secret:token}});await call('/api/profile',{token,body:{displayName:'Друг',timeZone:'UTC'}});}
 const invitation=secret();
 const created=await call('/api/competitions',{token:a,body:{requestId:crypto.randomUUID(),token:invitation}});
 assert.equal(created.status,200);
 assert.equal((await call('/api/invitations/accept',{token:b,body:{token:invitation}})).status,200);
 const other=await call('/api/state',{token:b});assert.equal(other.data.competitions[0].id,created.data.competition.id);
 assert.equal((await call('/api/leaderboards?type=result',{token:b})).status,200);
 const missing=await call('/api/missing',{token:a});assert.equal(missing.status,404);assert.match(missing.headers.get('content-type'),/json/);
 assert.equal((await call('/api',{token:a})).status,404);
});

test('preview OPTIONS, guest and profile retain ownership and idempotency on isolated SQLite',async t=>{
 const {call,env}=fixture(t),alias='https://preview-67f2889c80972c44.movement-preview.pages.dev',a=secret(),b=secret();
 const preview={Origin:alias};
 const preflight=await worker.fetch(new Request(origin+'/api/profile',{method:'OPTIONS',headers:{...preview,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization, Content-Type'}}),{});
 assert.equal(preflight.status,204);
 const anonymous=await call('/api/state',{headers:preview});
 assert.equal(anonymous.status,401);assert.equal(anonymous.data.error.code,'DEVICE_AUTH_REQUIRED');assert.equal(anonymous.headers.get('access-control-allow-origin'),alias);assert.match(anonymous.headers.get('vary'),/Origin/i);
 const invalid=await call('/api/auth/guest',{body:{secret:'bad'},headers:preview});
 assert.equal(invalid.status,400);assert.equal(invalid.data.error.code,'INVALID_REQUEST');assert.equal(invalid.headers.get('access-control-allow-origin'),alias);
 const first=await call('/api/auth/guest',{body:{secret:a},headers:preview});
 const second=await call('/api/auth/guest',{body:{secret:b},headers:preview});
 assert.equal(first.status,200);assert.equal(second.status,200);
 for(const token of [a,b]){
  const response=await call('/api/profile',{token,body:{displayName:'Друг',timeZone:'UTC'},headers:preview});
  assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),alias);assert.equal(response.headers.get('cache-control'),'private, no-store');
 }
 const badBody=await call('/api/profile',{token:a,body:{displayName:'Друг',timeZone:'UTC',skipOriginCheck:true},headers:preview});assert.equal(badBody.status,400);assert.equal(badBody.data.error.code,'INVALID_INPUT');
 const event={id:crypto.randomUUID(),occurredAt:new Date().toISOString()};
 const rejected=await call('/api/repetitions',{token:a,body:{events:[event]},headers:{Origin:'https://evil.test'}});
 assert.equal(rejected.status,403);assert.equal(rejected.data.error.code,'ORIGIN_FORBIDDEN');assert.equal(rejected.headers.get('access-control-allow-origin'),null);
 assert.equal((await call('/api/state',{token:a,headers:preview})).data.today.count,0);
 for(let i=0;i<2;i++)assert.equal((await call('/api/repetitions',{token:a,body:{events:[event]},headers:preview})).status,200);
 assert.equal((await call('/api/state',{token:a,headers:preview})).data.today.count,1);
 const other=await call('/api/state',{token:b,headers:{...preview,'x-test-user-id':first.data.userId,'oai-authenticated-user-id':first.data.userId}});
 assert.notEqual(first.data.userId,second.data.userId);assert.equal(other.data.today.count,0);
 const noProfile=secret();await call('/api/auth/guest',{body:{secret:noProfile},headers:preview});
 const profileRequired=await call('/api/repetitions',{token:noProfile,body:{events:[event]},headers:preview});assert.equal(profileRequired.status,409);assert.equal(profileRequired.data.error.code,'PROFILE_REQUIRED');assert.equal(profileRequired.headers.get('access-control-allow-origin'),alias);
 const missing=await call('/api/missing',{token:a,headers:preview});assert.equal(missing.status,404);assert.equal(missing.headers.get('access-control-allow-origin'),alias);
 const health=await call('/api/health',{headers:preview});assert.equal(health.status,200);assert.equal(health.headers.get('access-control-allow-origin'),alias);
 const head=await worker.fetch(new Request(origin+'/api/health',{method:'HEAD',headers:preview}),env);assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('access-control-allow-origin'),alias);
 env.AUTH_LIMITER={limit:async()=>({success:false})};
 const limited=await call('/api/auth/guest',{body:{secret:secret()},headers:preview});assert.equal(limited.status,429);assert.equal(limited.headers.get('access-control-allow-origin'),alias);
 assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,2);
});

test('preview errors are readable and foreign POST is rejected before storage or body',async()=>{
 const alias='https://preview-67f2889c80972c44.movement-preview.pages.dev';
 const request=(method,origin,path='/api/state')=>new Request('https://movement.test'+path,{method,headers:{Origin:origin}});
 const unavailable=await worker.fetch(request('GET',alias),{});assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('access-control-allow-origin'),alias);
 const original=console.error;console.error=()=>{};
 try{const failed=await worker.fetch(request('GET',alias,'/api/health'),{DB:{prepare(){throw new Error('test');}}});assert.equal(failed.status,500);assert.equal(failed.headers.get('access-control-allow-origin'),alias);}finally{console.error=original;}
 const foreign=new Request('https://movement.test/api/state',{method:'POST',headers:{Origin:'https://evil.test'},body:'unread body'});
 const forbidden=await worker.fetch(foreign,{get DB(){throw new Error('DB must not be accessed');}});
 assert.equal(forbidden.status,403);assert.equal(foreign.bodyUsed,false);assert.equal((await forbidden.json()).error.code,'ORIGIN_FORBIDDEN');
});
