import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './server-db.js';
import {handleApi} from '../server/api.js';
import worker from '../server/cloudflare.js';
import {WORKOUT_PROGRAMS,expandWorkoutSteps} from '../src/shared/workouts/catalog.ts';

const id=()=>crypto.randomUUID(),DAY=86400000;
function fixture(t,zone='UTC'){
  const db=createTestDatabase();t.after(()=>db.close());let now=Date.parse('2026-10-26T12:00:00Z');
  db.sqlite.prepare('UPDATE activity_settings SET activated_at=?').run(now-7*DAY);
  const call=async(path,body,user='alice',headers={})=>{
    const r=await handleApi(new Request('https://test.example/api/'+path,{method:body===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':user,origin:'https://test.example','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:db},{now:()=>now});
    return {status:r.status,data:await r.json(),headers:r.headers};
  };
  const profile=async(user='alice')=>{const r=await call('profile',{displayName:user,timeZone:zone},user);assert.equal(r.status,200);};
  const identity=(programId='squats-5-v1',startedAt=now)=>({id:id(),programId,startedAt});
  const reps=(count,stepIndex=0,time=now)=>Array.from({length:count},()=>({id:id(),stepIndex,occurredAt:time}));
  const holds=(count,stepIndex=0,start=now-15000,durationMs=1000)=>Array.from({length:count},(_,index)=>({id:id(),stepIndex,occurredAt:start+index*durationMs,durationMs}));
  const sync=(workout,events=[],user='alice')=>call('v2/workouts/sync',{workout,events},user);
  const end=(workout,action='finish',user='alice',input={endedAt:now,activeMs:now-workout.startedAt})=>call(`v2/workouts/${workout.id}/${action}`,input,user);
  const progress=async(user='alice')=>(await call('v2/activity',undefined,user)).data;
  return {db,call,profile,identity,reps,holds,sync,end,progress,get now(){return now;},set now(value){now=value;}};
}

test('fixed catalogue and activity require a profile and share private no-store responses',async t=>{
  const f=fixture(t);
  assert.equal((await f.call('v2/workouts/catalog')).data.error.code,'PROFILE_REQUIRED');await f.profile();
  const result=await f.call('v2/workouts/catalog');assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(result.data.programs,WORKOUT_PROGRAMS);assert.equal(result.data.rulesVersion,'workout-v1');
  assert.equal((await f.call('workouts/catalog')).status,404);
  assert.equal((await f.sync({...f.identity(),programId:'client-supplied-routine'})).status,400);
  const response=await worker.fetch(new Request('https://test.example/api/v2/workouts/catalog'),{DB:f.db});assert.equal(response.status,401);assert.equal((await response.json()).error.code,'DEVICE_AUTH_REQUIRED');
});

test('all four programmes finish with their fixed targets; only squats mirror the old daily goal',async t=>{
  const f=fixture(t);await f.profile();
  for(const program of WORKOUT_PROGRAMS){
    const workout=f.identity(program.id,f.now-30000),events=[];
    expandWorkoutSteps(program).forEach((step,index)=>events.push(...(step.unit==='ms'?f.holds(step.target/1000,index,f.now-15000):f.reps(step.target,index,f.now-20000))));
    const first=await f.sync(workout,events);assert.equal(first.status,200,JSON.stringify(first.data));
    assert.deepEqual(first.data.workout.stepProgress,expandWorkoutSteps(program).map(step=>step.target));
    const done=await f.end(workout);assert.equal(done.status,200);assert.equal(done.data.workout.status,'completed');
    const retry=await f.sync(workout,events);assert.equal(retry.status,200);assert.equal(retry.data.accepted,0);assert.equal(retry.data.duplicate,events.length);
    const again=await f.end(workout);assert.equal(again.data.progress.version,done.data.progress.version);
    const abort=await f.end(workout,'abort');assert.equal(abort.data.workout.status,'completed');
    f.now+=60000;
  }
  const progress=await f.progress();assert.equal(progress.totalXp,26);assert.equal(progress.today.squats,10);assert.equal(progress.today.pushups,10);assert.equal(progress.today.plankMs,30000);
  const legacy=(await f.call('state')).data;assert.equal(legacy.today.count,10);assert.equal(legacy.points,10);assert.equal(legacy.rounds.length,0);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM rounds').get().n,0);
  assert.equal((await f.call('v2/workouts/history')).data.items.length,4);
});

test('partial work keeps XP, incomplete finish fails and aborted results cannot be promoted or rewritten',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity();const events=f.reps(2);
  assert.equal((await f.sync(workout,events)).data.progress.totalXp,2);
  assert.equal((await f.end(workout)).data.error.code,'WORKOUT_INCOMPLETE');
  const aborted=await f.end(workout,'abort');assert.equal(aborted.data.workout.status,'aborted');assert.equal(aborted.data.progress.totalXp,2);
  f.now+=1000;const again=await f.end(workout,'abort');assert.deepEqual(again.data.workout,aborted.data.workout);
  assert.equal((await f.end(workout)).data.error.code,'WORKOUT_CLOSED');
  assert.equal((await f.sync(workout,f.reps(1))).data.error.code,'WORKOUT_CLOSED');
  assert.equal((await f.sync(workout,events)).data.accepted,0);
});

test('stable metadata and event UUID conflicts reject the complete request without partial writes',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity(),event=f.reps(1)[0];
  const first=await f.sync(workout,[event,event]);assert.equal(first.data.accepted,1);assert.equal(first.data.duplicate,1);
  assert.equal((await f.sync({...workout,startedAt:workout.startedAt-1},[])).data.error.code,'REQUEST_REUSED');
  assert.equal((await f.sync(workout,[{...event,occurredAt:event.occurredAt+1}])).data.error.code,'REQUEST_REUSED');
  assert.equal((await f.sync(workout,[f.reps(1)[0],{...event,occurredAt:event.occurredAt+1}])).data.error.code,'REQUEST_REUSED');
  assert.deepEqual((await f.progress()).today.squats,1);
});

test('programme and legacy routes share one UUID and one XP award in either delivery order',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity(),events=f.reps(5);
  const legacyEvent={id:events[0].id,occurredAt:events[0].occurredAt};
  await f.call('repetitions',{events:[legacyEvent]});assert.equal((await f.progress()).totalXp,1);
  assert.equal((await f.sync(workout,events)).data.progress.totalXp,5);
  assert.equal((await f.call('v2/repetitions',{events:events.map(event=>({id:event.id,occurredAt:event.occurredAt}))})).data.accepted,0);
  assert.equal((await f.progress()).totalXp,5);assert.equal((await f.call('state')).data.today.count,5);
});

test('historical legacy UUIDs cannot be reused as a new exercise after XP activation',async t=>{
  const f=fixture(t);await f.profile();const historical=id();
  f.db.sqlite.prepare('DROP TRIGGER activity_from_legacy').run();
  f.db.sqlite.prepare('INSERT INTO repetition_events(user_id,id,occurred_at,local_date,received_at) VALUES(?,?,?,?,?)').run('alice',historical,f.now-DAY,'2026-10-25',f.now-DAY);
  const response=await f.sync(f.identity('pushups-5-v1'),[{id:historical,stepIndex:0,occurredAt:f.now}]);
  assert.equal(response.data.error.code,'REQUEST_REUSED');assert.equal((await f.progress()).totalXp,0);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM workout_sessions').get().n,0);
});

test('target overflow and skipping earlier steps roll the whole transaction back, including legacy rewards',async t=>{
  const f=fixture(t);await f.profile();
  const overflow=await f.sync(f.identity(),f.reps(6));assert.equal(overflow.data.error.code,'WORKOUT_TARGET_EXCEEDED');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM workout_sessions').get().n,0);assert.equal((await f.progress()).totalXp,0);assert.equal((await f.call('state')).data.today.count,0);
  const skipped=await f.sync(f.identity('starter-circuit-v1'),f.reps(1,1));assert.equal(skipped.data.error.code,'WORKOUT_STEP_ORDER');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM workout_events').get().n,0);
});

test('known active programme and minute protect each other atomically without touching another user',async t=>{
  const f=fixture(t);await f.profile();await f.profile('bob');
  const one=f.identity(),two=f.identity();const raced=await Promise.all([f.sync(one),f.sync(two)]);
  assert.deepEqual(raced.map(result=>result.status).sort(),[200,409]);assert.equal(raced.find(result=>result.status===409).data.error.code,'ACTIVE_WORKOUT');
  const active=raced[0].status===200?one:two;
  assert.equal((await f.call('rounds/start',{requestId:id(),kind:'personal'})).data.error.code,'ACTIVE_WORKOUT');
  const bob=await f.call('rounds/start',{requestId:id(),kind:'personal'},'bob');assert.equal(bob.status,200);
  assert.equal((await f.sync(f.identity(),[],'bob')).data.error.code,'ACTIVE_ROUND');
  await f.end(active,'abort');const started=await f.call('rounds/start',{requestId:id(),kind:'personal'});assert.equal(started.status,200);
  assert.equal((await f.sync(f.identity())).data.error.code,'ACTIVE_ROUND');
  assert.equal(f.db.sqlite.prepare('SELECT status FROM rounds WHERE id=?').get(bob.data.round.id).status,'active');
});

test('new programme holds accumulate after gaps; overlapping intervals are never awarded twice',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity('plank-15-v1',f.now-30000);
  const first=f.holds(5,0,f.now-25000),second=f.holds(10,0,f.now-10000);
  assert.equal((await f.sync(workout,first)).data.progress.totalXp,1);
  const overlap={id:id(),stepIndex:0,occurredAt:first[0].occurredAt+500,durationMs:1000};
  assert.equal((await f.sync(workout,[overlap])).data.error.code,'ACTIVITY_INTERVAL_OVERLAP');
  const finished=await f.sync(workout,second);assert.deepEqual(finished.data.workout.stepProgress,[15000]);assert.equal(finished.data.progress.totalXp,3);
  assert.equal((await f.end(workout)).data.workout.status,'completed');
});

test('plank milliseconds split at the profile midnight and round only after summing each local day',async t=>{
  const f=fixture(t,'Pacific/Auckland');await f.profile();const midnight=Date.parse('2026-10-26T11:00:00Z');f.now=midnight+6000;
  const workout=f.identity('plank-15-v1',midnight-6000);
  const events=[...f.holds(4,0,midnight-4500),{id:id(),stepIndex:0,occurredAt:midnight-500,durationMs:1000},...f.holds(4,0,midnight+500),{id:id(),stepIndex:0,occurredAt:midnight+4500,durationMs:500}];
  const response=await f.sync(workout,events);assert.equal(response.status,200);assert.equal(response.data.progress.totalXp,1);
  assert.equal(response.data.progress.today.date,'2026-10-27');assert.equal(response.data.progress.today.plankMs,5000);assert.equal(response.data.progress.today.xp,1);
  const old=f.db.sqlite.prepare('SELECT * FROM activity_days WHERE local_date=?').get('2026-10-26');assert.equal(old.plank_ms,4500);assert.equal(old.xp,0);
  const retry=await f.sync(workout,events);assert.equal(retry.data.accepted,0);assert.equal(retry.data.progress.version,response.data.progress.version);
});

test('300 XP cap is daily, raw activity survives the cap, and levels use total confirmed XP',async t=>{
  const f=fixture(t);await f.profile();
  for(let i=0;i<4;i++)assert.equal((await f.call('repetitions',{events:f.reps(100).map(({id,occurredAt})=>({id,occurredAt}))})).status,200);
  let progress=await f.progress();assert.equal(progress.totalXp,300);assert.equal(progress.today.squats,400);assert.equal(progress.today.units,400);assert.equal(progress.level,4);assert.equal(progress.xpInLevel,0);
  const workout=f.identity('pushups-5-v1');await f.sync(workout,f.reps(5));await f.end(workout);progress=await f.progress();assert.equal(progress.today.pushups,5);assert.equal(progress.totalXp,300);
  f.now+=DAY;await f.call('repetitions',{events:f.reps(1).map(({id,occurredAt})=>({id,occurredAt}))});
  progress=await f.progress();assert.equal(progress.totalXp,301);assert.equal(progress.today.xp,1);assert.equal(progress.xpInLevel,1);
});

test('streak restores historical completed days without retro XP, then late work repairs the original day',async t=>{
  const f=fixture(t);await f.profile();f.db.sqlite.prepare('UPDATE activity_settings SET activated_at=?').run(f.now);
  for(const day of [4,3,1])await f.call('repetitions',{events:f.reps(10,0,f.now-day*DAY).map(({id,occurredAt})=>({id,occurredAt}))});
  let progress=await f.progress();assert.equal(progress.totalXp,0);assert.equal(progress.streak.current,1);assert.equal(progress.streak.best,2);
  await f.call('repetitions',{events:f.reps(10,0,f.now-2*DAY).map(({id,occurredAt})=>({id,occurredAt}))});
  progress=await f.progress();assert.equal(progress.streak.current,4);assert.equal(progress.streak.best,4);assert.equal(progress.today.completed,false);
  await f.call('repetitions',{events:f.reps(10).map(({id,occurredAt})=>({id,occurredAt}))});
  progress=await f.progress();assert.equal(progress.streak.current,5);assert.equal(progress.totalXp,10);
});

test('activation uses movement time and a crossing plank only earns XP for eligible milliseconds',async t=>{
  const f=fixture(t);await f.profile();const activation=f.now-500;f.db.sqlite.prepare('UPDATE activity_settings SET activated_at=?').run(activation);
  const workout=f.identity('plank-15-v1',f.now-6000);
  const events=[...f.holds(5,0,f.now-5500),{id:id(),stepIndex:0,occurredAt:f.now-500,durationMs:500}];
  let response=await f.sync(workout,events);assert.equal(response.data.progress.today.plankMs,5500);assert.equal(response.data.progress.totalXp,0);
  f.now+=4500;response=await f.sync(workout,f.holds(4,0,activation+500));assert.equal(response.status,200);assert.equal(response.data.progress.totalXp,0);
  f.now+=500;response=await f.sync(workout,[{id:id(),stepIndex:0,occurredAt:activation+4500,durationMs:500}]);assert.equal(response.status,200);assert.equal(response.data.progress.totalXp,1);
});

test('history keyset is stable at equal timestamps, excludes active sessions and is owner scoped',async t=>{
  const f=fixture(t);await f.profile();await f.profile('bob');
  for(let i=0;i<5;i++){const workout=f.identity();await f.sync(workout);await f.end(workout,'abort');}
  const other=f.identity();await f.sync(other,[],'bob');await f.end(other,'abort','bob');await f.sync(f.identity());
  const one=(await f.call('v2/workouts/history?limit=2')).data,two=(await f.call('v2/workouts/history?limit=2&cursor='+one.nextCursor)).data,three=(await f.call('v2/workouts/history?limit=2&cursor='+two.nextCursor)).data;
  assert.deepEqual([one.items.length,two.items.length,three.items.length],[2,2,1]);assert.equal(three.nextCursor,null);assert.equal(new Set([...one.items,...two.items,...three.items].map(value=>value.id)).size,5);
  assert.equal((await f.call(`v2/workouts/${other.id}/abort`,{endedAt:f.now,activeMs:0})).status,404);
  for(const query of ['limit=0','limit=101','cursor=oops','cursor='+btoa(JSON.stringify({kind:'rounds',key:[f.now,id()]})).replace(/=+$/,'')])assert.equal((await f.call('v2/workouts/history?'+query)).status,400);
});

test('unknown fields, invalid durations, timestamps and invalid final timing are rejected',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity('plank-15-v1',f.now-1000);
  for(const event of [{id:id(),stepIndex:0,occurredAt:f.now-1000,durationMs:1001},{id:id(),stepIndex:0,occurredAt:f.now-1000,durationMs:0},{id:id(),stepIndex:0,occurredAt:f.now-1000,durationMs:500,landmarks:[]}])assert.equal((await f.sync(workout,[event])).status,400);
  assert.equal((await f.sync(f.identity(),[{id:id(),stepIndex:0,occurredAt:f.now,durationMs:1}])).status,400);
  const event={id:id(),stepIndex:0,occurredAt:f.now-1000,durationMs:1000};await f.sync(workout,[event]);
  assert.equal((await f.end(workout,'abort','alice',{endedAt:f.now-1,activeMs:0})).status,400);
  assert.equal((await f.end(workout,'abort','alice',{endedAt:f.now,activeMs:1001})).status,400);
  assert.equal((await f.end(workout,'abort','alice',{endedAt:f.now,activeMs:0,manual:true})).status,400);
  assert.equal((await f.call('v2/workouts/sync',{workout,events:[]},'alice',{origin:'https://evil.example'})).status,403);
  assert.equal((await f.call('v2/workouts/sync',{workout,events:[]},'alice',{'content-type':'text/plain'})).status,415);
});


test('uppercase legacy UUID and lowercase programme identity share a single fact',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity(),events=f.reps(5);
  await f.call('repetitions',{events:[{id:events[0].id.toUpperCase(),occurredAt:events[0].occurredAt}]});
  const saved=await f.sync(workout,events);assert.equal(saved.status,200);assert.equal(saved.data.progress.totalXp,5);
  assert.equal((await f.call('state')).data.today.count,5);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM activity_events').get().n,5);
  const duplicate=await f.sync(workout,[{...events[0],id:events[0].id.toUpperCase()}]);assert.equal(duplicate.data.accepted,0);assert.equal(duplicate.data.progress.totalXp,5);
});

test('late offline import and finalization retain activity day, including an eight-day-old start with a seven-day-old result',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity('squats-5-v1',f.now-7*DAY-1000),events=f.reps(5,0,f.now-7*DAY);
  const saved=await f.sync(workout,events);assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.progress.totalXp,5);
  assert.equal((await f.end(workout,'finish','alice',{endedAt:f.now-7*DAY,activeMs:1000})).data.workout.status,'completed');
  assert.equal((await f.progress()).today.squats,0);
  const stale=f.identity('squats-5-v1',f.now-7*DAY-1001);assert.equal((await f.sync(stale,f.reps(1,0,f.now-7*DAY-1))).data.error.code,'INVALID_EVENT_TIME');
});

test('concurrent contradictory event delivery and target filling preserve one committed fact/target',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity('squats-5-v1',f.now-5),event=f.reps(1)[0];
  const collision=await Promise.all([f.sync(workout,[event]),f.sync(workout,[{...event,occurredAt:event.occurredAt-1}])]);
  assert.deepEqual(collision.map(result=>result.status).sort(),[200,409]);assert.equal((await f.progress()).totalXp,1);
  const fill=await Promise.all([f.sync(workout,f.reps(4)),f.sync(workout,f.reps(4))]);
  assert.deepEqual(fill.map(result=>result.status).sort(),[200,400]);assert.equal(fill.find(result=>result.status===400).data.error.code,'WORKOUT_TARGET_EXCEEDED');
  assert.equal((await f.progress()).totalXp,5);assert.equal((await f.call('state')).data.today.count,5);
});

test('concurrent minute/programme starts and competing finish/abort never rewrite terminal status',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity();
  const starts=await Promise.all([f.sync(workout),f.call('rounds/start',{requestId:id(),kind:'personal'})]);
  assert.deepEqual(starts.map(result=>result.status).sort(),[200,409]);
  if(starts[1].status===200){await f.call(`rounds/${starts[1].data.round.id}/abort`,{});assert.equal((await f.sync(workout)).status,200);}
  await f.sync(workout,f.reps(5));
  const ends=await Promise.all([f.end(workout),f.end(workout,'abort')]);
  const stored=f.db.sqlite.prepare('SELECT * FROM workout_sessions WHERE id=?').get(workout.id);
  assert.ok(['completed','aborted'].includes(stored.status));
  for(const result of ends)if(result.status===200)assert.equal(result.data.workout.status,stored.status);else assert.equal(result.data.error.code,'WORKOUT_CLOSED');
  assert.equal((await f.end(workout,'abort')).data.workout.status,stored.status);assert.equal((await f.progress()).totalXp,5);
});

test('event arriving between finalization read and update cannot become a post-finish repetition',async t=>{
  const f=fixture(t);await f.profile();const workout=f.identity('squats-5-v1',f.now-2000);
  await f.sync(workout,f.reps(1,0,f.now-1000));let injected=false;
  const wrap=statement=>({source:statement,bind(...args){return wrap(statement.bind(...args));},all:()=>statement.all(),run:()=>statement.run(),async first(...args){
    const value=await statement.first(...args);
    if(!injected&&statement.sql.includes('SELECT MAX(occurred_at+COALESCE(duration_ms,0))')){injected=true;assert.equal((await f.sync(workout,f.reps(1))).status,200);}
    return value;
  }});
  const db={prepare:sql=>wrap(f.db.prepare(sql)),batch:statements=>f.db.batch(statements.map(statement=>statement.source))};
  const response=await handleApi(new Request(`https://test.example/api/v2/workouts/${workout.id}/abort`,{method:'POST',headers:{'oai-authenticated-user-id':'alice',origin:'https://test.example','content-type':'application/json'},body:JSON.stringify({endedAt:f.now-500,activeMs:0})}),{DB:db},{now:()=>f.now});
  assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_WORKOUT_TIME');
  assert.equal(f.db.sqlite.prepare('SELECT status FROM workout_sessions WHERE id=?').get(workout.id).status,'active');
  const done=await f.end(workout,'abort');assert.equal(done.status,200);assert.deepEqual(done.data.workout.stepProgress,[2]);assert.equal(done.data.progress.totalXp,2);
});

for(const count of [0,2])test(`recovery of ${count} confirmed reps: replay sync/abort releases active lock without losing XP`,async t=>{
 const f=fixture(t);await f.profile();const workout=f.identity();
 const start=await f.sync(workout,[]);assert.equal(start.status,200);
 const events=f.reps(count);assert.equal((await f.sync(workout,events)).data.accepted,count);
 assert.equal((await f.sync(f.identity())).data.error.code,'ACTIVE_WORKOUT');
 const ended=await f.end(workout,'abort');assert.equal(ended.status,200);assert.equal(ended.data.workout.status,'aborted');
 const replay=await f.sync(workout,events);assert.equal(replay.data.accepted,0);assert.equal(replay.data.duplicate,count);
 const again=await f.end(workout,'abort');assert.deepEqual(again.data.workout,ended.data.workout);
 assert.equal(again.data.progress.totalXp,count);assert.equal((await f.end(workout)).data.error.code,'WORKOUT_CLOSED');
 assert.equal((await f.sync(f.identity('pushups-5-v1'))).status,200);
 assert.equal((await f.call('state')).data.rounds.length,0);
 assert.equal((await f.call('v2/dashboard')).data.stats.record,null);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM rounds').get().n,0);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_best').get().n,0);
});

test('public device Worker routes empty/partial sync, replay and abort before accepting the next programme',async t=>{
 const f=fixture(t);await f.profile();const secret='c'.repeat(64);
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret))).toString('hex');
 f.db.sqlite.prepare('INSERT INTO device_sessions VALUES(?,?,?,NULL)').run(hash,'alice',f.now);
 const call=async(path,body,origin='https://test.example')=>{
  const response=await worker.fetch(new Request('https://test.example/api/v2/'+path,{method:'POST',headers:{Authorization:'Bearer '+secret,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}),{DB:f.db});
  return {status:response.status,data:await response.json()};
 };
 for(const count of [0,2]){
  const workout=f.identity(),events=f.reps(count),input={workout,events:[]};
  assert.equal((await call('workouts/sync',input,'https://wrong.example')).status,403);
  assert.equal((await call('workouts/sync',input)).status,200);
  assert.equal((await call('workouts/sync',{workout,events})).data.accepted,count);
  const end={endedAt:f.now,activeMs:0},path=`workouts/${workout.id}/abort`;
  const done=await call(path,end);assert.equal(done.status,200);assert.equal(done.data.workout.status,'aborted');
  assert.deepEqual((await call(path,end)).data.workout,done.data.workout);
  assert.equal((await call('workouts/sync',{workout,events})).data.accepted,0);
 }
 assert.equal((await call('workouts/sync',{workout:f.identity('pushups-5-v1'),events:[]})).status,200);
 assert.equal((await f.progress()).totalXp,2);
});
