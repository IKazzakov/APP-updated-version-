import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './server-db.js';
import {handleApi} from '../server/api.js';
import {runMaintenance,reconcileUserWeek} from '../server/maintenance.js';
import {weekWindow,addDays} from '../server/weeks.js';
import worker from '../server/cloudflare.js';

function fixture(t){
  const db=createTestDatabase();t.after(()=>db.close());let now=Date.parse('2026-10-20T12:00:00Z');
  const call=async(user,path,body,connection=db)=>{const r=await handleApi(new Request('https://test.example/api/'+path,{method:body===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':user,origin:'https://test.example','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB:connection},{now:()=>now});return {status:r.status,data:await r.json()};};
  const profile=(u,enabled=true)=>call(u,'v2/profile',{displayName:u,timeZone:'UTC',rankingsEnabled:enabled});
  const events=n=>Array.from({length:n},()=>({id:crypto.randomUUID(),occurredAt:now}));
  return {db,call,profile,events,get now(){return now;},set now(v){now=v;}};
}
test('compact 100-event receipt is bounded, transactional and retry-safe; legacy APK keeps full state',async t=>{
  const f=fixture(t);await f.profile('alice');await f.profile('bob');
  const events=f.events(100),r=await f.call('alice','v2/repetitions',{events});
  assert.equal(r.status,200);assert.equal(r.data.accepted,100);assert.equal(r.data.state.today.count,100);assert.equal(r.data.state.points,10);
  assert.equal(r.data.state.partial,true);assert.equal('rounds' in r.data.state,false);assert.equal('competitions' in r.data.state,false);assert.equal('weekly' in r.data.state,false);
  assert.ok(Buffer.byteLength(JSON.stringify(r.data))<10240);
  const retry=await f.call('alice','v2/repetitions',{events});assert.equal(retry.data.accepted,0);assert.equal(retry.data.duplicate,100);assert.equal(retry.data.state.version,r.data.state.version);
  const old=await f.call('alice','repetitions',{events});assert.equal(old.status,200);assert.ok(Array.isArray(old.data.state.rounds));assert.ok(old.data.state.weekly);
  assert.equal((await f.call('bob','v2/dashboard')).data.today.count,0);
});
test('ordinary save neither scans historical state nor expires another users round',async t=>{
  const f=fixture(t);await f.profile('alice');await f.profile('bob');
  const round=(await f.call('bob','v2/rounds/start',{requestId:crypto.randomUUID(),kind:'personal'})).data.round;f.now=round.endsAt+15001;
  const sql=[],wrap=statement=>({bind(...args){return wrap(statement.bind(...args));},first:(...a)=>statement.first(...a),all:()=>statement.all(),run:()=>statement.run(),source:statement});
  const measured={prepare:q=>{sql.push(q);return wrap(f.db.prepare(q));},batch:ss=>f.db.batch(ss.map(s=>s.source))};
  const r=await f.call('alice','v2/repetitions',{events:f.events(50)},measured);assert.equal(r.status,200);
  assert.equal(f.db.sqlite.prepare('SELECT status FROM rounds WHERE id=?').get(round.id).status,'active');
  assert.ok(sql.length<20,sql.join('\n'));assert.ok(sql.every(q=>!q.includes('CROSS JOIN')&&!q.includes('INSERT INTO weekly_standings')&&!q.includes('SELECT * FROM competitions')));
  await runMaintenance(f.db,f.now);assert.equal(f.db.sqlite.prepare('SELECT status FROM rounds WHERE id=?').get(round.id).status,'aborted');
});
test('same-time round cursor is stable, bounded and scoped to the authenticated user',async t=>{
  const f=fixture(t);await f.profile('alice');await f.profile('bob');
  for(const u of ['alice','bob'])for(let i=0;i<57;i++)f.db.sqlite.prepare("INSERT INTO rounds(id,user_id,start_request_id,kind,rules_version,status,starts_at,ends_at,finished_at,count) VALUES(?,?,?,'personal','squat-v1','completed',?,?,?,?)").run(crypto.randomUUID(),u,crypto.randomUUID(),f.now-60000,f.now,f.now,i);
  const one=(await f.call('alice','v2/history/rounds?limit=50')).data,two=(await f.call('alice','v2/history/rounds?limit=50&cursor='+one.nextCursor)).data;
  assert.equal(one.items.length,50);assert.equal(two.items.length,7);assert.equal(two.nextCursor,null);assert.equal(new Set([...one.items,...two.items].map(r=>r.id)).size,57);
  for(const r of [...one.items,...two.items])assert.equal(f.db.sqlite.prepare('SELECT user_id FROM rounds WHERE id=?').get(r.id).user_id,'alice');
  for(const path of ['v2/history/rounds?limit=101','v2/history/rounds?limit=0','v2/history/rounds?cursor=not-valid','v2/history/progress?from=2026-02-30','v2/history/progress?from=2024-01-01&to=2026-01-01'])assert.equal((await f.call('alice',path)).status,400,path);
});
test('dashboard stays bounded while history and all-time personal record remain accessible',async t=>{
  const f=fixture(t);await f.profile('alice');
  for(let i=0;i<70;i++)f.db.sqlite.prepare("INSERT INTO rounds(id,user_id,start_request_id,kind,rules_version,status,starts_at,ends_at,finished_at,count) VALUES(?,?,?,'personal','squat-v1','completed',?,?,?,?)").run(crypto.randomUUID(),'alice',crypto.randomUUID(),f.now-60000-i*1000,f.now-i*1000,f.now-i*1000,i+1);
  const s=(await f.call('alice','v2/dashboard')).data;assert.equal(s.rounds.length,2);assert.equal(s.stats.record,70);assert.equal(s.competitions.length,0);assert.ok(s.weekly.periods.length<=12);assert.ok(s.weekly.summaries.length<=4);
});
test('delayed cron honours pre-cutoff consent; visits never close a week or allocate prizes',async t=>{
  const f=fixture(t);await f.profile('alice');
  f.db.sqlite.prepare("INSERT INTO rounds(id,user_id,start_request_id,kind,rules_version,status,starts_at,ends_at,finished_at,count) VALUES(?,?,?,'personal','squat-v1','completed',?,?,?,20)").run(crypto.randomUUID(),'alice',crypto.randomUUID(),f.now-60000,f.now,f.now);
  f.now=weekWindow('2026-10-19').endsAt+15001;await f.profile('alice',false);
  await f.call('alice','state');await f.call('alice','v2/dashboard');assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_standings').get().n,0);
  await Promise.all([runMaintenance(f.db,f.now),runMaintenance(f.db,f.now)]);
  assert.equal(f.db.sqlite.prepare("SELECT points FROM weekly_bonuses WHERE type='sport_place'").get().points,20);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_standings').get().n,1);assert.equal((await f.call('alice','v2/dashboard')).data.points,20);
});
test('dirty revision preserves a reward arriving between job selection and its transaction',async t=>{
  const f=fixture(t);await f.profile('alice');const week='2026-10-19';
  const reward=date=>{f.db.sqlite.prepare('INSERT INTO daily_progress VALUES(?,?,10)').run('alice',date);f.db.sqlite.prepare('INSERT INTO daily_rewards(user_id,local_date,awarded_at) VALUES(?,?,?)').run('alice',date,f.now);};
  reward(week);const selected=f.db.sqlite.prepare('SELECT * FROM weekly_dirty').get();
  reward(addDays(week,1));await reconcileUserWeek(f.db,'alice',week,f.now,selected.revision);
  assert.ok(f.db.sqlite.prepare('SELECT * FROM weekly_dirty').get());
  await runMaintenance(f.db,f.now);assert.equal(f.db.sqlite.prepare('SELECT * FROM weekly_dirty').get(),undefined);
});
test('bounded cron resumes after long absence and repeated execution never doubles a bonus',async t=>{
  const f=fixture(t);for(let i=0;i<6;i++)await f.profile('user'+i);
  f.now=weekWindow('2026-12-28').endsAt+15001;
  let r=await runMaintenance(f.db,f.now,{userLimit:2,periodLimit:2});assert.equal(r.pending,true);assert.ok(r.closed<=2);
  let attempts=0;while(r.pending&&attempts++<100)r=await runMaintenance(f.db,f.now,{userLimit:2,periodLimit:2});
  assert.equal(r.pending,false);assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM weekly_summaries WHERE user_id='user5'").get().n,11);
  const dashboard=(await f.call('user0','v2/dashboard')).data;assert.equal(dashboard.weekly.summaries.length,4);
  const ack=(await f.call('user0','v2/weeks/seen',{week:'2026-10-19',total:0})).data;assert.equal(ack.state.weekly.summaries.find(s=>s.week==='2026-10-19').seen,true);
  const count=f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_summaries').get().n;await runMaintenance(f.db,f.now);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM weekly_summaries').get().n,count);
});
test('scheduled Worker uses durable maintenance without any authenticated visitor',async t=>{
  const f=fixture(t);await f.profile('alice');f.now=weekWindow('2026-10-19').endsAt+15001;
  let pending;const r=await worker.scheduled({scheduledTime:f.now},{DB:f.db},{waitUntil:p=>pending=p});await pending;assert.equal(r.closed,1);
});

test('large ranking returns 200 rows plus own position, with SQL handling ties and the full participant count',async t=>{
  const f=fixture(t);
  for(let i=0;i<250;i++){
    const u='user-'+String(i).padStart(3,'0');
    f.db.sqlite.prepare('INSERT INTO profiles(user_id,display_name,time_zone,created_at) VALUES(?,?,?,?)').run(u,u,'UTC',f.now);
    f.db.sqlite.prepare("INSERT INTO rounds(id,user_id,start_request_id,kind,rules_version,status,starts_at,ends_at,finished_at,count) VALUES(?,?,?,'personal','squat-v1','completed',?,?,?,?)").run(crypto.randomUUID(),u,crypto.randomUUID(),f.now-60000,f.now,f.now,250-i);
  }
  let returned=0;const connection={prepare:q=>f.db.prepare(q),batch:async ss=>{const r=await f.db.batch(ss);returned+=r.reduce((n,v)=>n+v.results.length,0);return r;}};
  const board=(await f.call('user-249','leaderboards',undefined,connection)).data;
  assert.equal(board.totalParticipants,250);assert.equal(board.entries.length,200);assert.equal(board.you.place,250);assert.ok(returned<=202);
  assert.deepEqual(Object.keys(board.you).sort(),['isYou','name','place','value']);
});
