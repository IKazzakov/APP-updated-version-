import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTestDatabase} from './server-db.js';
import {planIdentityImport,validateIdentityImport,importLegacyIdentities,consolidateLegacyIdentities} from '../scripts/consolidate-legacy-identities.mjs';

function fixture(t){
  const old=new DatabaseSync(':memory:');old.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0000_squat_mvp.sql','0001_weekly_rankings.sql','0002_ranking_defaults_duel_cancel.sql','0003_device_sessions.sql'])old.exec(readFileSync(new URL(`../drizzle/${name}`,import.meta.url),'utf8'));
  const current=createTestDatabase();t.after(()=>{old.close();current.close();});
  const profile=(db,id,name)=>db.prepare('INSERT INTO profiles(user_id,display_name,time_zone,created_at,rankings_enabled,rankings_excluded) VALUES(?,?,?,?,?,?)').run(id,name,'Africa/Johannesburg',1,1,0);
  profile(old,'legacy_profile','Private legacy name');profile(current.sqlite,'current_profile','Private current name');
  const session=(db,token,id,revoked)=>db.prepare('INSERT INTO device_sessions(token_hash,user_id,created_at,revoked_at) VALUES(?,?,?,?)').run(token.repeat(64),id,1,revoked);
  session(old,'a','legacy_profile',null);session(old,'b','legacy_revoked_guest',2);session(old,'c','legacy_another_revoked',3);
  session(current.sqlite,'d','current_profile',null);
  current.sqlite.prepare('INSERT INTO repetition_events(user_id,id,occurred_at,local_date,received_at) VALUES(?,?,?,?,?)').run('current_profile','already_saved',1,'2026-10-23',1);
  const snap=db=>({tables:Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]))});
  const execute=statement=>current.sqlite.prepare(statement.sql).run(...statement.params);
  return {old,current:current.sqlite,snap,execute,profile,session};
}

test('identity import preserves current progress and revoked sessions, and is idempotent without doubled aggregates',t=>{
  const f=fixture(t),source=f.snap(f.old),before=f.snap(f.current),plan=planIdentityImport(source,before);
  assert.equal(plan.profiles.length,1);assert.equal(plan.sessions.length,3);
  for(const statement of plan.statements)f.execute(statement);
  const after=f.snap(f.current);
  assert.deepEqual(validateIdentityImport(source,f.snap(f.old),before,after,plan),{sourceUnchanged:true,existingRowsUnchanged:true});
  assert.equal(f.current.prepare('SELECT count FROM daily_progress WHERE user_id=?').get('current_profile').count,1);
  assert.equal(f.current.prepare('SELECT COUNT(*) AS n FROM repetition_events').get().n,1);
  assert.equal(f.current.prepare('SELECT revoked_at FROM device_sessions WHERE user_id=?').get('legacy_revoked_guest').revoked_at,2);
  assert.equal(f.current.prepare('SELECT COUNT(*) AS n FROM user_totals WHERE user_id=?').get('legacy_profile').n,1);
  assert.equal(f.current.prepare('SELECT COUNT(*) AS n FROM ranking_consent WHERE user_id=?').get('legacy_profile').n,1);
  const again=planIdentityImport(source,after);assert.equal(again.statements.length,0);
  validateIdentityImport(source,f.snap(f.old),after,f.snap(f.current),again);
});

test('identity validation allows only the zero activity row created by the new profile trigger',t=>{
  const f=fixture(t),source=f.snap(f.old),before=f.snap(f.current),plan=planIdentityImport(source,before);
  for(const statement of plan.statements)f.execute(statement);
  const after=f.snap(f.current);
  assert.deepEqual({...f.current.prepare('SELECT * FROM activity_totals WHERE user_id=?').get('legacy_profile')},{user_id:'legacy_profile',total_xp:0,revision:0});
  validateIdentityImport(source,f.snap(f.old),before,after,plan);
  const invalid=structuredClone(after);
  invalid.tables.activity_totals.find(row=>row.user_id==='legacy_profile').total_xp=1;
  assert.throws(()=>validateIdentityImport(source,f.snap(f.old),before,invalid,plan),/Canonical existing data changed/);
});

test('partial imports resume safely without replacing profiles or creating another session',t=>{
  const f=fixture(t),source=f.snap(f.old),first=planIdentityImport(source,f.snap(f.current));
  f.execute(first.statements[0]);f.execute(first.statements[1]);
  const before=f.snap(f.current),remaining=planIdentityImport(source,before);
  assert.equal(remaining.profiles.length,0);assert.equal(remaining.sessions.length,2);
  for(const statement of remaining.statements)f.execute(statement);
  validateIdentityImport(source,f.snap(f.old),before,f.snap(f.current),remaining);
  assert.equal(planIdentityImport(source,f.snap(f.current)).statements.length,0);
});

test('profile, token and cross-table owner conflicts are rejected before any writes',t=>{
  const f=fixture(t),source=f.snap(f.old),original=f.snap(f.current);
  for(const change of [
    destination=>destination.tables.profiles.push({...source.tables.profiles[0],display_name:'Different private name'}),
    destination=>destination.tables.device_sessions.push({...source.tables.device_sessions[0],user_id:'other_profile'}),
    destination=>destination.tables.device_sessions.push({...source.tables.device_sessions[0],token_hash:'e'.repeat(64)}),
    destination=>destination.tables.device_sessions.push({token_hash:'e'.repeat(64),user_id:'legacy_profile',created_at:7,revoked_at:null}),
  ]){
    const destination=structuredClone(original);change(destination);
    assert.throws(()=>planIdentityImport(source,destination),/conflict/i);
    assert.deepEqual(f.snap(f.current),original);
  }
  const orphanSource=structuredClone(source);orphanSource.tables.device_sessions.push({token_hash:'f'.repeat(64),user_id:'current_profile',created_at:1,revoked_at:null});
  assert.throws(()=>planIdentityImport(orphanSource,original),/conflict/i);
});

test('any legacy training or weekly user data blocks the identity-only plan',t=>{
  const f=fixture(t),source=f.snap(f.old),before=f.snap(f.current);
  for(const table of ['daily_progress','repetition_events','rounds','competitions','daily_rewards','weekly_bonuses','weekly_standings','weekly_participants','weekly_summaries']){
    const changed=structuredClone(source);changed.tables[table].push({private:'not logged'});
    assert.throws(()=>planIdentityImport(changed,before),/not empty/);
  }
  const missing=structuredClone(source);delete missing.tables.rounds;
  assert.throws(()=>planIdentityImport(missing,before),/inventory is incomplete/);
  assert.deepEqual(f.snap(f.current),before);
});

test('source activity and identity collisions invalidate old success and stop orchestration before writes',async t=>{
  const f=fixture(t),source=f.snap(f.old),before=f.snap(f.current);
  for(const mode of ['activity','identity-conflict']){
    const changed=structuredClone(source),destination=structuredClone(before),reports=[];
    if(mode==='activity')changed.tables.repetition_events.push({id:'synthetic'});
    else destination.tables.profiles.push({...source.tables.profiles[0],display_name:'Conflicting synthetic name'});
    await assert.rejects(importLegacyIdentities({readLegacy:async()=>changed,readCanonical:async()=>destination,bookmarkLegacy:async()=>assert.fail('Invalid data must stop before bookmarking'),bookmarkCanonical:async()=>assert.fail('Invalid data must stop before bookmarking'),executeCanonical:async()=>assert.fail('Invalid data must never be inserted'),checkpoint:async report=>reports.push(report)}),/not empty|conflict/);
    assert.deepEqual(reports,[{success:false,status:'validating'}]);
    assert.deepEqual(f.snap(f.current),before);
  }
});

test('both Time Travel bookmarks are mandatory and missing backup prevents every insert',async t=>{
  const f=fixture(t);let writes=0;
  await assert.rejects(importLegacyIdentities({readLegacy:async()=>f.snap(f.old),readCanonical:async()=>f.snap(f.current),bookmarkLegacy:async()=>({bookmark:'legacy-bookmark'}),bookmarkCanonical:async()=>({}),executeCanonical:async()=>{writes++;}}),/bookmarks are required/);
  assert.equal(writes,0);
});

test('orchestration preserves source, safely resumes an interrupted import, and reports only aggregate counts',async t=>{
  const f=fixture(t),source=f.snap(f.old),reports=[];let calls=0,reads=0;
  const reorder=snapshot=>{if(Math.floor(reads++/2)%2===1)for(const rows of Object.values(snapshot.tables))rows.reverse();return snapshot;};
  const deps={readLegacy:async()=>reorder(f.snap(f.old)),readCanonical:async()=>reorder(f.snap(f.current)),bookmarkLegacy:async()=>({bookmark:'legacy-bookmark'}),bookmarkCanonical:async()=>({bookmark:'canonical-bookmark'}),checkpoint:async report=>reports.push(report)};
  await assert.rejects(importLegacyIdentities({...deps,executeCanonical:async statement=>{if(++calls===3)throw new Error('Synthetic transport interruption');f.execute(statement);}}),/Synthetic/);
  assert.equal(reports.at(-1).status,'failed');
  const report=await importLegacyIdentities({...deps,executeCanonical:async statement=>f.execute(statement)});
  assert.equal(report.success,true);assert.equal(report.sourceUnchanged,true);assert.equal(report.existingRowsUnchanged,true);
  assert.equal(report.counts.profiles,1);assert.equal(report.counts.sessions,3);
  const text=JSON.stringify(reports);
  for(const privateValue of ['legacy_profile','current_profile','Private legacy name','Private current name','a'.repeat(64),'b'.repeat(64)])assert.equal(text.includes(privateValue),false);
  assert.deepEqual(f.snap(f.old),source);
  const again=await importLegacyIdentities({...deps,executeCanonical:async()=>assert.fail('Idempotent import must not write')});
  assert.equal(again.counts.insertedProfiles,0);assert.equal(again.counts.insertedSessions,0);
});

test('verification rejects concurrent changes to the source or existing canonical progress',t=>{
  const f=fixture(t),source=f.snap(f.old),before=f.snap(f.current),plan=planIdentityImport(source,before);
  for(const statement of plan.statements)f.execute(statement);
  const after=f.snap(f.current),sourceChanged=structuredClone(source),currentChanged=structuredClone(after);
  sourceChanged.tables.profiles[0].display_name='Concurrent change';
  assert.throws(()=>validateIdentityImport(source,sourceChanged,before,after,plan),/Legacy source changed/);
  currentChanged.tables.daily_progress[0].count++;
  assert.throws(()=>validateIdentityImport(source,source,before,currentChanged,plan),/Canonical existing data changed/);
});

test('Cloudflare account mismatch and absent or ambiguous exact databases stop without creating resources',async()=>{
  for(const mode of ['wrong-account','missing-database','ambiguous-database']){
    const methods=[];
    const request=async(url,options)=>{
      methods.push(options.method||'GET');
      const list=[{name:'movement-test-app',uuid:crypto.randomUUID()}];
      if(mode!=='missing-database')list.push({name:'movement-test-app-staging',uuid:crypto.randomUUID()});
      if(mode==='ambiguous-database')list.push({name:'movement-test-app-staging',uuid:crypto.randomUUID()});
      return new Response(JSON.stringify({success:true,result:url.endsWith('/workers/subdomain')?{subdomain:mode==='wrong-account'?'another-account':'rojoscarlos93'}:list}));
    };
    await assert.rejects(consolidateLegacyIdentities({accountId:'a'.repeat(32),token:'synthetic',request}),/account|existing database/);
    assert.ok(methods.every(method=>method==='GET'));
  }
});

test('Cloudflare transport imports only exact existing canonical D1 and saves an aggregate private checkpoint',async t=>{
  const f=fixture(t),directory=await mkdtemp(join(tmpdir(),'movement-consolidation-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const outputPath=join(directory,'identity-import.json'),accountId='a'.repeat(32);
  const sourceId='11111111-1111-4111-8111-111111111111',currentId='22222222-2222-4222-8222-222222222222';
  const source=f.snap(f.old),before=f.snap(f.current),bookmarks=[],insertTargets=[];
  const request=async(url,options)=>{
    const parsed=new URL(url),prefix=`/client/v4/accounts/${accountId}`;
    assert.equal(parsed.origin,'https://api.cloudflare.com');assert.ok(parsed.pathname.startsWith(prefix));
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic');
    const path=parsed.pathname.slice(prefix.length);
    let result;
    if(path==='/workers/subdomain')result={subdomain:'rojoscarlos93'};
    else if(path==='/d1/database')result=[{name:'movement-test-app',uuid:sourceId},{name:'movement-test-app-staging',uuid:currentId}];
    else if(path.endsWith('/time_travel/bookmark')){
      const id=path.split('/')[3];assert.ok(id===sourceId||id===currentId);bookmarks.push(id);result={bookmark:id===sourceId?'legacy-bookmark':'canonical-bookmark'};
    }else{
      assert.equal(options.method,'POST');
      const match=path.match(/^\/d1\/database\/([^/]+)\/query$/);assert.ok(match);
      const id=match[1],db=id===sourceId?f.old:id===currentId?f.current:null;assert.ok(db);
      const {sql,params}=JSON.parse(options.body);
      result=sql.split(';').map(statement=>{
        const query=db.prepare(statement);
        if(/^SELECT /i.test(statement))return {success:true,results:query.all(...params)};
        assert.equal(bookmarks.length,2);assert.ok(statement.startsWith('INSERT INTO '));assert.ok(statement.endsWith('ON CONFLICT DO NOTHING'));
        insertTargets.push(id);query.run(...params);return {success:true,results:[]};
      });
    }
    return new Response(JSON.stringify({success:true,result}));
  };
  const report=await consolidateLegacyIdentities({accountId,token:'synthetic',request,outputPath});
  const saved=JSON.parse(await readFile(outputPath,'utf8'));
  assert.deepEqual(saved,report);assert.equal(report.success,true);assert.equal(report.status,'completed');
  assert.deepEqual(report.canonical,{worker:'movement-test-api-staging',database:'movement-test-app-staging',databaseId:currentId});
  assert.deepEqual(report.legacy,{worker:'movement-test-api',database:'movement-test-app',databaseId:sourceId});
  assert.equal(insertTargets.length,4);assert.ok(insertTargets.every(id=>id===currentId));
  assert.equal(report.counts.insertedProfiles,1);assert.equal(report.counts.insertedSessions,3);
  assert.deepEqual(f.snap(f.old),source);
  validateIdentityImport(source,f.snap(f.old),before,f.snap(f.current),planIdentityImport(source,before));
  const serialized=JSON.stringify(saved);
  for(const privateValue of ['legacy_profile','current_profile','Private legacy name','Private current name','a'.repeat(64),'b'.repeat(64)])assert.equal(serialized.includes(privateValue),false);
});
