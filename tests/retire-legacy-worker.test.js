import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {VERSION} from '../src/config.js';
import {canonicalDeployment} from '../scripts/deploy-backend.mjs';
import {retireLegacyWorker} from '../scripts/retire-legacy-worker.mjs';

const legacyId='11111111-1111-4111-8111-111111111111';
const canonicalId='22222222-2222-4222-8222-222222222222';
const activity=['competitions','rounds','daily_progress','daily_rewards','repetition_events','weekly_standings','weekly_participants','weekly_bonuses','weekly_summaries'];
const profile={user_id:'private-user-id',display_name:'PRIVATE DISPLAY NAME',time_zone:'Africa/Johannesburg',created_at:123,rankings_enabled:1,rankings_excluded:0};
const session={token_hash:'a'.repeat(64),user_id:profile.user_id,created_at:123,revoked_at:null};
const privateMarkers=[profile.user_id,profile.display_name,session.token_hash,'PRIVATE TEXT VALUE','PRIVATE SECRET VALUE','PRIVATE ASSET JWT'];

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'movement-retirement-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'work/backend'),{recursive:true});
  await mkdir(join(root,'work/server-consolidation'),{recursive:true});
  const config=JSON.parse(await readFile(new URL('../wrangler.backend.json',import.meta.url),'utf8'));
  const env={GITHUB_REF:'refs/heads/main',GITHUB_SHA:'b'.repeat(40),CLOUDFLARE_ACCOUNT_ID:'c'.repeat(32),CLOUDFLARE_API_TOKEN:'private-deployment-token-not-for-backups'};
  const deployment={service:canonicalDeployment.worker,database:canonicalDeployment.database,url:canonicalDeployment.url,version:VERSION,commit:env.GITHUB_SHA,checks:{health:true,anonymousRejected:true,guestState:true,logout:true}};
  const imported={success:true,status:'completed',canonical:{worker:canonicalDeployment.worker,database:canonicalDeployment.database,databaseId:canonicalId},legacy:{worker:'movement-test-api',database:'movement-test-app',databaseId:legacyId},counts:{profiles:1,sessions:1},sourceUnchanged:true,existingRowsUnchanged:true};
  await writeFile(join(root,'wrangler.backend.json'),JSON.stringify(config));
  await writeFile(join(root,'work/backend/deployment.json'),JSON.stringify(deployment));
  await writeFile(join(root,'work/server-consolidation/identity-import.json'),JSON.stringify(imported));
  const state={
    config,env,deployment,imported,
    subdomain:canonicalDeployment.subdomain,
    health:{ok:true,version:VERSION,authentication:'device-token'},
    workers:new Set([canonicalDeployment.worker,'movement-test-api']),
    tables:['profiles','device_sessions',...activity,'weekly_settings','weekly_periods','d1_migrations'],
    counts:Object.fromEntries(activity.map(name=>[name,0])),
    profiles:[structuredClone(profile)],sessions:[structuredClone(session)],
    canonicalProfiles:[structuredClone(profile)],canonicalSessions:[structuredClone(session)],
    code:Buffer.from('export default {fetch(){return new Response("legacy service");}};'),
    contentType:'application/javascript',
    settings:{compatibility_date:'2026-05-15',compatibility_flags:['nodejs_compat'],bindings:[
      {name:'DB',type:'d1',id:legacyId},
      {name:'PLAIN_CONFIG',type:'plain_text',text:'PRIVATE TEXT VALUE'},
      {name:'PRIVATE_KEY',type:'secret_text',text:'PRIVATE SECRET VALUE'},
      {name:'ASSETS',type:'assets',jwt:'PRIVATE ASSET JWT'},
    ],assets:{jwt:'PRIVATE ASSET JWT'}},
    calls:[],healthCalls:0,waits:[],onWait:null,
  };
  const response=result=>Response.json({success:true,result});
  const request=async(url,options={})=>{
    const parsed=new URL(url),method=options.method||'GET';
    state.calls.push({url,method,body:options.body});
    if(parsed.origin===canonicalDeployment.url){
      assert.equal(parsed.pathname,'/api/health');
      assert.equal(options.headers.Authorization,undefined,'Cloudflare credentials must not reach the public API');
      state.healthCalls++;
      return Response.json(state.health);
    }
    assert.equal(parsed.origin,'https://api.cloudflare.com');
    const path=parsed.pathname.replace(`/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`,'');
    if(path==='/workers/subdomain')return response({subdomain:state.subdomain});
    if(path==='/d1/database')return response([{name:'movement-test-app',uuid:legacyId},{name:canonicalDeployment.database,uuid:canonicalId}]);
    if(path==='/workers/scripts')return response([...state.workers].map(id=>({id})));
    if(path==='/workers/scripts/movement-test-api/settings')return response(state.settings);
    if(path==='/workers/scripts/movement-test-api'){
      if(method==='GET')return new Response(state.code,{headers:{'Content-Type':state.contentType}});
      assert.equal(method,'DELETE');
      state.workers.delete('movement-test-api');
      return response(null);
    }
    const dbPath=path.match(/^\/d1\/database\/([^/]+)\/query$/);
    if(dbPath){
      assert.equal(method,'POST');
      const {sql,params}=JSON.parse(options.body);
      assert.match(sql,/^SELECT /,'Retirement must never write either D1 database');
      let rows;
      if(dbPath[1]===legacyId){
        if(sql.includes('FROM sqlite_schema'))rows=state.tables.map(name=>({name}));
        else if(sql.startsWith('SELECT COUNT(*)')){
          const table=sql.match(/FROM "([^"]+)"/)[1];
          rows=[{count:table==='profiles'?state.profiles.length:table==='device_sessions'?state.sessions.length:state.counts[table]||0}];
        }
        else if(sql.includes('FROM profiles'))rows=state.profiles;
        else if(sql.includes('FROM device_sessions'))rows=state.sessions;
      }else{
        assert.equal(dbPath[1],canonicalId);
        if(sql.includes('FROM profiles'))rows=state.canonicalProfiles.filter(row=>params.includes(row.user_id));
        else if(sql.includes('FROM device_sessions'))rows=state.canonicalSessions.filter(row=>params.includes(row.token_hash));
      }
      assert.ok(rows,'Unexpected database query in retirement test');
      return response([{success:true,results:structuredClone(rows)}]);
    }
    assert.fail('Unexpected Cloudflare request in retirement test');
  };
  return {root,state,run:phase=>retireLegacyWorker({phase,root,env:state.env,request,wait:async ms=>{state.waits.push(ms);await state.onWait?.(ms);},now:()=> '2026-10-23T15:00:00.000Z'}),backupDir:join(root,'work/server-consolidation/legacy-worker-backup')};
}

function multipart(boundary,{moduleName='worker.js',moduleBytes=Buffer.from('export default {fetch(){return new Response("legacy");}};')}={}){
  const parts=[['metadata',Buffer.from('{"main_module":"worker.js"}'),'application/json'],[moduleName,moduleBytes,'application/javascript'],['binary.wasm',Buffer.from([0,97,115,109,255,13,10,128]),'application/wasm']];
  return Buffer.concat(parts.flatMap(([name,bytes,type])=>[
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),bytes,Buffer.from('\r\n'),
  ]).concat(Buffer.from(`--${boundary}--\r\n`)));
}

test('retirement rejects non-main execution, the wrong release and the wrong account or health',async t=>{
  for(const mode of ['branch','release','config','account','health','import'])await t.test(mode,async t=>{
    const f=await fixture(t);
    if(mode==='branch')f.state.env.GITHUB_REF='refs/heads/task';
    if(mode==='release'){
      f.state.deployment.commit='d'.repeat(40);
      await writeFile(join(f.root,'work/backend/deployment.json'),JSON.stringify(f.state.deployment));
    }
    if(mode==='config'){
      f.state.config.name='movement-test-api';
      await writeFile(join(f.root,'wrangler.backend.json'),JSON.stringify(f.state.config));
    }
    if(mode==='account')f.state.subdomain='other-account';
    if(mode==='health')f.state.health.version='2.5.2';
    if(mode==='import'){
      f.state.imported.status='prepared';
      await writeFile(join(f.root,'work/server-consolidation/identity-import.json'),JSON.stringify(f.state.imported));
    }
    await assert.rejects(f.run('backup'),/main|release|canonical|import/i);
    assert.equal(f.state.calls.some(call=>call.method==='DELETE'),false);
  });
});

test('nonempty sporting data, unknown user data and unpreserved identities block retirement',async t=>{
  for(const mode of ['sport','unknown-table','profile','session'])await t.test(mode,async t=>{
    const f=await fixture(t);
    if(mode==='sport')f.state.counts.repetition_events=1;
    if(mode==='unknown-table'){f.state.tables.push('private_training');f.state.counts.private_training=1;}
    if(mode==='profile')f.state.canonicalProfiles=[];
    if(mode==='session')f.state.canonicalSessions[0].revoked_at=456;
    await assert.rejects(f.run('backup'),/user data|identities/);
    assert.equal(f.state.calls.some(call=>call.method==='DELETE'),false);
  });
});

test('backup preserves raw Worker bytes and content type but exports only safe binding metadata',async t=>{
  const f=await fixture(t);
  const report=await f.run('backup');
  assert.equal(report.status,'backed-up');
  assert.equal(f.state.calls.some(call=>call.method==='DELETE'),false);
  assert.deepEqual(await readFile(join(f.backupDir,'worker.bundle')),f.state.code);
  const manifest=JSON.parse(await readFile(join(f.backupDir,'manifest.json'),'utf8'));
  assert.equal(manifest.code.contentType,f.state.contentType);
  const settingsText=await readFile(join(f.backupDir,'settings.safe.json'),'utf8');
  const settings=JSON.parse(settingsText);
  assert.deepEqual(settings.bindings.find(binding=>binding.name==='DB'),{name:'DB',type:'d1',databaseId:legacyId});
  assert.deepEqual(settings.bindings.find(binding=>binding.name==='PLAIN_CONFIG'),{name:'PLAIN_CONFIG',type:'plain_text'});
  for(const marker of [...privateMarkers,f.state.env.CLOUDFLARE_API_TOKEN]){
    assert.equal((settingsText+JSON.stringify(manifest)+JSON.stringify(report)).includes(marker),false);
  }
});

test('deletion requires a complete verified backup',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run('retire'),/complete legacy Worker backup is required/);
  assert.equal(f.state.calls.some(call=>call.method==='DELETE'),false);
});

test('retirement deletes only the exact old Worker after backup, leaves D1 unchanged and verifies canonical health',async t=>{
  const f=await fixture(t);
  const before=structuredClone({profiles:f.state.profiles,sessions:f.state.sessions,canonicalProfiles:f.state.canonicalProfiles,canonicalSessions:f.state.canonicalSessions,counts:f.state.counts});
  await f.run('backup');
  const report=await f.run('retire');
  assert.equal(report.status,'retired');
  assert.equal(report.legacyDatabaseUnchanged,true);
  assert.equal(f.state.healthCalls,3);
  assert.deepEqual(f.state.waits,[30000]);
  const deletes=f.state.calls.filter(call=>call.method==='DELETE');
  assert.deepEqual(deletes.map(call=>new URL(call.url).pathname),[`/client/v4/accounts/${f.state.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/movement-test-api`]);
  assert.deepEqual({profiles:f.state.profiles,sessions:f.state.sessions,canonicalProfiles:f.state.canonicalProfiles,canonicalSessions:f.state.canonicalSessions,counts:f.state.counts},before);
  assert.equal(f.state.workers.has(canonicalDeployment.worker),true);
  assert.equal(f.state.workers.has('movement-test-api'),false);
  const saved=JSON.parse(await readFile(join(f.root,'work/server-consolidation/retirement.json'),'utf8'));
  assert.equal(saved.status,'retired');
  for(const marker of privateMarkers)assert.equal(JSON.stringify(saved).includes(marker),false);
});

test('multipart backup preserves raw bytes while changing the outer boundary does not block retirement',async t=>{
  const f=await fixture(t);
  f.state.code=multipart('first-random-boundary');
  f.state.contentType='multipart/form-data; boundary="first-random-boundary"';
  const original=Buffer.from(f.state.code);
  await f.run('backup');
  assert.deepEqual(await readFile(join(f.backupDir,'worker.bundle')),original);
  f.state.code=multipart('another-random-boundary');
  f.state.contentType='multipart/form-data; boundary=another-random-boundary';
  const report=await f.run('retire');
  assert.equal(report.status,'retired');
  assert.deepEqual(await readFile(join(f.backupDir,'worker.bundle')),original);
});

test('multipart module bytes and names remain part of the guarded Worker identity',async t=>{
  for(const mode of ['module-bytes','module-name'])await t.test(mode,async t=>{
    const f=await fixture(t);
    f.state.code=multipart('first');
    f.state.contentType='multipart/form-data; boundary=first';
    await f.run('backup');
    f.state.code=multipart('second',mode==='module-bytes'?{moduleBytes:Buffer.from('changed module')}:{moduleName:'renamed.js'});
    f.state.contentType='multipart/form-data; boundary=second';
    await assert.rejects(f.run('retire'),/changed after backup/);
    assert.equal(f.state.calls.some(call=>call.method==='DELETE'),false);
  });
});

test('late legacy or canonical changes fail post-removal verification and retain D1 for recovery',async t=>{
  for(const mode of ['sport','metadata-count','profile','canonical-session','schema'])await t.test(mode,async t=>{
    const f=await fixture(t);
    await f.run('backup');
    f.state.onWait=ms=>{
      assert.equal(ms,30000);
      assert.equal(f.state.workers.has('movement-test-api'),false);
      if(mode==='sport')f.state.counts.repetition_events=1;
      if(mode==='metadata-count')f.state.counts.weekly_periods=1;
      if(mode==='profile')f.state.profiles[0].display_name='late profile change';
      if(mode==='canonical-session')f.state.canonicalSessions[0].revoked_at=999;
      if(mode==='schema')f.state.tables.push('new_user_table');
    };
    await assert.rejects(f.run('retire'),/post-retirement verification failed/);
    const report=JSON.parse(await readFile(join(f.root,'work/server-consolidation/retirement.json'),'utf8'));
    assert.equal(report.success,false);
    assert.equal(report.status,'verification-failed');
    assert.equal(report.legacyDatabaseUnchanged,true);
    assert.equal(f.state.calls.filter(call=>call.method==='DELETE').length,1);
    assert.equal(f.state.calls.some(call=>call.method==='DELETE'&&call.url.includes('/d1/')),false);
    for(const marker of privateMarkers)assert.equal(JSON.stringify(report).includes(marker),false);
  });
});

test('retirement revalidates sporting data, identities, code and backup integrity after backup',async t=>{
  for(const mode of ['sport','identity','code','tampered-backup'])await t.test(mode,async t=>{
    const f=await fixture(t);
    await f.run('backup');
    if(mode==='sport')f.state.counts.rounds=1;
    if(mode==='identity')f.state.canonicalProfiles[0].display_name='changed';
    if(mode==='code')f.state.code=Buffer.from('changed worker code');
    if(mode==='tampered-backup')await writeFile(join(f.backupDir,'worker.bundle'),'tampered backup');
    await assert.rejects(f.run('retire'),/user data|identities|changed after backup|integrity/);
    assert.equal(f.state.calls.some(call=>call.method==='DELETE'),false);
  });
});

test('an already absent legacy Worker is idempotent and never causes another deletion',async t=>{
  const f=await fixture(t);
  f.state.workers.delete('movement-test-api');
  const report=await f.run('retire');
  assert.equal(report.status,'already-retired');
  assert.equal(f.state.calls.some(call=>call.method==='DELETE'),false);
  assert.equal(f.state.workers.has(canonicalDeployment.worker),true);
});
