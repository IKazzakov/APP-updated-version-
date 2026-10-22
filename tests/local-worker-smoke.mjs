import assert from 'node:assert/strict';
const origin=process.env.WORKER_TEST_ORIGIN||'http://127.0.0.1:8788';
if(new URL(origin).hostname!=='127.0.0.1')throw new Error('This write smoke test is restricted to the isolated loopback D1.');
async function call(path,{secret,body}={}){const r=await fetch(origin+'/api/'+path,{method:body?'POST':'GET',headers:{...(secret?{Authorization:'Bearer '+secret}:{}),...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
const secrets=Array.from({length:2},()=>[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join(''));
for(const [i,secret] of secrets.entries()){await call('auth/guest',{body:{secret}});await call('v2/profile',{secret,body:{displayName:'Smoke '+i,timeZone:'UTC',rankingsEnabled:false}});}
const events=Array.from({length:100},()=>({id:crypto.randomUUID(),occurredAt:Date.now()}));
const result=await call('v2/repetitions',{secret:secrets[0],body:{events}});assert.equal(result.accepted,100);assert.equal(result.state.points,10);assert.equal(result.state.today.count,100);assert.equal(result.state.partial,true);
assert.equal((await call('v2/repetitions',{secret:secrets[0],body:{events}})).accepted,0);
assert.equal((await call('state',{secret:secrets[0]})).today.count,100);assert.equal((await call('v2/dashboard',{secret:secrets[1]})).today.count,0);
assert.equal((await call('v2/history/progress',{secret:secrets[0]})).items.length,1);
const scheduled=await fetch(origin+'/__scheduled');assert.equal(scheduled.status,200);
for(const secret of secrets)await call('auth/logout',{secret,body:{}});
console.log('Real Workers runtime + local D1: migrations, compact 100-event write, retry, old API, private profiles, paging and cron passed.');
