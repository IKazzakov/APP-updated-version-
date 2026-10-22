import test from 'node:test';
import assert from 'node:assert/strict';
import {handleApi,localDate} from '../server/api.js';
import {ROUND_MS,DELIVERY_GRACE_MS,COMPETITION_MS} from '../server/rules.js';
import {createTestDatabase} from './server-db.js';
const id=()=>crypto.randomUUID();
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
function fixture(t) {
  const db=createTestDatabase(); t.after(()=>db.close()); let now=Date.parse('2026-10-20T12:00:00Z');
  const api=async(user,path,body,extra={})=>{
    const headers={'oai-authenticated-user-id':user,'content-type':'application/json','origin':'https://test.example',...extra};
    if (!user) delete headers['oai-authenticated-user-id'];
    const response=await handleApi(new Request(`https://test.example/api${path}`,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:db},{now:()=>now});
    return {status:response.status,body:await response.json()};
  };
  const profile=(user,name=user,timeZone='UTC')=>api(user,'/profile',{displayName:name,timeZone});
  const events=(n,round=null)=>Array.from({length:n},(_,i)=>({id:id(),occurredAt:round ? round.startsAt+i*700 : now,...(round?{roundId:round.id,elapsedMs:i*700}:{})}));
  const start=async(user,competitionId)=>{
    const response=await api(user,'/rounds/start',{requestId:id(),kind:competitionId?'competition':'personal',...(competitionId?{competitionId}:{})});
    assert.equal(response.status,200,JSON.stringify(response.body));return response.body.round;
  };
  const complete=async(user,round,count)=>{
    now=round.startsAt+Math.max(count*700,1000);
    if (count) assert.equal((await api(user,'/repetitions',{events:events(count,round)})).status,200);
    now=round.endsAt;
    const response=await api(user,`/rounds/${round.id}/finish`,{});
    assert.equal(response.status,200,JSON.stringify(response.body));return response.body;
  };
  const competition=async()=>{
    await profile('alice','Аня');await profile('bob','Борис');await profile('charlie','Вера');
    const invitationToken=token();const created=await api('alice','/competitions',{requestId:id(),token:invitationToken});assert.equal(created.status,200);
    return {competition:created.body.competition,token:invitationToken};
  };
  return {db,api,profile,events,start,complete,competition,get now(){return now;},set now(value){now=value;}};
}

test('authentication, same-origin writes and private history are enforced',async t=>{
  const f=fixture(t);assert.equal((await f.api(null,'/state')).status,401);
  assert.equal((await f.api('alice','/profile',{displayName:'Аня',timeZone:'UTC'},{origin:'https://evil.example'})).status,403);
  await f.profile('alice');await f.profile('bob');
  const round=await f.start('alice');await f.complete('alice',round,3);
  const bob=await f.api('bob','/state');assert.equal(bob.body.rounds.length,0);assert.equal(bob.body.today.count,0);
  assert.equal((await f.api('bob',`/rounds/${round.id}/abort`,{})).status,404);
  assert.equal((await f.api('bob',`/rounds/${round.id}/finish`,{})).status,404);
  assert.equal((await f.api('bob','/repetitions',{events:f.events(1,round)})).status,404);
});
test('ten reps award exactly ten points atomically; extra reps and duplicates do not award again',async t=>{
  const f=fixture(t);await f.profile('alice');const batch=f.events(10);
  const first=await f.api('alice','/repetitions',{events:batch});assert.equal(first.body.accepted,10);assert.equal(first.body.state.points,10);assert.equal(first.body.state.today.count,10);
  const repeat=await f.api('alice','/repetitions',{events:batch});assert.equal(repeat.body.duplicate,10);assert.equal(repeat.body.state.today.count,10);
  const extra=await f.api('alice','/repetitions',{events:f.events(5)});assert.equal(extra.body.state.points,10);assert.equal(extra.body.state.today.count,15);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM daily_rewards').get().n,1);
});
test('two tabs send overlapping events concurrently without duplicate reps or rewards',async t=>{
  const f=fixture(t);await f.profile('alice');const batch=f.events(10);
  const responses=await Promise.all([f.api('alice','/repetitions',{events:batch}),f.api('alice','/repetitions',{events:[...batch,...f.events(10)]})]);
  assert.ok(responses.every(response=>response.status===200));
  const state=(await f.api('alice','/state')).body;assert.equal(state.today.count,20);assert.equal(state.points,10);
});
test('profile timezone survives device change and controls midnight, seven-day calendar and retained points',async t=>{
  const f=fixture(t);f.now=Date.parse('2026-10-21T00:30:00Z');await f.profile('alice','Аня','America/Los_Angeles');
  let state=(await f.api('alice','/repetitions',{events:f.events(10)})).body.state;assert.equal(state.today.date,'2026-10-20');assert.equal(state.points,10);
  await f.profile('alice','Аня','Asia/Tokyo');assert.equal((await f.api('alice','/state')).body.profile.timeZone,'America/Los_Angeles');
  f.now+=24*60*60*1000;state=(await f.api('alice','/repetitions',{events:f.events(10)})).body.state;assert.equal(state.points,20);assert.equal(state.last7,2);
  f.now+=8*24*60*60*1000;state=(await f.api('alice','/state')).body;assert.equal(state.points,20);assert.equal(state.last7,0);
  assert.equal(localDate(Date.parse('2026-03-08T10:00:00Z'),'America/Los_Angeles'),'2026-03-08');
});
test('failed event batch rolls back all progress; outbox retry is safe',async t=>{
  const f=fixture(t);await f.profile('alice');const batch=f.events(10);batch[9].id='invalid';
  assert.equal((await f.api('alice','/repetitions',{events:batch})).status,400);assert.equal((await f.api('alice','/state')).body.today.count,0);
  batch[9].id=id();assert.equal((await f.api('alice','/repetitions',{events:batch})).body.state.points,10);
});
test('SQLite transaction rolls back triggered progress and reward when a later write fails',async t=>{
  const f=fixture(t);await f.profile('alice');await f.api('alice','/repetitions',{events:f.events(9)});
  const insert='INSERT INTO repetition_events(user_id,id,occurred_at,local_date,round_id,elapsed_ms,round_eligible,received_at) VALUES(?,?,?,?,?,?,?,?)';
  await assert.rejects(f.db.batch([
    f.db.prepare(insert).bind('alice',id(),f.now,'2026-10-20',null,null,0,f.now),
    f.db.prepare(insert).bind('alice',id(),f.now,'2026-10-20',id(),10,0,f.now),
  ]));
  const state=(await f.api('alice','/state')).body;
  assert.equal(state.today.count,9);assert.equal(state.points,0);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM repetition_events').get().n,9);
});
test('new profile timezone is validated and unknown coordinate fields cannot be uploaded',async t=>{
  const f=fixture(t);assert.equal((await f.profile('alice','Аня','Not/AZone')).status,400);await f.profile('alice');
  const event=f.events(1)[0];event.landmarks=[{x:1,y:1}];assert.equal((await f.api('alice','/repetitions',{events:[event]})).status,400);
});
test('personal round is not complete early, rejects boundary and late repetitions, then records exactly once',async t=>{
  const f=fixture(t);await f.profile('alice');const round=await f.start('alice');
  assert.equal((await f.api('alice',`/rounds/${round.id}/finish`,{})).body.error.code,'ROUND_RUNNING');
  const late={id:id(),occurredAt:round.endsAt,roundId:round.id,elapsedMs:60000};f.now=round.endsAt;
  assert.equal((await f.api('alice','/repetitions',{events:[late]})).body.error.code,'INVALID_ROUND_TIME');
  f.now=round.startsAt;const result=await f.complete('alice',round,7);assert.equal(result.round.count,7);assert.equal(result.state.rounds.length,1);
  const repeat=await f.api('alice',`/rounds/${round.id}/finish`,{});assert.equal(repeat.body.state.rounds.length,1);assert.equal(repeat.body.round.count,7);
});
test('start retries are idempotent and concurrent tabs cannot launch parallel personal rounds',async t=>{
  const f=fixture(t);await f.profile('alice');const requestId=id();
  const responses=await Promise.all([f.api('alice','/rounds/start',{requestId,kind:'personal'}),f.api('alice','/rounds/start',{requestId,kind:'personal'})]);
  assert.equal(responses[0].body.round.id,responses[1].body.round.id);
  assert.equal((await f.api('alice','/rounds/start',{requestId:id(),kind:'personal'})).body.error.code,'ACTIVE_ROUND');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM rounds').get().n,1);
});
test('abort retains earned daily reps while excluding round from comparisons and records',async t=>{
  const f=fixture(t);await f.profile('alice');const round=await f.start('alice');f.now=round.startsAt+10_000;
  const earned=f.events(10,round);await f.api('alice',`/rounds/${round.id}/abort`,{});
  const state=(await f.api('alice','/repetitions',{events:earned})).body.state;
  assert.equal(state.today.count,10);assert.equal(state.points,10);assert.equal(state.rounds.length,0);
  assert.equal((await f.api('alice',`/rounds/${round.id}/finish`,{})).body.error.code,'ROUND_INTERRUPTED');
});
test('refresh-aborted attempt and stale server timeout never fabricate a completed result',async t=>{
  const f=fixture(t);await f.profile('alice');const round=await f.start('alice');
  assert.equal((await f.api('alice','/state')).body.activeRound.id,round.id);
  f.now=round.endsAt+DELIVERY_GRACE_MS+1;
  const state=(await f.api('alice','/state')).body;assert.equal(state.activeRound,null);assert.equal(state.rounds.length,0);
  assert.equal((await f.api('alice',`/rounds/${round.id}/finish`,{})).status,409);
});
test('invitation creator cannot self-accept; two competing recipients can occupy only one place',async t=>{
  const f=fixture(t),invitation=await f.competition();
  assert.equal((await f.api('alice','/invitations/accept',{token:invitation.token})).body.error.code,'SELF_INVITATION');
  const outcomes=await Promise.all([f.api('bob','/invitations/accept',{token:invitation.token}),f.api('charlie','/invitations/accept',{token:invitation.token})]);
  assert.equal(outcomes.filter(value=>value.status===200).length,1);assert.equal(outcomes.filter(value=>value.body.error?.code==='INVITATION_TAKEN').length,1);
  const originalExpiry=f.now+COMPETITION_MS;f.now+=5000;
  const user=outcomes[0].status===200?'bob':'charlie';const accepted=await f.api(user,'/invitations/accept',{token:invitation.token});assert.equal(accepted.status,200);
  assert.equal(accepted.body.competition.expiresAt,originalExpiry);
});
test('invitation preview discloses only necessary data; token stored only as hash, creation retry safe',async t=>{
  const f=fixture(t);await f.profile('alice','Аня');await f.profile('bob','Борис');const requestId=id(),secret=token();
  const first=await f.api('alice','/competitions',{requestId,token:secret}),again=await f.api('alice','/competitions',{requestId,token:secret});
  assert.equal(first.body.competition.id,again.body.competition.id);
  const preview=(await f.api('bob','/invitations/preview',{token:secret})).body;
  assert.deepEqual(Object.keys(preview).sort(),['canAccept','competitionId','creatorName','rulesVersion','status']);
  assert.equal(preview.creatorName,'Аня');assert.equal((await f.api('bob','/state')).body.competitions.length,0);
  const stored=f.db.sqlite.prepare('SELECT token_hash FROM competitions').get();assert.notEqual(stored.token_hash,secret);
  assert.equal((await f.api('alice','/competitions',{requestId,token:token()})).body.error.code,'REQUEST_REUSED');
});
test('competition attempts unavailable until acceptance; nonparticipants cannot start',async t=>{
  const f=fixture(t),invitation=await f.competition();
  const request=()=>({requestId:id(),kind:'competition',competitionId:invitation.competition.id});
  assert.equal((await f.api('alice','/rounds/start',request())).body.error.code,'INVITATION_PENDING');
  await f.api('bob','/invitations/accept',{token:invitation.token});
  assert.equal((await f.api('charlie','/rounds/start',request())).status,404);
});
test('three consumed attempts, including interrupted attempts; duplicate start consumes one only',async t=>{
  const f=fixture(t),invitation=await f.competition();await f.api('bob','/invitations/accept',{token:invitation.token});const competitionId=invitation.competition.id;
  const firstRequest={requestId:id(),kind:'competition',competitionId};let response=await f.api('alice','/rounds/start',firstRequest);const first=response.body.round;
  response=await f.api('alice','/rounds/start',firstRequest);assert.equal(response.body.round.id,first.id);
  assert.equal((await f.api('alice','/rounds/start',{requestId:id(),kind:'personal'})).body.error.code,'ACTIVE_ROUND');
  await f.api('alice',`/rounds/${first.id}/abort`,{});
  const second=await f.start('alice',competitionId);await f.complete('alice',second,4);
  const third=await f.start('alice',competitionId);await f.api('alice',`/rounds/${third.id}/abort`,{});
  assert.equal((await f.api('alice','/rounds/start',{requestId:id(),kind:'competition',competitionId})).body.error.code,'ATTEMPTS_EXHAUSTED');
  const state=(await f.api('alice','/state')).body,me=state.competitions[0].participants.find(value=>value.isYou);assert.equal(me.attemptsUsed,3);assert.equal(me.best,4);assert.equal(state.rounds.length,1);
});
for(const compact of [false,true])test(`${compact?'v2':'legacy'}: early competition stops retain each participants best score without creating minute records`,async t=>{
  const f=fixture(t),invitation=await f.competition(),competitionId=invitation.competition.id;
  await f.api('bob','/invitations/accept',{token:invitation.token});
  const base=compact?'/v2':'',call=(user,path,body)=>f.api(user,base+path,body);
  const competition=async user=>compact?(await call(user,'/competitions')).body.items[0]:(await call(user,'/state')).body.competitions[0];
  const stop=async(user,count)=>{
    const started=await call(user,'/rounds/start',{requestId:id(),kind:'competition',competitionId});
    assert.equal(started.status,200);const round=started.body.round;f.now=round.startsAt+10_000;
    if(count)assert.equal((await call(user,'/repetitions',{events:f.events(count,round)})).status,200);
    const ended=await call(user,`/rounds/${round.id}/abort`,{});assert.equal(ended.status,200);
    assert.equal(ended.body.round.status,'aborted');assert.equal(ended.body.round.count,count);
    assert.ok(ended.body.round.finishedAt<round.endsAt);
    const repeat=await call(user,`/rounds/${round.id}/abort`,{});assert.equal(repeat.body.round.count,count);
    return round;
  };
  const first=await stop('alice',10);await stop('bob',12);
  let duel=await competition('alice');
  assert.deepEqual(duel.participants.map(p=>p.best),[10,12]);
  assert.ok(duel.participants.every(p=>p.attemptsUsed===1&&p.attemptsLeft===2&&!p.activeAttempt));
  assert.equal(duel.status,'active');
  assert.equal((await f.api('alice','/state')).body.today.count,10);
  assert.equal((await f.api('bob','/state')).body.today.count,12);
  assert.equal((await f.api('alice','/state')).body.points,10);
  assert.equal((await call('bob',`/rounds/${first.id}/abort`,{})).status,404);
  for(const user of ['alice','bob']){
    const dashboard=(await f.api(user,'/v2/dashboard')).body;
    assert.equal(dashboard.rounds.length,0);assert.equal(dashboard.stats.record,null);
    assert.equal((await f.api(user,'/v2/history/rounds')).body.items.length,0);
  }
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_best').get().n,0);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM daily_rewards').get().n,2);
  await stop('alice',4);await stop('alice',0);await stop('bob',3);await stop('bob',0);
  duel=await competition('alice');
  assert.deepEqual(duel.participants.map(p=>p.best),[10,12]);
  assert.ok(duel.participants.every(p=>p.attemptsUsed===3&&p.attemptsLeft===0));
  assert.equal(duel.status,'finished');assert.deepEqual(duel.result,{type:'winner',winner:'opponent'});
  assert.deepEqual((await competition('bob')).participants.map(p=>p.best),[10,12]);
  assert.equal((await call('alice','/rounds/start',{requestId:id(),kind:'competition',competitionId})).body.error.code,'ATTEMPTS_EXHAUSTED');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_best').get().n,0);
});
test('early competition results respect rules, ignore empty stops, and can tie a completed minute',async t=>{
  const f=fixture(t),invitation=await f.competition(),competitionId=invitation.competition.id;
  await f.api('bob','/invitations/accept',{token:invitation.token});
  let round=await f.start('alice',competitionId);f.now+=5000;
  await f.api('alice','/repetitions',{events:f.events(5,round)});await f.api('alice',`/rounds/${round.id}/abort`,{});
  f.db.sqlite.prepare('UPDATE rounds SET rules_version=? WHERE id=?').run('squat-old',round.id);
  assert.equal((await f.api('alice','/state')).body.competitions[0].participants[0].best,null);
  f.db.sqlite.prepare('UPDATE rounds SET rules_version=? WHERE id=?').run('squat-v1',round.id);
  round=await f.start('bob',competitionId);await f.complete('bob',round,5);
  round=await f.start('charlie');await f.api('charlie',`/rounds/${round.id}/abort`,{});
  f.now+=COMPETITION_MS;
  const state=(await f.api('alice','/state')).body;
  assert.deepEqual(state.competitions[0].result,{type:'tie',winner:null});
  assert.equal(state.rounds.length,0);
  assert.equal((await f.api('bob','/state')).body.rounds.length,1);
});
test('less than sixty seconds remaining prevents a new attempt and expiry without results is not held',async t=>{
  const f=fixture(t),invitation=await f.competition();const accepted=await f.api('bob','/invitations/accept',{token:invitation.token});
  f.now=accepted.body.competition.expiresAt-ROUND_MS+1;
  assert.equal((await f.api('alice','/rounds/start',{requestId:id(),kind:'competition',competitionId:invitation.competition.id})).body.error.code,'COMPETITION_CLOSING');
  f.now+=ROUND_MS;const state=(await f.api('alice','/state')).body;assert.equal(state.competitions[0].status,'finished');assert.equal(state.competitions[0].result.type,'not_held');
});
test('best completed scores decide winner and count once in personal history; incomplete opponent means not held',async t=>{
  const f=fixture(t),invitation=await f.competition();const accepted=await f.api('bob','/invitations/accept',{token:invitation.token}),competitionId=invitation.competition.id;
  let round=await f.start('alice',competitionId);await f.complete('alice',round,5);
  f.now=accepted.body.competition.expiresAt;let state=(await f.api('alice','/state')).body;assert.equal(state.competitions[0].result.type,'not_held');assert.equal(state.rounds.length,1);
  // Separate competition, no edits to real result data.
  const otherToken=token();const other=(await f.api('alice','/competitions',{requestId:id(),token:otherToken})).body.competition;await f.api('bob','/invitations/accept',{token:otherToken});
  round=await f.start('alice',other.id);await f.complete('alice',round,7);round=await f.start('bob',other.id);await f.complete('bob',round,4);
  f.now+=COMPETITION_MS;state=(await f.api('alice','/state')).body;const final=state.competitions.find(value=>value.id===other.id);assert.equal(final.result.type,'winner');assert.equal(final.result.winner,'creator');assert.equal(state.rounds.length,2);
});
test('tie after all six attempts exhausted; empty interrupted attempts do not change the best score',async t=>{
  const f=fixture(t),invitation=await f.competition();await f.api('bob','/invitations/accept',{token:invitation.token});
  for (const user of ['alice','bob']) {
    let round=await f.start(user,invitation.competition.id);await f.complete(user,round,6);
    for(let i=0;i<2;i++){round=await f.start(user,invitation.competition.id);await f.api(user,`/rounds/${round.id}/abort`,{});}
  }
  const state=(await f.api('alice','/state')).body;assert.equal(state.competitions[0].status,'finished');assert.equal(state.competitions[0].result.type,'tie');assert.equal(state.rounds.length,1);
});
test('incompatible rules cannot start or compare competition scores',async t=>{
  const f=fixture(t),invitation=await f.competition();await f.api('bob','/invitations/accept',{token:invitation.token});
  f.db.sqlite.prepare('UPDATE competitions SET rules_version=? WHERE id=?').run('squat-old',invitation.competition.id);
  assert.equal((await f.api('alice','/rounds/start',{requestId:id(),kind:'competition',competitionId:invitation.competition.id})).body.error.code,'INCOMPATIBLE_RULES');
  assert.equal((await f.api('alice','/state')).body.competitions[0].canStart,false);
});
test('expired round delivery grace is preliminary, then abandoned attempts finalize without false completion',async t=>{
  const f=fixture(t),invitation=await f.competition();const accepted=await f.api('bob','/invitations/accept',{token:invitation.token});f.now=accepted.body.competition.expiresAt-ROUND_MS;
  const round=await f.start('alice',invitation.competition.id);f.now=round.endsAt;
  let state=(await f.api('alice','/state')).body;assert.equal(state.competitions[0].status,'settling');assert.equal(state.competitions[0].preliminary,true);
  f.now+=DELIVERY_GRACE_MS+1;state=(await f.api('alice','/state')).body;assert.equal(state.competitions[0].status,'finished');assert.equal(state.competitions[0].result.type,'not_held');assert.equal(state.rounds.length,0);
});
test('repetition timestamps are bounded and earlier day outbox uses saved profile timezone',async t=>{
  const f=fixture(t);await f.profile('alice','Аня','Pacific/Auckland');const event=f.events(1)[0];event.occurredAt=new Date(f.now-86400000).toISOString();
  const response=await f.api('alice','/repetitions',{events:[event]});assert.equal(response.status,200);assert.equal(response.body.state.today.count,0);assert.equal(response.body.state.days[0].count,1);
  event.id=id();event.occurredAt=f.now+5001;assert.equal((await f.api('alice','/repetitions',{events:[event]})).body.error.code,'INVALID_EVENT_TIME');
});
test('start timestamps are refreshed after validation and response reports processing separately',async t=>{
 const f=fixture(t);await f.profile('alice');let calls=0;
 const response=await handleApi(new Request('https://test.example/api/rounds/start',{method:'POST',headers:{'oai-authenticated-user-id':'alice','content-type':'application/json',origin:'https://test.example'},body:JSON.stringify({requestId:id(),kind:'personal'})}),{DB:f.db},{now:()=>f.now+100*calls++});
 const result=await response.json();assert.equal(response.status,200);assert.equal(result.round.startsAt,f.now+100);assert.equal(result.round.endsAt-result.round.startsAt,60000);assert.equal(result.serverNow,f.now+200);assert.equal(result.processingMs,200);
});

test('creator can cancel an unaccepted invitation idempotently; old links and attempts cannot reactivate it',async t=>{
  const f=fixture(t),inv=await f.competition(),path=`/competitions/${inv.competition.id}/cancel`;
  assert.equal(inv.competition.canCancel,true);assert.equal((await f.api('bob',path,{})).status,404);
  const cancelled=await Promise.all([f.api('alice',path,{}),f.api('alice',path,{})]);
  assert.ok(cancelled.every(r=>r.status===200&&r.body.competition.status==='cancelled'&&!r.body.competition.canCancel&&!r.body.competition.canStart));
  const saved=f.db.sqlite.prepare('SELECT * FROM competitions WHERE id=?').get(inv.competition.id);assert.equal(saved.cancelled_at,f.now);assert.equal(saved.opponent_id,null);
  const preview=(await f.api('bob','/invitations/preview',{token:inv.token})).body;assert.equal(preview.status,'cancelled');assert.equal(preview.canAccept,false);
  assert.equal((await f.api('bob','/invitations/accept',{token:inv.token})).body.error.code,'INVITATION_CANCELLED');
  assert.equal((await f.api('alice','/rounds/start',{requestId:id(),kind:'competition',competitionId:inv.competition.id})).body.error.code,'INVITATION_CANCELLED');
  assert.equal((await f.api('alice','/competitions',{requestId:saved.create_request_id,token:inv.token})).body.competition.status,'cancelled');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM rounds').get().n,0);
});
test('accepted duels cannot be cancelled and their existing attempt rules remain available',async t=>{
  const f=fixture(t),inv=await f.competition();await f.api('bob','/invitations/accept',{token:inv.token});
  assert.equal((await f.api('alice',`/competitions/${inv.competition.id}/cancel`,{})).body.error.code,'INVITATION_ACCEPTED');
  const state=(await f.api('alice','/state')).body;assert.equal(state.competitions[0].canCancel,false);assert.equal(state.competitions[0].status,'active');
  const r=await f.start('alice',inv.competition.id);assert.ok(r.id);
});
test('concurrent acceptance and cancellation have exactly one winner, regardless of which is submitted first',async t=>{
  const f=fixture(t);
  for(const cancelFirst of [true,false]){
    const inv=await f.competition(),cancel=()=>f.api('alice',`/competitions/${inv.competition.id}/cancel`,{}),accept=()=>f.api('bob','/invitations/accept',{token:inv.token});
    const responses=await Promise.all(cancelFirst?[cancel(),accept()]:[accept(),cancel()]);
    assert.equal(responses.filter(r=>r.status===200).length,1);assert.equal(responses.filter(r=>r.status===409).length,1);
    const saved=f.db.sqlite.prepare('SELECT opponent_id,cancelled_at FROM competitions WHERE id=?').get(inv.competition.id);
    assert.notEqual(saved.opponent_id!==null,saved.cancelled_at!==null);
  }
});
