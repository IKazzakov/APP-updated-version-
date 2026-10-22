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
