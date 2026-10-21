import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi} from '../server/api.js';
import {createTestDatabase} from './server-db.js';

function fixture(t){
  const db=createTestDatabase();t.after(()=>db.close());let now=Date.parse('2026-10-20T12:00:00Z');
  const call=async(user,path,body)=>{
    const response=await handleApi(new Request(`https://test.example/api/${path}`,{method:body===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':user,origin:'https://test.example','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:db},{now:()=>now});
    return {status:response.status,data:await response.json()};
  };
  return {db,call,get now(){return now;},set now(value){now=value;}};
}

test('late delivery after confirmed completion preserves daily progress but cannot rewrite a personal record',async t=>{
  const f=fixture(t);
  await f.call('alice','profile',{displayName:'Аня',timeZone:'UTC'});
  const started=await f.call('alice','rounds/start',{requestId:crypto.randomUUID(),kind:'personal'}),round=started.data.round;
  f.now=round.startsAt+1000;
  const event={id:crypto.randomUUID(),occurredAt:round.startsAt+500,roundId:round.id,elapsedMs:500};
  await f.call('alice','repetitions',{events:[event]});
  f.now=round.endsAt;
  const finished=await f.call('alice',`rounds/${round.id}/finish`,{});
  assert.equal(finished.data.round.count,1);
  f.now+=1000;
  const delayed={id:crypto.randomUUID(),occurredAt:round.startsAt+2000,roundId:round.id,elapsedMs:2000};
  const response=await f.call('alice','repetitions',{events:[delayed]});
  assert.equal(response.status,200);
  assert.equal(response.data.state.today.count,2);
  assert.equal(response.data.state.rounds[0].count,1);
  assert.equal(response.data.state.rounds.length,1);
  const retry=await f.call('alice','repetitions',{events:[delayed]});
  assert.equal(retry.data.accepted,0);
  assert.equal(retry.data.state.today.count,2);
});

test('database failures return a fixed technical response without leaking profile, SQL, or invitation secrets',async()=>{
  const secret='private-person@example.test token=abcdef0123456789';
  const response=await handleApi(new Request('https://test.example/api/state',{headers:{'oai-authenticated-user-id':'alice'}}),{DB:{prepare(){throw new Error(`SELECT ${secret}`);}}});
  assert.equal(response.status,500);
  const report=await response.text();
  assert.doesNotMatch(report,/private-person|abcdef|SELECT|example/);
  assert.equal(JSON.parse(report).error.code,'SERVER_ERROR');
});

test('opening another tab reads an active round without consuming or aborting it',async t=>{
  const f=fixture(t);await f.call('alice','profile',{displayName:'Аня',timeZone:'UTC'});
  const started=await f.call('alice','rounds/start',{requestId:crypto.randomUUID(),kind:'personal'});
  const reads=await Promise.all([f.call('alice','state'),f.call('alice','state')]);
  assert.ok(reads.every(result=>result.data.activeRound.id===started.data.round.id));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM rounds').get().n,1);
  assert.equal((await f.call('alice','rounds/start',{requestId:crypto.randomUUID(),kind:'personal'})).data.error.code,'ACTIVE_ROUND');
});
