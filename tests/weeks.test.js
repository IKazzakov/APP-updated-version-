import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTestDatabase} from './server-db.js';
import {handleApi} from '../server/api.js';
import {monday,sportsWeek,weekWindow,addDays,maintainWeeks} from '../server/weeks.js';
import {DELIVERY_GRACE_MS,EVENT_RETENTION_MS} from '../server/rules.js';
const DAY=86400000;
function fixture(t){
  const db=createTestDatabase();t.after(()=>db.close());let now=Date.parse('2026-10-20T12:00:00Z');
  const api=async(user,path,body)=>{
    let maintenance;do{maintenance=await maintainWeeks(db,now);}while(maintenance.pending);
    const r=await handleApi(new Request(`https://test.example/api/${path}`,{method:body===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':user,origin:'https://test.example','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:db},{now:()=>now});
    const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;
  };
  const profile=(user,enabled=false,zone='UTC')=>api(user,'profile',{displayName:user,timeZone:zone,rankingsEnabled:enabled});
  function round(user,count,extra={}){
    const id=crypto.randomUUID(),end=extra.end??now;
    db.sqlite.prepare('INSERT INTO rounds(id,user_id,start_request_id,kind,rules_version,status,starts_at,ends_at,finished_at,count) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user,crypto.randomUUID(),'personal',extra.rules??'squat-v1',extra.status??'completed',end-60000,end,end,count);return id;
  }
  function reward(user,date){
    db.sqlite.prepare('INSERT INTO daily_progress(user_id,local_date,count) VALUES(?,?,10) ON CONFLICT DO NOTHING').run(user,date);
    db.sqlite.prepare('INSERT INTO daily_rewards(user_id,local_date,awarded_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(user,date,now);
  }
  return {db,api,profile,round,reward,get now(){return now;},set now(n){now=n;}};
}

test('calendar Monday handles Sunday, year transition and common UTC+2 boundary',()=>{
  assert.equal(monday('2027-01-03'),'2026-12-28');assert.equal(monday('2027-01-04'),'2027-01-04');
  const boundary=Date.parse('2026-10-25T22:00:00Z');assert.equal(sportsWeek(boundary-1),'2026-10-19');assert.equal(sportsWeek(boundary),'2026-10-26');
  assert.equal(weekWindow('2026-10-19').endsAt,boundary);
});
test('one best positive compatible completed minute per opted-in user; public fields contain no identifiers',async t=>{
  const f=fixture(t);await f.profile('alice',true);await f.profile('bob',true);await f.profile('hidden');
  f.round('alice',20);f.round('alice',30);f.round('alice',100,{status:'aborted'});f.round('alice',200,{status:'active'});f.round('alice',300,{rules:'old'});f.round('bob',0);f.round('hidden',500);
  let b=await f.api('alice','leaderboards');assert.deepEqual(b.entries,[{place:1,name:'alice',value:30,isYou:true}]);
  f.db.sqlite.exec('PRAGMA ignore_check_constraints=ON');const invalid=f.round('bob',999);f.db.sqlite.prepare('UPDATE rounds SET starts_at=ends_at-59000 WHERE id=?').run(invalid);f.db.sqlite.exec('PRAGMA ignore_check_constraints=OFF');
  b=await f.api('bob','leaderboards');assert.equal(b.entries.length,1);assert.equal(b.you,null);
  assert.deepEqual(Object.keys(b.entries[0]).sort(),['isYou','name','place','value']);
});
test('ties use competition ranking 1,1,3,4; each tied participant receives the full prize exactly once',async t=>{
  const f=fixture(t);for(const u of ['a','b','c','d']){await f.profile(u,true);f.round(u,u==='c'?21:u==='d'?10:30);}
  assert.deepEqual((await f.api('a','leaderboards')).entries.map(e=>e.place),[1,1,3,4]);
  f.now=weekWindow('2026-10-19').endsAt+DELIVERY_GRACE_MS+1;
  await Promise.all([f.api('a','state'),f.api('b','state'),f.api('d','state')]);
  assert.deepEqual(f.db.sqlite.prepare("SELECT user_id,points FROM weekly_bonuses WHERE type='sport_place' ORDER BY user_id").all().map(r=>[r.user_id,r.points]),[['a',20],['b',20],['c',5]]);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM weekly_standings').get().n,4);
  await f.api('a','state');assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM weekly_bonuses').get().n,3);
});
test('second-place tie is 1,2,2,4 with two ten-point prizes',async t=>{
  const f=fixture(t);for(const [u,n] of [['a',30],['b',20],['c',20],['d',5]]){await f.profile(u,true);f.round(u,n);}
  f.now=weekWindow('2026-10-19').endsAt+15001;await f.api('a','state');
  assert.deepEqual(f.db.sqlite.prepare('SELECT place FROM weekly_standings ORDER BY place,user_id').all().map(r=>r.place),[1,2,2,4]);
  assert.deepEqual(f.db.sqlite.prepare('SELECT points FROM weekly_bonuses ORDER BY user_id').all().map(r=>r.points),[20,10,10]);
});
test('seven distinct dates in one local calendar week award 20, independent of consent and rolling last7',async t=>{
  const f=fixture(t);await f.profile('alice');
  for(let i=0;i<7;i++)f.reward('alice',addDays('2026-10-16',i));
  f.now=Date.parse('2026-10-22T20:00:00Z');let s=await f.api('alice','state');assert.equal(s.last7,7);assert.equal(s.points,70);assert.equal(s.weekly.yourWeek.completedDays,4);assert.equal(s.weekly.yourWeek.points.fullWeek,0);
  for(let i=4;i<7;i++)f.reward('alice',addDays('2026-10-19',i));
  f.now=Date.parse('2026-10-25T20:00:00Z');s=await f.api('alice','state');assert.equal(s.weekly.yourWeek.points.total,90);assert.equal(s.weekly.yourWeek.points.fullWeek,20);assert.equal(s.points,120);
  await Promise.all([f.api('alice','state'),f.api('alice','state')]);assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM weekly_bonuses WHERE type='full_week'").get().n,1);
});
test('late seven-day-retained repetition delivery backfills old-week daily reward, bonus, balance and viewed summary without changing sports',async t=>{
  const f=fixture(t);await f.profile('alice',true);f.round('alice',25);
  for(let i=0;i<6;i++)f.reward('alice',addDays('2026-10-19',i));
  f.now=Date.parse('2026-10-26T12:00:00Z');let s=await f.api('alice','state');const old=s.weekly.summaries[0];assert.equal(old.points.total,80);
  await f.api('alice','weeks/seen',{week:old.week,total:old.points.total});
  const events=Array.from({length:10},()=>({id:crypto.randomUUID(),occurredAt:Date.parse('2026-10-25T12:00:00Z')}));
  s=(await f.api('alice','repetitions',{events})).state;
  const updated=s.weekly.summaries[0];assert.equal(updated.points.total,110);assert.equal(updated.seen,true);assert.equal(updated.updatedSinceSeen,true);assert.equal(updated.best,25);assert.equal(updated.place,1);
  assert.equal(s.points,110);assert.equal(s.weekly.yourWeek.points.total,0);
  const retry=await f.api('alice','repetitions',{events});assert.equal(retry.accepted,0);assert.equal(retry.state.points,110);
  assert.equal((await f.api('alice','leaderboards?type=points&week=2026-10-19')).you.value,110);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_standings').get().n,1);
});
test('round ends_at selects half-open sports week; finish during 15-second grace precedes immutable close',async t=>{
  const f=fixture(t);await f.profile('alice',true);const boundary=weekWindow('2026-10-19').endsAt;
  f.now=boundary-60001;const r=(await f.api('alice','rounds/start',{requestId:crypto.randomUUID(),kind:'personal'})).round;
  await f.api('alice','repetitions',{events:[{id:crypto.randomUUID(),occurredAt:r.startsAt+1000,roundId:r.id,elapsedMs:1000}]});
  f.now=boundary+14000;let s=await f.api('alice','state');assert.equal(s.weekly.periods.find(w=>w.week==='2026-10-19').closed,false);
  await f.api('alice',`rounds/${r.id}/finish`,{});f.round('alice',2,{end:boundary});
  f.now=boundary+15001;s=await f.api('alice','state');assert.equal(s.weekly.periods.find(w=>w.week==='2026-10-19').closed,true);
  assert.equal((await f.api('alice','leaderboards?week=2026-10-19')).you.value,1);assert.equal((await f.api('alice','leaderboards')).you.value,2);
});
test('expired active rounds are aborted before sports closure and cannot fabricate results',async t=>{
  const f=fixture(t);await f.profile('alice',true);f.round('alice',100,{status:'active'});
  f.now=weekWindow('2026-10-19').endsAt+15001;const s=await f.api('alice','state');assert.equal(s.activeRound,null);assert.equal(s.weekly.summaries[0].best,null);assert.equal(s.weekly.summaries[0].participated,true);assert.equal(s.points,0);
});
test('first launch activation persists; old points survive and no bonus is backfilled before activation week',async t=>{
  const db=createTestDatabase(':memory:',{initialOnly:true});t.after(()=>db.close());const now=Date.parse('2026-10-20T12:00:00Z');
  db.sqlite.prepare('INSERT INTO profiles VALUES(?,?,?,?)').run('alice','Аня','UTC',now-DAY*20);
  for(let i=0;i<7;i++){const date=addDays('2026-10-12',i);db.sqlite.prepare('INSERT INTO daily_progress VALUES(?,?,10)').run('alice',date);db.sqlite.prepare('INSERT INTO daily_rewards VALUES(?,?,10,?)').run('alice',date,now-DAY*8);}
  db.sqlite.exec(readFileSync(new URL('../drizzle/0001_weekly_rankings.sql',import.meta.url),'utf8'));
  db.sqlite.exec(readFileSync(new URL('../drizzle/0002_ranking_defaults_duel_cancel.sql',import.meta.url),'utf8'));
  db.sqlite.exec(readFileSync(new URL('../drizzle/0004_server_optimization.sql',import.meta.url),'utf8'));
  await maintainWeeks(db,now);await maintainWeeks(db,now+DAY*30);
  assert.equal(db.sqlite.prepare('SELECT SUM(points) n FROM daily_rewards').get().n,70);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_bonuses').get().n,0);
  assert.equal(db.sqlite.prepare('SELECT activation_week FROM weekly_settings').get().activation_week,'2026-10-19');assert.equal(db.sqlite.prepare('SELECT rankings_enabled FROM profiles').get().rankings_enabled,0);
  assert.throws(()=>db.sqlite.prepare('INSERT INTO daily_rewards VALUES(?,?,20,?)').run('alice','2026-10-19',now));
});
test('long absence repairs all elapsed periods and all participants without visits or duplicated grants',async t=>{
  const f=fixture(t);for(const u of ['alice','bob'])await f.profile(u,true);
  for(let w=0;w<4;w++){const week=addDays('2026-10-19',7*w);for(const u of ['alice','bob']){f.round(u,20,{end:weekWindow(week).startsAt+DAY});for(let d=0;d<7;d++)f.reward(u,addDays(week,d));}}
  f.now=weekWindow('2026-11-16').startsAt+DAY;await f.api('alice','state');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_bonuses').get().n,16);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_summaries WHERE user_id=?').get('bob').n,4);
  assert.equal((await f.api('bob','state')).points,440);
});
test('opt-in includes current data; opt-out hides tables and preserves frozen prizes and ranks; re-opt-in does not enter closed weeks',async t=>{
  const f=fixture(t);for(const u of ['alice','bob','charlie']){await f.profile(u,u!=='charlie');f.round(u,u==='alice'?30:20);}
  assert.equal((await f.api('charlie','leaderboards')).entries.length,2);
  await f.profile('charlie',true);assert.equal((await f.api('charlie','leaderboards')).you.place,2);
  await f.profile('charlie',false);
  f.now=weekWindow('2026-10-19').endsAt+15001;await f.profile('alice',false); // closes before disabling
  let b=await f.api('bob','leaderboards?week=2026-10-19');assert.deepEqual(b.entries.map(e=>[e.name,e.place]),[['bob',2]]);
  assert.equal((await f.api('alice','state')).points,20);assert.equal((await f.api('bob','state')).points,10);
  await f.profile('charlie',true);assert.equal((await f.api('charlie','leaderboards?week=2026-10-19')).you,null);
  await f.profile('alice',true);assert.equal((await f.api('alice','leaderboards?week=2026-10-19')).you.place,1);
});
test('profile timezone calendar is distinct from sports week and cannot be changed on another device',async t=>{
  const f=fixture(t);f.now=Date.parse('2026-10-25T23:00:00Z');await f.profile('alice',true,'America/Los_Angeles');
  let s=await f.api('alice','state');assert.equal(s.weekly.sportsWeek,'2026-10-26');assert.equal(s.weekly.yourWeek.week,'2026-10-19');
  await f.profile('alice',true,'Asia/Tokyo');s=await f.api('alice','state');assert.equal(s.profile.timeZone,'America/Los_Angeles');
});
test('weekly and all-time balances include old daily rewards only once and never reward points-table places',async t=>{
  const f=fixture(t);await f.profile('alice',true);f.reward('alice','2026-10-12');for(let i=0;i<5;i++)f.reward('alice',addDays('2026-10-19',i));
  assert.equal((await f.api('alice','leaderboards?type=points')).you.value,50);assert.equal((await f.api('alice','leaderboards?type=points&period=all')).you.value,60);
  assert.equal((await f.api('alice','state')).points,60);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_bonuses').get().n,0);
});
test('seen acknowledgement persists across devices and is scoped to own summary; future device time is ignored',async t=>{
  const f=fixture(t);await f.profile('alice',true);await f.profile('bob',true);f.round('alice',10);f.round('bob',5);
  f.now=weekWindow('2026-10-19').endsAt+15001;let s=await f.api('alice','state');assert.equal(s.weekly.summaries[0].seen,false);
  await f.api('alice','weeks/seen',{week:'2026-10-19',total:20});s=await f.api('alice','state');assert.equal(s.weekly.summaries[0].seen,true);
  assert.equal((await f.api('bob','state')).weekly.summaries[0].seen,false);
  assert.equal((await f.api('alice','leaderboards')).periodInfo.closed,false);
  assert.equal(EVENT_RETENTION_MS,7*DAY);
});

test('completed duel result enters the weekly best without copying the round or changing duel rules',async t=>{
  const f=fixture(t);await f.profile('alice',true);await f.profile('bob',true);
  const token='a'.repeat(64),inv=(await f.api('alice','competitions',{requestId:crypto.randomUUID(),token})).competition;
  await f.api('bob','invitations/accept',{token});
  const r=(await f.api('alice','rounds/start',{requestId:crypto.randomUUID(),kind:'competition',competitionId:inv.id})).round;
  await f.api('alice','repetitions',{events:Array.from({length:6},()=>({id:crypto.randomUUID(),occurredAt:r.startsAt+1000,roundId:r.id,elapsedMs:1000}))});
  f.now=r.endsAt;await f.api('alice',`rounds/${r.id}/finish`,{});
  assert.equal((await f.api('alice','leaderboards')).you.value,6);
  const s=await f.api('alice','state');assert.equal(s.rounds.length,1);assert.equal(s.competitions[0].participants[0].attemptsLeft,2);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM rounds').get().n,1);
});
test('an interrupted closure transaction rolls back standings and awards and a later request recovers all of it',async t=>{
  const f=fixture(t);await f.profile('alice',true);f.round('alice',20);
  f.now=weekWindow('2026-10-19').endsAt+15001;
  const wrapped={prepare:sql=>f.db.prepare(sql),batch:statements=>f.db.batch([...statements.slice(0,-1),f.db.prepare('INSERT INTO deliberately_missing_table VALUES(1)')])};
  await assert.rejects(maintainWeeks(wrapped,f.now));
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_standings').get().n,0);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_bonuses').get().n,0);
  assert.equal(f.db.sqlite.prepare('SELECT closed_at FROM weekly_periods WHERE week=?').get('2026-10-19').closed_at,null);
  await f.api('alice','state');assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_bonuses').get().n,1);
});
test('weekly endpoints reject unauthenticated access, invalid periods and foreign acknowledgement fields',async t=>{
  const f=fixture(t);await f.profile('alice',true);
  const call=async(path,{user='alice',method='GET',body}={})=>{
    const r=await handleApi(new Request(`https://test.example/api/${path}`,{method,headers:{...(user?{'oai-authenticated-user-id':user}:{}),origin:'https://test.example','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),{DB:f.db},{now:()=>f.now});return r.status;
  };
  assert.equal(await call('leaderboards',{user:null}),401);
  for(const path of ['leaderboards?type=rounds','leaderboards?period=all','leaderboards?week=2026-10-20','leaderboards?week=2026-02-30'])assert.equal(await call(path),400);
  assert.equal(await call('weeks/seen',{method:'POST',body:{week:'2026-10-19',total:20,userId:'bob'}}),400);
  assert.equal(await call('profile',{method:'POST',body:{displayName:'Alice',timeZone:'UTC',rankingsEnabled:'yes'}}),400);
});
test('points ranking includes consenting users with zero balance but never pays for a points place',async t=>{
  const f=fixture(t);await f.profile('alice',true);await f.profile('bob',true);
  const b=await f.api('alice','leaderboards?type=points');assert.deepEqual(b.entries.map(e=>[e.place,e.value]),[[1,0],[1,0]]);
  f.now=weekWindow('2026-10-19').endsAt+15001;assert.equal((await f.api('alice','state')).points,0);
});

test('all old profiles become included once after additive migration; new opt-outs survive profile edits and repeated reads',async t=>{
  const db=createTestDatabase(':memory:',{initialOnly:true});t.after(()=>db.close());const now=Date.parse('2026-10-20T12:00:00Z');
  db.sqlite.exec(readFileSync(new URL('../drizzle/0001_weekly_rankings.sql',import.meta.url),'utf8'));
  for(const [u,flag] of [['old-off',0],['old-on',1]]){
    db.sqlite.prepare('INSERT INTO profiles(user_id,display_name,time_zone,created_at,rankings_enabled) VALUES(?,?,?,?,?)').run(u,u,'UTC',now,flag);
    db.sqlite.prepare('INSERT INTO daily_progress VALUES(?,?,10)').run(u,'2026-10-20');db.sqlite.prepare('INSERT INTO daily_rewards VALUES(?,?,10,?)').run(u,'2026-10-20',now);
  }
  db.sqlite.exec(readFileSync(new URL('../drizzle/0002_ranking_defaults_duel_cancel.sql',import.meta.url),'utf8'));
  db.sqlite.exec(readFileSync(new URL('../drizzle/0004_server_optimization.sql',import.meta.url),'utf8'));
  const call=async(user,path,body)=>{
    const r=await handleApi(new Request(`https://test.example/api/${path}`,{method:body?'POST':'GET',headers:{'oai-authenticated-user-id':user,origin:'https://test.example','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),{DB:db},{now:()=>now});assert.equal(r.status,200);return r.json();
  };
  for(const u of ['old-off','old-on']){const s=await call(u,'state');assert.equal(s.profile.rankingsEnabled,true);assert.equal(s.points,10);}
  const fresh=await call('new','profile',{displayName:'Новый',timeZone:'UTC'});assert.equal(fresh.profile.rankingsEnabled,true);
  await call('old-off','profile',{displayName:'Имя',timeZone:'UTC',rankingsEnabled:false});
  await call('old-off','profile',{displayName:'Другое имя',timeZone:'Asia/Tokyo'});
  for(let i=0;i<3;i++){const s=await call('old-off','state');assert.equal(s.profile.rankingsEnabled,false);assert.equal(s.profile.timeZone,'UTC');assert.equal(s.points,10);}
  const board=await call('old-on','leaderboards?type=points');assert.deepEqual(board.entries.map(e=>e.name),['old-on','Новый']);
});
