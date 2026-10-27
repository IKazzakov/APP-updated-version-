import test from 'node:test';
import assert from 'node:assert/strict';
import {checkWorkoutApi} from '../scripts/check-workout-api.mjs';
import worker from '../server/cloudflare.js';
import {createTestDatabase} from './server-db.js';

const apiBase='https://test.example/api',secret='a'.repeat(64);
async function fixture(t,profile=true){
 const DB=createTestDatabase();t.after(()=>DB.close());
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret))).toString('hex');
 DB.sqlite.prepare('INSERT INTO device_sessions VALUES(?,?,?,NULL)').run(hash,'checker',Date.now());
 if(profile)await worker.fetch(new Request(apiBase+'/profile',{method:'POST',headers:{Authorization:'Bearer '+secret,Origin:'https://test.example','Content-Type':'application/json'},body:JSON.stringify({displayName:'PRIVATE_NAME',timeZone:'UTC'})}),{DB});
 const request=(url,options)=>worker.fetch(new Request(url,options),{DB});return {DB,request};
}
test('checker validates real authenticated GETs without any DB changes or identity output',async t=>{
 const {DB,request}=await fixture(t);const before=DB.sqlite.prepare('SELECT total_changes() n').get().n;const methods=[];
 const report=await checkWorkoutApi({apiBase,secret,request:(url,options)=>{methods.push(options.method);assert.equal(options.redirect,'error');return request(url,options);}});
 assert.equal(report.ready,true);assert.deepEqual(methods,['GET','GET','GET','GET']);
 assert.equal(DB.sqlite.prepare('SELECT total_changes() n').get().n,before);
 for(const privateValue of [secret,'PRIVATE_NAME','checker','totalXp','programs','items'])assert.equal(JSON.stringify(report).includes(privateValue),false);
});
test('missing credential is explicitly not checked; real 401 and missing profile are distinct',async t=>{
 const {request}=await fixture(t,false);
 const missing=await checkWorkoutApi({apiBase,request});assert.equal(missing.ready,false);assert.equal(missing.authChecked,false);assert.equal(missing.checks[1].code,'AUTH_NOT_CHECKED');
 const guest=await checkWorkoutApi({apiBase,secret,request});assert.equal(guest.checks[1].code,'PROFILE_REQUIRED');assert.equal(guest.ready,false);
 const unknown=await checkWorkoutApi({apiBase,secret:'b'.repeat(64),request});assert.equal(unknown.checks[1].code,'DEVICE_AUTH_REQUIRED');
});
test('every route rejects missing route, malformed JSON/MIME/schema, network and redirects safely',async t=>{
 const {request}=await fixture(t);
 for(const route of ['health','v2/workouts/catalog','v2/activity','v2/workouts/history?limit=1'])for(const fault of ['404','json','mime','shape','network','redirect','private-error']){
  const report=await checkWorkoutApi({apiBase,secret,request:(url,options)=>{
   if(url!==apiBase+'/'+route)return request(url,options);
   if(fault==='network'||fault==='redirect')throw new Error(secret+' PRIVATE_NAME');
   if(fault==='404')return Response.json({error:{code:'NOT_FOUND'}},{status:404});
   if(fault==='private-error')return Response.json({error:{code:secret,message:'PRIVATE_NAME'}},{status:500});
   if(fault==='json')return new Response('<html>',{headers:{'content-type':'application/json'}});
   if(fault==='mime')return new Response('{}',{headers:{'content-type':'text/html'}});
   return Response.json({});
  }});
  assert.equal(report.ready,false,route+' '+fault);assert.equal(report.checks.find(c=>c.route===route).valid,false);
  assert.equal(JSON.stringify(report).includes(secret),false);assert.equal(JSON.stringify(report).includes('PRIVATE_NAME'),false);
  if(fault==='404')assert.equal(report.checks.find(c=>c.route===route).code,'NOT_FOUND');
 }
});
test('unsafe destinations and malformed credentials fail before sending',async()=>{
 for(const apiBase of ['http://test.example/api','https://u:p@test.example/api','https://test.example/api?secret=x','https://test.example/api#x'])await assert.rejects(checkWorkoutApi({apiBase,secret,request:()=>assert.fail('request')}));
 await assert.rejects(checkWorkoutApi({apiBase,secret:'unsafe',request:()=>assert.fail('request')}));
});
