import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/cloudflare.js';
import {createTestDatabase} from './server-db.js';
import {api,signInGuest,signOutDevice} from '../src/api.js';
import {deviceSecret} from '../src/device-auth.js';

test('client negotiates individual auth, persists before enrollment, retries safely, and revokes access on logout',async t=>{
 const DB=createTestDatabase();t.after(()=>DB.close());
 const previous={fetch:globalThis.fetch,localStorage:globalThis.localStorage};
 const data=new Map(),requests=[];let loseEnrollmentReply=true;
 globalThis.localStorage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};
 globalThis.fetch=async(path,options)=>{
  requests.push({path,headers:options.headers});
  if(path==='/api/auth/guest')assert.match(deviceSecret('/api'),/^[a-f0-9]{64}$/);
  const r=await worker.fetch(new Request('https://client.test'+path,{...options,headers:{...options.headers,...(options.method==='POST'?{Origin:'https://client.test'}:{})}}),{DB});
  if(path==='/api/auth/guest'&&loseEnrollmentReply){loseEnrollmentReply=false;throw new TypeError('Lost reply');}
  return r;
 };
 try{
  await assert.rejects(api('state'),e=>e.code==='DEVICE_AUTH_REQUIRED');
  await assert.rejects(signInGuest('Атлет'),e=>e.code==='NETWORK');
  const original=deviceSecret('/api');
  await signInGuest('Атлет');assert.equal(deviceSecret('/api'),original);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM device_sessions').get().n,1);
  await api('profile',{method:'POST',body:{displayName:'Атлет',timeZone:'UTC'}});
  assert.equal((await api('state')).profile.displayName,'Атлет');
  assert.ok(requests.filter(r=>r.path!=='/api/auth/guest'&&r.headers.Authorization).length>0);
  assert.ok(requests.every(r=>!r.headers['x-test-user-id']));
  await signOutDevice();assert.equal(deviceSecret('/api'),'');
  const revoked=await worker.fetch(new Request('https://client.test/api/state',{headers:{Authorization:`Bearer ${original}`}}),{DB});assert.equal(revoked.status,401);
  await signInGuest('Атлет');assert.notEqual(deviceSecret('/api'),original);
  assert.equal((await api('state')).profile,null);
 }finally{globalThis.fetch=previous.fetch;if(previous.localStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=previous.localStorage;}
});
