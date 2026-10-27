import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {VERSION} from '../src/config.js';
import {canonicalDeployment,validateDeploymentConfig,provisionDatabase} from './deploy-backend.mjs';

const root=resolve(import.meta.dirname,'..');
const expectedMigration='4f463af3536b838419a303e79547e659a7152621319a9fda6dcbae6efc9039ca';

/** Cloudflare control-plane reads plus SELECT queries; never changes user data. */
export async function captureCheckpoint({accountId,token,phase='before',sourceSha,previous=null,request=fetch}={}){
  if(!['before','after'].includes(phase)||!/^[a-f0-9]{32}$/i.test(accountId??'')||!token||!/^[a-f0-9]{40}$/i.test(sourceSha??''))throw new Error('Invalid release checkpoint configuration.');
  const config=JSON.parse(await readFile(resolve(root,'wrangler.backend.json'),'utf8'));
  validateDeploymentConfig(config);
  const sql=await readFile(resolve(root,'drizzle/0005_workouts_activity.sql'),'utf8');
  if(createHash('sha256').update(sql).digest('hex')!==expectedMigration)throw new Error('Migration 0005 changed.');
  const {databaseId}=await provisionDatabase({accountId,token,request});
  async function cloud(path,{query}={}){
    const response=await request(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,{
      method:query?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      ...(query?{body:JSON.stringify({sql:query,params:[]})}:{}),
    });
    let body;try{body=await response.json();}catch{throw new Error('Cloudflare checkpoint returned invalid JSON.');}
    if(!response.ok||body.success!==true)throw new Error(`Cloudflare checkpoint failed: HTTP ${response.status}.`);
    return body.result;
  }
  async function select(query){
    if(!/^SELECT\b/i.test(query))throw new Error('Checkpoint permits SELECT only.');
    const result=await cloud(`/d1/database/${databaseId}/query`,{query});
    if(!Array.isArray(result)||result.some(item=>item.success===false)||!Array.isArray(result[0]?.results))throw new Error('Invalid D1 read response.');
    return result[0].results;
  }
  const bookmark=await cloud(`/d1/database/${databaseId}/time_travel/bookmark`);
  if(typeof bookmark?.bookmark!=='string'||!bookmark.bookmark||bookmark.bookmark.length>512)throw new Error('No D1 recovery bookmark; release stopped.');
  const deployments=await cloud(`/workers/scripts/${canonicalDeployment.worker}/deployments`);
  const list=Array.isArray(deployments)?deployments:deployments?.deployments;
  if(!Array.isArray(list)||!list.length||typeof list[0]?.id!=='string'||!list[0]?.versions?.some(v=>typeof v.version_id==='string'))throw new Error('Cannot establish current Worker version.');
  const schema=await select("SELECT name,type FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name");
  const tables=schema.filter(item=>item.type==='table').map(item=>item.name);
  const triggers=schema.filter(item=>item.type==='trigger').map(item=>item.name);
  const migrationTable=tables.includes('d1_migrations')?'d1_migrations':tables.includes('movement_migrations')?'movement_migrations':null;
  if(!migrationTable)throw new Error('Cannot establish migration journal.');
  const migrations=await select(`SELECT * FROM ${migrationTable} LIMIT 100`);
  const counts=(await select('SELECT (SELECT COUNT(*) FROM profiles) AS profiles,(SELECT COUNT(*) FROM repetition_events) AS repetitions,(SELECT COUNT(*) FROM rounds) AS rounds,(SELECT COUNT(*) FROM competitions) AS competitions'))[0];
  if(!counts||Object.values(counts).some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('Invalid baseline counts.');
  const activation=tables.includes('activity_settings')?(await select('SELECT activated_at FROM activity_settings WHERE id=1'))[0]?.activated_at??null:null;
  let health={status:null,version:null};
  try{
    const response=await request(canonicalDeployment.url+'/api/health',{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000)});
    const data=await response.json();
    health={status:response.status,version:typeof data.version==='string'&&/^\d+\.\d+\.\d+$/.test(data.version)?data.version:null};
  }catch{}
  const snapshot={phase,recordedAt:new Date().toISOString(),sourceSha,version:VERSION,service:canonicalDeployment.worker,database:canonicalDeployment.database,databaseId,bookmark:bookmark.bookmark,
    workerDeployments:list.slice(0,3).map(d=>({id:d.id,createdOn:d.created_on,versions:(d.versions??[]).map(v=>({versionId:v.version_id,percentage:v.percentage}))})),
    migrationTable,migrations,tableNames:tables,triggerNames:triggers,counts,activatedAt:activation,health,migrationSha256:expectedMigration};
  if(phase==='after'){
    if(!previous||previous.phase!=='before'||previous.databaseId!==databaseId||previous.sourceSha!==sourceSha||!previous.bookmark)throw new Error('Release baseline does not match this database/source.');
    const requiredTables=[...sql.matchAll(/CREATE TABLE\s+(\w+)/g)].map(m=>m[1]);
    const requiredTriggers=[...sql.matchAll(/CREATE TRIGGER\s+(\w+)/g)].map(m=>m[1]);
    if(requiredTables.some(n=>!tables.includes(n))||requiredTriggers.some(n=>!triggers.includes(n)))throw new Error('Workout schema/guards incomplete after deployment.');
    if(!migrations.some(m=>Object.values(m).some(v=>typeof v==='string'&&v==='0005_workouts_activity.sql')))throw new Error('Migration 0005 is absent from the remote journal.');
    if(!Number.isSafeInteger(activation)||activation<=0||(previous.activatedAt!==null&&previous.activatedAt!==activation))throw new Error('Persisted activity activation is invalid or changed.');
    if(counts.profiles<previous.counts.profiles||counts.rounds<previous.counts.rounds||counts.competitions<previous.counts.competitions)throw new Error('Existing profile/history counts decreased.');
    if(health.status!==200||health.version!==VERSION)throw new Error('Published health version differs from this release.');
  }
  return snapshot;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const phase=process.argv[2];if(!['before','after'].includes(phase)||process.argv.length!==3)throw new Error('Invalid checkpoint phase.');
    const directory=resolve(root,'work/backend');await mkdir(directory,{recursive:true});
    const previous=phase==='after'?JSON.parse(await readFile(resolve(directory,'preflight.json'),'utf8')):null;
    const data=await captureCheckpoint({phase,previous,sourceSha:process.env.GITHUB_SHA,accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN});
    await writeFile(resolve(directory,phase==='before'?'preflight.json':'postflight.json'),JSON.stringify(data,null,2)+'\n',{mode:0o600});
    console.log(`Release ${phase} checkpoint verified; recovery metadata saved to private artifact.`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
