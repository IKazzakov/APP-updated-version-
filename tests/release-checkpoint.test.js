import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {captureCheckpoint} from '../scripts/release-checkpoint.mjs';

const sql=await readFile(new URL('../drizzle/0005_workouts_activity.sql',import.meta.url),'utf8');
const tables=[...sql.matchAll(/CREATE TABLE\s+(\w+)/g)].map(m=>m[1]);
const triggers=[...sql.matchAll(/CREATE TRIGGER\s+(\w+)/g)].map(m=>m[1]);
const sourceSha='a'.repeat(40),accountId='b'.repeat(32),token='PRIVATE_TOKEN';
function fixture({applied=false,bookmark=true,activation=100,profiles=5,missingGuard=false,version='2.6.1'}={}){
  const calls=[];
  const request=async(url,options={})=>{
    const path=new URL(url).pathname;calls.push({path,options});let result;
    const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    if(path==='/api/health'){assert.equal(options.headers?.Authorization,undefined);return json({ok:true,version});}
    if(path.endsWith('/workers/subdomain'))result={subdomain:'rojoscarlos93'};
    else if(path.endsWith('/d1/database'))result=[{uuid:'11111111-1111-4111-8111-111111111111',name:'movement-test-app-staging'}];
    else if(path.endsWith('/time_travel/bookmark'))result=bookmark?{bookmark:'00000000-00000000-00000000'}:{};
    else if(path.endsWith('/deployments'))result={deployments:[{id:'deployment-id',created_on:'2026-10-27',versions:[{version_id:'version-id',percentage:100}],author_email:'PRIVATE_AUTHOR'}]};
    else if(path.endsWith('/query')){
      assert.equal(options.method,'POST');const q=JSON.parse(options.body);assert.match(q.sql,/^SELECT\b/);assert.deepEqual(q.params,[]);let rows;
      if(q.sql.includes('sqlite_master'))rows=[{name:'d1_migrations',type:'table'},...(applied?tables:[]).map(name=>({name,type:'table'})),...(applied?triggers.slice(missingGuard?1:0):[]).map(name=>({name,type:'trigger'}))];
      else if(q.sql.includes('d1_migrations'))rows=[{id:1,name:applied?'0005_workouts_activity.sql':'0004_server_optimization.sql'}];
      else if(q.sql.includes('COUNT(*)'))rows=[{profiles,repetitions:25,rounds:3,competitions:2}];
      else if(q.sql.includes('activated_at'))rows=[{activated_at:activation}];
      else throw new Error('Unexpected SELECT');
      result=[{success:true,results:rows}];
    }else throw new Error('Unexpected endpoint');
    return json({success:true,result});
  };
  return {calls,request};
}
const run=(f,extra={})=>captureCheckpoint({accountId,token,sourceSha,request:f.request,...extra});
test('checkpoint selects existing canonical service, captures recovery point and performs no SQL writes',async()=>{
  const f=fixture({version:'2.5.4'}),before=await run(f);
  assert.equal(before.phase,'before');assert.equal(before.counts.profiles,5);assert.ok(before.bookmark);assert.equal(before.activatedAt,null);
  assert.equal(before.health.version,'2.5.4');
  const encoded=JSON.stringify(before);assert.equal(encoded.includes('PRIVATE_'),false);
  for(const call of f.calls){assert.equal(call.options.redirect,'error');if(call.options.method==='POST')assert.ok(call.path.endsWith('/query'));}
  const after=await run(fixture({applied:true}),{phase:'after',previous:before});
  assert.equal(after.activatedAt,100);assert.ok(after.tableNames.includes('workout_sessions'));
});
test('missing recovery bookmark stops before any database query or mutation',async()=>{
  const f=fixture({bookmark:false});await assert.rejects(run(f),/recovery bookmark/);
  assert.equal(f.calls.some(c=>c.options.method==='POST'),false);
});
test('postflight rejects missing guards, lost history, wrong source and wrong public version',async()=>{
  const previous=await run(fixture());
  for(const [options,extra,reason] of [
    [{applied:true,missingGuard:true},{},/schema\/guards/],
    [{applied:true,profiles:4},{},/counts decreased/],
    [{applied:true},{sourceSha:'c'.repeat(40)},/baseline does not match/],
    [{applied:true,version:'2.5.4'},{},/health version/],
  ])await assert.rejects(run(fixture(options),{phase:'after',previous,...extra}),reason);
});
test('already-applied migration preserves its persisted activation across release',async()=>{
  const previous=await run(fixture({applied:true,activation:90}));
  await run(fixture({applied:true,activation:90}),{phase:'after',previous});
  await assert.rejects(run(fixture({applied:true,activation:100}),{phase:'after',previous}),/activation/);
});
