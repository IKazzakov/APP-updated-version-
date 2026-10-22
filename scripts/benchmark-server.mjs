// Isolated synthetic SQLite benchmark; never connects to a deployed database.
import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createTestDatabase} from '../tests/server-db.js';
import {handleApi} from '../server/api.js';
import {sportsWeek,weekWindow,addDays} from '../server/weeks.js';

const now=Date.parse('2026-10-22T12:00:00Z'),current=sportsWeek(now);
const outputFlag=process.argv.indexOf('--output');
const output=outputFlag>=0?process.argv[outputFlag+1]:'work/benchmarks/server.json';
if(!output)throw new Error('Specify a path after --output.');
const v2=process.argv.includes('--v2'),samples=5,results=[];
for(const users of [100,1000])for(const weeks of [12,52]){
  const db=createTestDatabase(),s=db.sqlite,first=addDays(current,-7*weeks);
  const profile=s.prepare('INSERT INTO profiles(user_id,display_name,time_zone,created_at) VALUES(?,?,?,?)');
  const period=s.prepare('INSERT INTO weekly_periods(week,starts_at,ends_at,rules_version,closed_at) VALUES(?,?,?,?,?)');
  const progress=s.prepare('INSERT INTO daily_progress VALUES(?,?,10)');
  const reward=s.prepare('INSERT INTO daily_rewards(user_id,local_date,awarded_at) VALUES(?,?,?)');
  const round=s.prepare("INSERT INTO rounds(id,user_id,start_request_id,kind,rules_version,status,starts_at,ends_at,finished_at,count) VALUES(?,?,?,'personal','squat-v1','completed',?,?,?,?)");
  s.exec('BEGIN');
  s.prepare('INSERT INTO weekly_settings VALUES(1,?,?)').run(weekWindow(first).startsAt,first);
  for(let w=0;w<=weeks;w++){const date=addDays(first,7*w),p=weekWindow(date);period.run(date,p.startsAt,p.endsAt,'squat-v1',w<weeks?p.endsAt+15001:null);}
  for(let u=0;u<users;u++){
    const user=`user-${String(u).padStart(5,'0')}`;profile.run(user,user,'UTC',weekWindow(first).startsAt-1);
    for(let w=0;w<weeks;w++){
      const week=addDays(first,7*w),end=weekWindow(week).startsAt+3600000;
      round.run(crypto.randomUUID(),user,crypto.randomUUID(),end-60000,end,end,10+u%30);
      for(let day=0;day<7;day++){const date=addDays(week,day);progress.run(user,date);reward.run(user,date,end);}
    }
  }
  s.exec('COMMIT');
  // Warm the existing-data reconciliation once, outside measured hot requests.
  if(!v2)await call('state');
  else {const {runMaintenance}=await import('../server/maintenance.js');let run;do{run=await runMaintenance(db,now,{userLimit:500,periodLimit:8});}while(run.pending);}
  let statements=0,returned=0;
  function track(st){return {bind(...a){return track(st.bind(...a));},async first(...a){statements++;const r=await st.first(...a);if(r)returned++;return r;},async all(){statements++;const r=await st.all();returned+=r.results?.length||0;return r;},async run(){statements++;return st.run();},_source:st};}
  const measured={prepare:sql=>track(db.prepare(sql)),batch:async ss=>{statements+=ss.length;const r=await db.batch(ss.map(x=>x._source));returned+=r.reduce((n,x)=>n+(x.results?.length||0),0);return r;}};
  async function call(path,body,connection=db){return handleApi(new Request(`https://bench.invalid/api/${path}`,{method:body?'POST':'GET',headers:{'oai-authenticated-user-id':'user-00000',origin:'https://bench.invalid','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),{DB:connection},{now:()=>now});}
  for(const scenario of ['dashboard','save-1','save-10','save-50','leaderboard']){
    const times=[],bytes=[],queries=[],rows=[];
    for(let i=0;i<samples;i++){
      statements=0;returned=0;
      const count=scenario.startsWith('save-')?Number(scenario.slice(5)):0;
      const path=scenario==='dashboard'?(v2?'v2/dashboard':'state'):scenario==='leaderboard'?'leaderboards':(v2?'v2/repetitions':'repetitions');
      const body=count?{events:Array.from({length:count},()=>({id:crypto.randomUUID(),occurredAt:now}))}:undefined;
      const start=performance.now(),response=await call(path,body,measured),text=await response.text();
      if(response.status!==200)throw new Error(`${scenario}: ${text}`);
      times.push(performance.now()-start);bytes.push(Buffer.byteLength(text));queries.push(statements);rows.push(returned);
    }
    times.sort((a,b)=>a-b);
    results.push({users,weeks,scenario,samples,p50Ms:+times[2].toFixed(2),p95Ms:+times[4].toFixed(2),responseBytes:Math.max(...bytes),apiSqlStatements:Math.max(...queries),returnedRows:Math.max(...rows)});
    console.log(JSON.stringify(results.at(-1)));
  }
  db.close();
}
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({engine:'Node SQLite, in-memory, one process; no network or phone timing',samples,note:'p95 is the maximum of five samples, not a production capacity estimate. Counts cover API-issued SQL, not statements inside triggers or scanned rows.',api:v2?'v2':'2.5.2',results},null,2)+'\n');
