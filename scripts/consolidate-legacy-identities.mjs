// One-time identity-only consolidation. Legacy application data must be empty.
// Identity rows stay in memory; reports and errors never contain their values.
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROFILE_COLUMNS=Object.freeze(['user_id','display_name','time_zone','created_at','rankings_enabled','rankings_excluded']);
export const SESSION_COLUMNS=Object.freeze(['token_hash','user_id','created_at','revoked_at']);
export const LEGACY_ACTIVITY_TABLES=Object.freeze(['competitions','rounds','daily_progress','daily_rewards','repetition_events','weekly_standings','weekly_participants','weekly_bonuses','weekly_summaries']);
const metadataTables=new Set(['weekly_settings','weekly_periods','d1_migrations']);
const canonical=Object.freeze({worker:'movement-test-api-staging',database:'movement-test-app-staging'});
const legacy=Object.freeze({worker:'movement-test-api',database:'movement-test-app'});
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

const stable=value=>JSON.stringify(value,(_,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry);
const rowsKey=rows=>rows.map(stable).sort();
const equalRows=(left,right)=>stable(rowsKey(left))===stable(rowsKey(right));
const tables=snapshot=>{
  if(!snapshot?.tables||typeof snapshot.tables!=='object'||Array.isArray(snapshot.tables))throw new Error('A complete table snapshot is required.');
  for(const rows of Object.values(snapshot.tables))if(!Array.isArray(rows))throw new Error('Table snapshots must contain row arrays.');
  return snapshot.tables;
};
const equalSnapshots=(left,right)=>{
  const first=tables(left),second=tables(right);
  return stable(Object.keys(first).sort())===stable(Object.keys(second).sort())&&Object.keys(first).every(name=>equalRows(first[name],second[name]));
};
function identities(snapshot){
  const all=tables(snapshot);
  if(!Array.isArray(all.profiles)||!Array.isArray(all.device_sessions))throw new Error('Identity tables are missing.');
  const profiles=new Map(),sessions=new Map(),sessionUsers=new Map();
  for(const row of all.profiles){
    if(stable(Object.keys(row).sort())!==stable([...PROFILE_COLUMNS].sort())||typeof row.user_id!=='string'||!row.user_id||typeof row.display_name!=='string'||!row.display_name.trim()||row.display_name.length>40||typeof row.time_zone!=='string'||!Number.isSafeInteger(row.created_at)||![0,1].includes(row.rankings_enabled)||![0,1].includes(row.rankings_excluded))throw new Error('Unexpected profile shape.');
    if(profiles.has(row.user_id))throw new Error('Duplicate profile identity.');
    profiles.set(row.user_id,row);
  }
  for(const row of all.device_sessions){
    if(stable(Object.keys(row).sort())!==stable([...SESSION_COLUMNS].sort())||!/^[a-f0-9]{64}$/.test(row.token_hash)||typeof row.user_id!=='string'||!row.user_id||!Number.isSafeInteger(row.created_at)||(row.revoked_at!==null&&!Number.isSafeInteger(row.revoked_at)))throw new Error('Unexpected session shape.');
    if(sessions.has(row.token_hash)||sessionUsers.has(row.user_id))throw new Error('Duplicate session identity.');
    sessions.set(row.token_hash,row);sessionUsers.set(row.user_id,row);
  }
  return {profiles,sessions,sessionUsers};
}

export function planIdentityImport(source,destination){
  const sourceTables=tables(source);
  for(const name of LEGACY_ACTIVITY_TABLES)if(!Array.isArray(sourceTables[name]))throw new Error('Legacy activity inventory is incomplete.');
  for(const [name,rows] of Object.entries(sourceTables))if(name!=='profiles'&&name!=='device_sessions'&&!metadataTables.has(name)&&rows.length)throw new Error('Legacy training or other application data is not empty; identity-only consolidation stopped.');
  const from=identities(source),to=identities(destination);
  for(const [id,row] of from.profiles)if(to.profiles.has(id)&&stable(to.profiles.get(id))!==stable(row))throw new Error('Profile identity conflict; no rows may be overwritten.');
  for(const [token,row] of from.sessions){
    if(to.sessions.has(token)&&stable(to.sessions.get(token))!==stable(row))throw new Error('Session token conflict; no rows may be overwritten.');
    if(to.sessionUsers.has(row.user_id)&&stable(to.sessionUsers.get(row.user_id))!==stable(row))throw new Error('Session owner conflict; no rows may be overwritten.');
  }
  // Exact matching rows prove a previous partial import. Cross-table user-ID
  // collisions without such a match cannot grant a source token another profile.
  for(const id of new Set([...from.profiles.keys(),...from.sessionUsers.keys()])){
    if(!to.profiles.has(id)&&!to.sessionUsers.has(id))continue;
    const sameProfile=from.profiles.has(id)&&to.profiles.has(id)&&stable(from.profiles.get(id))===stable(to.profiles.get(id));
    const sameSession=from.sessionUsers.has(id)&&to.sessionUsers.has(id)&&stable(from.sessionUsers.get(id))===stable(to.sessionUsers.get(id));
    if(!sameProfile&&!sameSession)throw new Error('Cross-table identity conflict; no rows may be overwritten.');
  }
  const profiles=[...from.profiles.values()].filter(row=>!to.profiles.has(row.user_id));
  const sessions=[...from.sessions.values()].filter(row=>!to.sessions.has(row.token_hash));
  const insert=(table,columns,row)=>({sql:`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT DO NOTHING`,params:columns.map(column=>row[column])});
  return {profiles,sessions,statements:[...profiles.map(row=>insert('profiles',PROFILE_COLUMNS,row)),...sessions.map(row=>insert('device_sessions',SESSION_COLUMNS,row))]};
}

export function validateIdentityImport(sourceBefore,sourceAfter,before,after,plan){
  const source=tables(sourceBefore),unchanged=tables(sourceAfter),old=tables(before),next=tables(after);
  if(stable(Object.keys(source).sort())!==stable(Object.keys(unchanged).sort())||Object.keys(source).some(name=>!equalRows(source[name],unchanged[name])))throw new Error('Legacy source changed during consolidation; retirement is forbidden.');
  if(stable(Object.keys(old).sort())!==stable(Object.keys(next).sort()))throw new Error('Canonical schema changed during consolidation.');
  const additions={profiles:plan.profiles,device_sessions:plan.sessions,user_totals:plan.profiles.map(row=>({user_id:row.user_id,points:0,bonus_points:0,revision:0})),ranking_consent:plan.profiles.map(row=>({user_id:row.user_id,changed_at:row.created_at,excluded:row.rankings_excluded}))};
  for(const [name,rows] of Object.entries(old)){
    if(!equalRows([...rows,...(additions[name]||[])],next[name]))throw new Error('Canonical existing data changed or import verification failed.');
  }
  if(planIdentityImport(sourceAfter,after).statements.length)throw new Error('Not all legacy identities were imported.');
  return {sourceUnchanged:true,existingRowsUnchanged:true};
}

function requireBookmark(value){
  const bookmark=typeof value==='string'?value:value?.bookmark;
  if(typeof bookmark!=='string'||!bookmark.trim())throw new Error('Both D1 Time Travel bookmarks are required before identity writes.');
  return bookmark;
}

export async function importLegacyIdentities({readLegacy,readCanonical,bookmarkLegacy,bookmarkCanonical,executeCanonical,checkpoint=async()=>{}}){
  // Invalidate an older successful checkpoint before inspecting a fresh source.
  await checkpoint({success:false,status:'validating'});
  const source=await readLegacy(),before=await readCanonical();
  const plan=planIdentityImport(source,before);
  const bookmarks={legacy:requireBookmark(await bookmarkLegacy()),canonical:requireBookmark(await bookmarkCanonical())};
  const counts={profiles:source.tables.profiles.length,sessions:source.tables.device_sessions.length,insertedProfiles:plan.profiles.length,insertedSessions:plan.sessions.length,canonicalProfilesBefore:before.tables.profiles.length,canonicalSessionsBefore:before.tables.device_sessions.length};
  const prepared={success:false,status:'prepared',bookmarks,counts};
  await checkpoint(prepared);
  try{
    const sourceCheck=await readLegacy(),canonicalCheck=await readCanonical();
    if(!equalSnapshots(sourceCheck,source)||!equalSnapshots(canonicalCheck,before))throw new Error('Database snapshot changed before writes; retry from a fresh snapshot.');
    // The REST /query API accepts individual parameterized statements. Avoid
    // assuming undocumented cross-request transactions: inserts never update,
    // every collision was validated, and interruption can safely resume.
    for(const statement of plan.statements)await executeCanonical(statement);
    const sourceAfter=await readLegacy(),after=await readCanonical();
    const verified=validateIdentityImport(source,sourceAfter,before,after,plan);
    const report={...prepared,success:true,status:'completed',...verified,completedAt:new Date().toISOString()};
    await checkpoint(report);return report;
  }catch(error){
    await checkpoint({...prepared,status:'failed',reason:'Consolidation did not complete or verification failed; legacy Worker retirement is forbidden.'});
    throw error;
  }
}

export async function consolidateLegacyIdentities({accountId,token,request=fetch,outputPath=resolve(root,'work/server-consolidation/identity-import.json')}={}){
  if(!/^[a-f0-9]{32}$/i.test(accountId||'')||!token?.trim())throw new Error('Cloudflare account and token are required.');
  async function api(path,options={}){
    let response;
    try{response=await request(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,{...options,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});}
    catch{throw new Error('Cloudflare consolidation request could not be completed.');}
    let value;try{value=await response.json();}catch{throw new Error('Cloudflare returned an unexpected consolidation response.');}
    if(!response.ok||!value.success)throw new Error(`Cloudflare consolidation API HTTP ${response.status}.`);
    return value.result;
  }
  if((await api('/workers/subdomain'))?.subdomain!=='rojoscarlos93')throw new Error('The account does not match the existing canonical server.');
  const databases=[];
  for(let page=1;page<=100;page++){
    const batch=await api(`/d1/database?per_page=100&page=${page}`);
    if(!Array.isArray(batch))throw new Error('Unexpected D1 inventory response.');
    databases.push(...batch);
    if(batch.length<100)break;
    if(page===100)throw new Error('D1 inventory exceeded the bounded lookup.');
  }
  function exactDatabase(name){
    const matches=databases.filter(database=>database.name===name);
    if(matches.length!==1||!uuid.test(matches[0]?.uuid||''))throw new Error('Each exact existing database must resolve uniquely; no database will be created.');
    return matches[0].uuid;
  }
  const sourceId=exactDatabase(legacy.database),canonicalId=exactDatabase(canonical.database);
  if(sourceId===canonicalId)throw new Error('Legacy and canonical databases unexpectedly resolve to one identifier.');
  async function execute(databaseId,sql,params=[]){
    const results=await api(`/d1/database/${databaseId}/query`,{method:'POST',body:JSON.stringify({sql,params})});
    if(!Array.isArray(results)||results.some(result=>result.success!==true||!Array.isArray(result.results)))throw new Error('D1 query did not return a complete successful result.');
    return results;
  }
  async function snapshot(databaseId){
    const schema=await execute(databaseId,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name");
    const names=schema[0].results.map(row=>row.name);
    if(names.length<2||names.length>50||names.some(name=>!/^[a-z_][a-z0-9_]*$/i.test(name)))throw new Error('Unexpected D1 table inventory.');
    const result=await execute(databaseId,names.map(name=>`SELECT * FROM "${name}"`).join(';'));
    if(result.length!==names.length)throw new Error('D1 snapshot table results are incomplete.');
    return {tables:Object.fromEntries(names.map((name,index)=>[name,result[index].results]))};
  }
  const context={canonical:{...canonical,databaseId:canonicalId},legacy:{...legacy,databaseId:sourceId}};
  const checkpoint=async report=>{
    await mkdir(dirname(outputPath),{recursive:true});
    await writeFile(outputPath,JSON.stringify({...context,...report},null,2)+'\n',{mode:0o600});
  };
  const report=await importLegacyIdentities({readLegacy:()=>snapshot(sourceId),readCanonical:()=>snapshot(canonicalId),bookmarkLegacy:()=>api(`/d1/database/${sourceId}/time_travel/bookmark`),bookmarkCanonical:()=>api(`/d1/database/${canonicalId}/time_travel/bookmark`),executeCanonical:statement=>execute(canonicalId,statement.sql,statement.params),checkpoint});
  return {...context,...report};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  consolidateLegacyIdentities({accountId:process.env.CLOUDFLARE_ACCOUNT_ID?.trim(),token:process.env.CLOUDFLARE_API_TOKEN?.trim()}).then(report=>console.log(JSON.stringify(report))).catch(()=>{console.error('Legacy identity consolidation stopped. No legacy Worker was deleted. Inspect the aggregate checkpoint and verify credentials or conflicting data before retrying.');process.exitCode=1;});
}
