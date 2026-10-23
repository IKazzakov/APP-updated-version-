import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {VERSION} from '../src/config.js';
import {canonicalDeployment,validateDeploymentConfig} from './deploy-backend.mjs';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const legacy=Object.freeze({worker:'movement-test-api',database:'movement-test-app'});
const profileColumns=['user_id','display_name','time_zone','created_at','rankings_enabled','rankings_excluded'];
const sessionColumns=['token_hash','user_id','created_at','revoked_at'];
const activityTables=['competitions','rounds','daily_progress','daily_rewards','repetition_events','weekly_standings','weekly_participants','weekly_bonuses','weekly_summaries'];
const metadataTables=new Set(['weekly_settings','weekly_periods','d1_migrations']);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash=data=>createHash('sha256').update(data).digest('hex');
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const requireCheck=(condition,message)=>{if(!condition)throw new Error(message);};

function codeIdentity(code,contentType){
  const mediaType=contentType.split(';')[0].trim().toLowerCase();
  if(!mediaType.startsWith('multipart/'))return {format:'raw',mediaType:contentType,sha256:hash(code)};
  const match=contentType.match(/(?:^|;)\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i);
  const boundary=match?.[1]||match?.[2];
  requireCheck(boundary&&boundary.length<=200,'Cannot normalize the legacy Worker multipart backup.');
  const delimiter=Buffer.from('--'+boundary),separator=Buffer.from('\r\n--'+boundary),parts=[];
  let offset=0;
  requireCheck(code.subarray(0,delimiter.length).equals(delimiter),'Cannot normalize the legacy Worker multipart backup.');
  while(true){
    offset+=delimiter.length;
    if(code.subarray(offset,offset+2).toString()==='--'){
      requireCheck(code.subarray(offset+2).toString()===''||code.subarray(offset+2).toString()==='\r\n','Unexpected Worker multipart epilogue.');
      break;
    }
    requireCheck(code.subarray(offset,offset+2).toString()==='\r\n','Cannot normalize the legacy Worker multipart backup.');
    const headerStart=offset+2,headerEnd=code.indexOf('\r\n\r\n',headerStart);
    requireCheck(headerEnd>=headerStart&&headerEnd-headerStart<=65536,'Unexpected Worker multipart headers.');
    const headers=code.subarray(headerStart,headerEnd).toString('latin1').split('\r\n').map(line=>{
      const colon=line.indexOf(':');
      requireCheck(colon>0&&/^[A-Za-z0-9-]+$/.test(line.slice(0,colon)),'Unexpected Worker multipart headers.');
      return [line.slice(0,colon).toLowerCase(),line.slice(colon+1).trim()];
    }).sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
    const disposition=headers.find(([name])=>name==='content-disposition')?.[1]||'';
    const partName=disposition.match(/(?:^|;)\s*name=(?:"([^"\r\n]*)"|([^;\s]+))/i);
    const name=partName?.[1]||partName?.[2];
    requireCheck(name&&!parts.some(part=>part.name===name),'Worker multipart parts need unique names.');
    const bodyStart=headerEnd+4;
    let end=code.indexOf(separator,bodyStart);
    while(end>=0){
      const suffix=code.subarray(end+separator.length,end+separator.length+2).toString();
      if(suffix==='--'||suffix==='\r\n')break;
      end=code.indexOf(separator,end+separator.length);
    }
    requireCheck(end>=bodyStart,'Cannot normalize the legacy Worker multipart backup.');
    const bytes=code.subarray(bodyStart,end);
    parts.push({name,headers,size:bytes.length,sha256:hash(bytes)});
    requireCheck(parts.length<=1000,'The Worker multipart backup has too many modules.');
    offset=end+2;
  }
  requireCheck(parts.length>0,'The Worker multipart backup is empty.');
  parts.sort((a,b)=>a.name.localeCompare(b.name));
  return {format:'multipart',mediaType,sha256:hash(JSON.stringify(parts))};
}

function safeSettings(settings){
  requireCheck(settings&&typeof settings==='object','Legacy Worker settings are unavailable.');
  const bindings=(settings.bindings||[]).map(binding=>{
    requireCheck(typeof binding.name==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.name),'Unexpected Worker binding metadata.');
    requireCheck(typeof binding.type==='string'&&/^[a-z0-9_]+$/.test(binding.type),'Unexpected Worker binding metadata.');
    const safe={name:binding.name,type:binding.type};
    if(binding.type==='d1'){
      const id=binding.id||binding.database_id;
      requireCheck(uuid.test(id||''),'Unexpected D1 binding metadata.');
      safe.databaseId=id;
    }
    return safe;
  }).sort((a,b)=>a.name.localeCompare(b.name));
  return {
    compatibilityDate:/^\d{4}-\d{2}-\d{2}$/.test(settings.compatibility_date||'')?settings.compatibility_date:null,
    compatibilityFlags:(settings.compatibility_flags||[]).filter(flag=>typeof flag==='string'&&/^[a-z0-9_]+$/.test(flag)).sort(),
    bindings,
    assets:{configured:Boolean(settings.assets)||bindings.some(binding=>binding.type==='assets')},
  };
}

async function readReport(path,message){
  try{return JSON.parse(await readFile(path,'utf8'));}catch{throw new Error(message);}
}

function validateIdentityRows(rows,columns){
  const expected=[...columns].sort().join(',');
  requireCheck(Array.isArray(rows)&&rows.length<=10000,'Legacy identity snapshot is invalid or too large for this guarded retirement.');
  requireCheck(rows.every(row=>row&&Object.keys(row).sort().join(',')===expected),'Legacy identity schema differs from the audited import.');
}

export async function retireLegacyWorker({phase,env=process.env,request=fetch,root=projectRoot,wait=delay,now=()=>new Date().toISOString()}={}){
  requireCheck(phase==='backup'||phase==='retire','Choose exactly --backup or --retire.');
  requireCheck(env.GITHUB_REF==='refs/heads/main','Legacy Worker retirement is allowed only from main.');
  requireCheck(/^[a-f0-9]{40}$/i.test(env.GITHUB_SHA||''),'The main source commit is required.');
  requireCheck(legacy.worker!==canonicalDeployment.worker&&legacy.database!==canonicalDeployment.database,'Legacy and canonical services must be different.');
  const config=await readReport(join(root,'wrangler.backend.json'),'Canonical deployment configuration is missing.');
  validateDeploymentConfig(config,env);
  const deployment=await readReport(join(root,'work/backend/deployment.json'),'A successful canonical main deployment is required before retirement.');
  requireCheck(deployment.service===canonicalDeployment.worker&&deployment.database===canonicalDeployment.database&&deployment.url===canonicalDeployment.url&&deployment.version===VERSION&&deployment.commit===env.GITHUB_SHA,'The deployment report does not match the canonical main release.');
  requireCheck(['health','anonymousRejected','guestState','logout'].every(check=>deployment.checks?.[check]===true),'The canonical release did not complete its API checks.');
  const importPath=join(root,'work/server-consolidation/identity-import.json');
  const imported=await readReport(importPath,'A successful identity import is required before retirement.');
  requireCheck(imported.success===true&&imported.status==='completed'&&imported.sourceUnchanged===true&&imported.existingRowsUnchanged===true,'The identity import did not complete safely.');
  requireCheck(imported.canonical?.worker===canonicalDeployment.worker&&imported.canonical.database===canonicalDeployment.database&&imported.legacy?.worker===legacy.worker&&imported.legacy.database===legacy.database,'The identity import refers to another service.');
  const token=env.CLOUDFLARE_API_TOKEN?.trim(),accountId=env.CLOUDFLARE_ACCOUNT_ID?.trim();
  requireCheck(token&&/^[\x21-\x7e]{20,512}$/.test(token)&&/^[a-f0-9]{32}$/i.test(accountId||''),'Configured Cloudflare credentials are required.');
  const apiBase=`https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  async function call(path,options={}){
    let response;
    try{response=await request(apiBase+path,{...options,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});}
    catch{throw new Error('Cannot reach Cloudflare during guarded retirement.');}
    return response;
  }
  async function api(path,options={}){
    const response=await call(path,options);
    if(response.status===204&&response.ok)return null;
    let value;try{value=await response.json();}catch{throw new Error('Cloudflare returned an unexpected retirement response.');}
    requireCheck(response.ok&&value.success===true,`Cloudflare retirement request failed: HTTP ${response.status}.`);
    return value.result;
  }
  async function list(path){
    const rows=[];
    for(let page=1;page<=100;page++){
      const batch=await api(`${path}?per_page=100&page=${page}`);
      requireCheck(Array.isArray(batch),'Cloudflare returned an unexpected resource list.');
      rows.push(...batch);
      if(batch.length<100)return rows;
    }
    throw new Error('Cloudflare resource listing exceeded the guarded retirement limit.');
  }
  async function query(databaseId,sql,params=[]){
    const result=await api(`/d1/database/${databaseId}/query`,{method:'POST',body:JSON.stringify({sql,params})});
    requireCheck(Array.isArray(result)&&result.length===1&&result[0].success!==false&&Array.isArray(result[0].results),'Cannot verify the database safely.');
    return result[0].results;
  }
  async function health(){
    let response,value;
    try{response=await request(canonicalDeployment.url+'/api/health',{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});value=await response.json();}
    catch{throw new Error('The canonical public health check is unavailable.');}
    requireCheck(response.ok&&value.ok===true&&value.version===VERSION&&value.authentication==='device-token','The canonical public health check does not match the current release.');
  }
  const subdomain=(await api('/workers/subdomain'))?.subdomain;
  requireCheck(subdomain===canonicalDeployment.subdomain,'The Cloudflare account does not match the canonical server.');
  const databases=await list('/d1/database');
  function database(name){
    const matches=databases.filter(item=>item.name===name);
    requireCheck(matches.length===1&&uuid.test(matches[0]?.uuid||''),'The expected existing databases are missing or ambiguous.');
    return matches[0].uuid;
  }
  const legacyId=database(legacy.database),canonicalId=database(canonicalDeployment.database);
  requireCheck(legacyId!==canonicalId&&imported.legacy.databaseId===legacyId&&imported.canonical.databaseId===canonicalId,'Database identities differ from the successful import.');
  const workers=await list('/workers/scripts');
  const names=workers.map(worker=>worker.id||worker.name);
  requireCheck(names.includes(canonicalDeployment.worker),'The canonical Worker must exist before retiring the old Worker.');
  await health();

  async function legacySnapshot(){
    const schema=await query(legacyId,"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const tableNames=schema.map(row=>row.name).sort(),counts={};
    requireCheck([...activityTables,'profiles','device_sessions'].every(name=>tableNames.includes(name)),'The legacy schema differs from the audited import.');
    let emptyTables=0;
    for(const name of tableNames){
      requireCheck(typeof name==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),'The legacy schema contains an unsupported table.');
      if(name.startsWith('_cf_'))continue;
      const rows=await query(legacyId,`SELECT COUNT(*) AS count FROM "${name}"`);
      requireCheck(rows.length===1&&Number.isSafeInteger(rows[0].count)&&rows[0].count>=0,'Legacy table counts cannot be verified safely.');
      counts[name]=rows[0].count;
      if(name==='profiles'||name==='device_sessions'||metadataTables.has(name))continue;
      requireCheck(counts[name]===0,'Legacy sporting or other user data is present; the Worker cannot be retired.');
      emptyTables++;
    }
    const profiles=await query(legacyId,'SELECT * FROM profiles ORDER BY user_id');
    const sessions=await query(legacyId,'SELECT * FROM device_sessions ORDER BY token_hash');
    validateIdentityRows(profiles,profileColumns);
    validateIdentityRows(sessions,sessionColumns);
    requireCheck(imported.counts?.profiles===profiles.length&&imported.counts?.sessions===sessions.length&&counts.profiles===profiles.length&&counts.device_sessions===sessions.length,'Legacy identity counts changed after import.');
    return {tableNames,counts,profiles,sessions,emptyTables};
  }
  const sourceBefore=await legacySnapshot();
  const {profiles,sessions,emptyTables}=sourceBefore;
  async function compare(rows,table,columns,key){
    for(let offset=0;offset<rows.length;offset+=100){
      const batch=rows.slice(offset,offset+100);
      const params=batch.map(row=>row[key]);
      const current=await query(canonicalId,`SELECT ${columns.join(',')} FROM ${table} WHERE ${key} IN (${params.map(()=>'?').join(',')})`,params);
      const byKey=new Map(current.map(row=>[row[key],row]));
      requireCheck(batch.every(row=>columns.every(column=>Object.is(row[column],byKey.get(row[key])?.[column]))),'Legacy identities are not fully preserved in the canonical database.');
    }
  }
  await compare(profiles,'profiles',profileColumns,'user_id');
  await compare(sessions,'device_sessions',sessionColumns,'token_hash');

  const baseReport={success:true,legacy:{...legacy,databaseId:legacyId},canonical:{worker:canonicalDeployment.worker,database:canonicalDeployment.database,databaseId:canonicalId,url:canonicalDeployment.url,version:VERSION,commit:env.GITHUB_SHA},counts:{profiles:profiles.length,sessions:sessions.length,emptyUserTables:emptyTables},legacyDatabaseUnchanged:true,checkedAt:now()};
  const reportDir=join(root,'work/server-consolidation');
  await mkdir(reportDir,{recursive:true});
  if(!names.includes(legacy.worker)){
    const report={...baseReport,status:'already-retired'};
    await writeFile(join(reportDir,'retirement.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    return report;
  }
  const backupDir=join(reportDir,'legacy-worker-backup');
  const manifestPath=join(backupDir,'manifest.json');
  async function readBackup(){
    const manifest=await readReport(manifestPath,'A complete legacy Worker backup is required before deletion.');
    requireCheck(manifest.formatVersion===1&&manifest.legacy?.worker===legacy.worker&&manifest.legacy.database===legacy.database&&manifest.legacy.databaseId===legacyId&&manifest.canonical?.worker===canonicalDeployment.worker&&manifest.canonical.database===canonicalDeployment.database&&manifest.canonical.databaseId===canonicalId&&manifest.canonical.url===canonicalDeployment.url&&manifest.canonical.version===VERSION&&manifest.canonical.commit===env.GITHUB_SHA,'The backup does not match this guarded retirement.');
    requireCheck(manifest.code?.file==='worker.bundle'&&manifest.settings?.file==='settings.safe.json','Unexpected legacy Worker backup paths.');
    let code,settings;
    try{code=await readFile(join(backupDir,'worker.bundle'));settings=await readFile(join(backupDir,'settings.safe.json'));}catch{throw new Error('A complete legacy Worker backup is required before deletion.');}
    requireCheck(code.length===manifest.code.size&&hash(code)===manifest.code.sha256&&hash(settings)===manifest.settings.sha256,'The legacy Worker backup failed its integrity check.');
    requireCheck(typeof manifest.code.contentType==='string'&&JSON.stringify(codeIdentity(code,manifest.code.contentType))===JSON.stringify(manifest.code.identity),'The Worker backup content identity is invalid.');
    requireCheck(manifest.importReportSha256===hash(await readFile(importPath)),'The identity import changed after the Worker backup.');
    return manifest;
  }
  let existingBackup;
  if(phase==='retire')existingBackup=await readBackup();
  const codeResponse=await call(`/workers/scripts/${legacy.worker}`,{method:'GET'});
  requireCheck(codeResponse.ok,'Cannot download the legacy Worker code before retirement.');
  const code=Buffer.from(await codeResponse.arrayBuffer());
  const contentType=codeResponse.headers.get('content-type')||'application/javascript';
  requireCheck(code.length>0&&contentType.length<=300,'Legacy Worker code backup is invalid.');
  requireCheck(!code.includes(Buffer.from(token)),'Worker code unexpectedly contains a deployment credential.');
  const identity=codeIdentity(code,contentType);
  const settings=safeSettings(await api(`/workers/scripts/${legacy.worker}/settings`));
  requireCheck(settings.bindings.some(binding=>binding.name==='DB'&&binding.type==='d1'&&binding.databaseId===legacyId),'The legacy Worker is bound to another database.');
  const settingsBytes=Buffer.from(JSON.stringify(settings,null,2)+'\n');
  if(phase==='backup'){
    const manifest={formatVersion:1,...baseReport,importReportSha256:hash(await readFile(importPath)),code:{file:'worker.bundle',sha256:hash(code),size:code.length,contentType,identity},settings:{file:'settings.safe.json',sha256:hash(settingsBytes)}};
    await mkdir(backupDir,{recursive:true});
    await writeFile(join(backupDir,'worker.bundle'),code,{flag:'wx',mode:0o600});
    await writeFile(join(backupDir,'settings.safe.json'),settingsBytes,{flag:'wx',mode:0o600});
    await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    return {...baseReport,status:'backed-up',backup:{codeSha256:manifest.code.sha256,settingsSha256:manifest.settings.sha256}};
  }
  requireCheck(JSON.stringify(existingBackup.code.identity)===JSON.stringify(identity)&&existingBackup.settings.sha256===hash(settingsBytes),'The legacy Worker changed after backup; deletion stopped.');
  await api(`/workers/scripts/${legacy.worker}`,{method:'DELETE'});
  try{
    let verified=false;
    for(let attempt=0;attempt<5;attempt++){
      const remaining=(await list('/workers/scripts')).map(worker=>worker.id||worker.name);
      if(remaining.includes(canonicalDeployment.worker)&&!remaining.includes(legacy.worker)){
        verified=true;break;
      }
      if(attempt<4)await wait(1000);
    }
    requireCheck(verified,'Worker retirement could not be verified.');
    // Allow requests already running on the retired Worker to finish before checking its retained D1.
    await wait(30000);
    const sourceAfter=await legacySnapshot();
    const tupleSnapshot=snapshot=>JSON.stringify({
      tableNames:snapshot.tableNames,counts:snapshot.counts,
      profiles:snapshot.profiles.map(row=>profileColumns.map(column=>row[column])),
      sessions:snapshot.sessions.map(row=>sessionColumns.map(column=>row[column])),
    });
    requireCheck(tupleSnapshot(sourceBefore)===tupleSnapshot(sourceAfter),'Legacy data changed while the old Worker was being retired.');
    await compare(sourceAfter.profiles,'profiles',profileColumns,'user_id');
    await compare(sourceAfter.sessions,'device_sessions',sessionColumns,'token_hash');
    await health();
  }catch{
    const report={...baseReport,success:false,status:'verification-failed',checkedAt:now(),reason:'Post-retirement verification failed. The legacy D1 is retained for recovery.'};
    await writeFile(join(reportDir,'retirement.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    throw new Error('Legacy Worker removal needs review: post-retirement verification failed; the legacy D1 is retained. See work/server-consolidation/retirement.json.');
  }
  const report={...baseReport,status:'retired',backup:{codeSha256:existingBackup.code.sha256,settingsSha256:existingBackup.settings.sha256}};
  await writeFile(join(reportDir,'retirement.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  return report;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const phase=args.length===1&&args[0]==='--backup'?'backup':args.length===1&&args[0]==='--retire'?'retire':undefined;
  retireLegacyWorker({phase}).then(report=>console.log(JSON.stringify(report))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
