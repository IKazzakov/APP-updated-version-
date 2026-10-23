import {readFile,writeFile,mkdir,appendFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {VERSION} from '../src/config.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(done=>setTimeout(done,ms));

export const canonicalDeployment=Object.freeze({
  worker:'movement-test-api-staging',
  database:'movement-test-app-staging',
  subdomain:'rojoscarlos93',
  url:'https://movement-test-api-staging.rojoscarlos93.workers.dev',
});

export function validateDeploymentConfig(config,env=process.env){
  if(env.BACKEND_TARGET?.trim())throw new Error('BACKEND_TARGET is no longer supported. Remove it; this project has one canonical server.');
  if(config?.name!==canonicalDeployment.worker)throw new Error('The Worker does not match the canonical server.');
  const databases=config.d1_databases;
  if(!Array.isArray(databases)||databases.length!==1||databases[0]?.binding!=='DB'||databases[0].database_name!==canonicalDeployment.database)throw new Error('The DB binding must use the existing canonical database.');
  if(!Array.isArray(config.ratelimits)||config.ratelimits.length!==1||config.ratelimits[0]?.name!=='AUTH_LIMITER'||config.ratelimits[0].namespace_id!=='250301')throw new Error('The registration limiter must use the canonical namespace.');
  return canonicalDeployment;
}

export async function provisionDatabase({accountId,token,name=canonicalDeployment.database,request=fetch}){
  if(name!==canonicalDeployment.database)throw new Error('Refusing to select a database outside the canonical service.');
  async function api(path,options={}){
    let response;
    try{response=await request(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,{...options,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});}
    catch{throw new Error('Cannot reach Cloudflare API. Check the network and the configured token.');}
    let value;try{value=await response.json();}catch{throw new Error('Cloudflare API returned an unexpected response.');}
    if(!response.ok||!value.success)throw new Error(`Cloudflare API HTTP ${response.status}; codes ${(value.errors||[]).map(e=>Number(e.code)||'unknown').join(',')}. Check token permissions.`);
    return value;
  }
  async function lookup(){
    const matches=[];
    for(let page=1;page<=100;page++){
      const value=await api(`/d1/database?per_page=100&page=${page}`);
      matches.push(...value.result.filter(db=>db.name===name));
      if(value.result.length<100)break;
      if(page===100)throw new Error('Too many D1 databases; narrow the account used for deployment.');
    }
    if(matches.length>1)throw new Error('Several databases match the configured name. Refusing to choose one.');
    return matches[0];
  }
  const subdomain=(await api('/workers/subdomain')).result?.subdomain;
  if(subdomain!==canonicalDeployment.subdomain)throw new Error('The Cloudflare account does not match the canonical workers.dev server.');
  const database=await lookup();
  if(!database)throw new Error('The existing canonical D1 database is missing. Deployment stopped without creating a replacement.');
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database.uuid||''))throw new Error('Cloudflare did not return a valid database ID.');
  return {databaseId:database.uuid,subdomain};
}

export async function smokeBackend(origin,request=fetch){
  async function call(path,{method='GET',body,secret}={}){
    const response=await request(`${origin}/api/${path}`,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Accept:'application/json',...(method==='POST'?{'Content-Type':'application/json',Origin:origin}:{}),...(secret?{Authorization:`Bearer ${secret}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    let data;try{data=await response.json();}catch{throw new Error('Published API returned HTML instead of JSON.');}
    return {status:response.status,data};
  }
  const health=await call('health');
  if(health.status!==200||health.data.version!==VERSION||health.data.authentication!=='device-token')throw new Error('Published health/version/authentication check failed.');
  const anonymous=await call('state');
  if(anonymous.status!==401||anonymous.data.error?.code!=='DEVICE_AUTH_REQUIRED')throw new Error('Unauthenticated API must reject identity headers and require a device session.');
  const secret=[...crypto.getRandomValues(new Uint8Array(32))].map(v=>v.toString(16).padStart(2,'0')).join('');
  let registered=false;
  try{
    const guest=await call('auth/guest',{method:'POST',body:{secret}});
    if(guest.status!==200)throw new Error(`Guest registration failed: HTTP ${guest.status}`);
    registered=true;
    const compact=await call('v2/dashboard',{secret});
    if(compact.status!==200||compact.data.profile!==null||!Array.isArray(compact.data.rounds))throw new Error('Compact API/D1 migration check failed.');
    const state=await call('state',{secret});
    if(state.status!==200||state.data.profile!==null||!Number.isFinite(state.data.serverNow))throw new Error('Authenticated D1 state check failed.');
  }finally{
    if(registered){const logout=await call('auth/logout',{method:'POST',body:{},secret});if(logout.status!==200)throw new Error('Smoke session could not be revoked.');}
  }
  return {health:true,anonymousRejected:true,guestState:true,logout:true};
}

async function main(){
  const token=process.env.CLOUDFLARE_API_TOKEN?.trim(),accountId=process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if(!token||!accountId)throw new Error('Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in GitHub → Settings → Secrets and variables → Actions. See docs/CLOUDFLARE_SETUP.md.');
  if(!/^[\x21-\x7e]{20,512}$/.test(token))throw new Error('CLOUDFLARE_API_TOKEN has an invalid format. Copy the token value again without whitespace.');
  if(!/^[a-f0-9]{32}$/i.test(accountId))throw new Error('CLOUDFLARE_ACCOUNT_ID must be the 32-character Account ID, not an API token or Zone ID.');
  await stat(resolve(root,'dist/client/index.html'));
  const config=JSON.parse(await readFile(resolve(root,'wrangler.backend.json'),'utf8'));
  validateDeploymentConfig(config);
  const {databaseId}=await provisionDatabase({accountId,token,name:config.d1_databases[0].database_name});
  config.account_id=accountId;
  config.main=resolve(root,config.main);config.assets.directory=resolve(root,config.assets.directory);
  config.d1_databases[0].database_id=databaseId;
  config.d1_databases[0].migrations_dir=resolve(root,config.d1_databases[0].migrations_dir);
  await mkdir(resolve(root,'work/backend'),{recursive:true});
  const configFile=resolve(root,'work/backend/wrangler.generated.json');
  await writeFile(configFile,JSON.stringify(config,null,2)+'\n');
  for(const args of [['d1','migrations','apply','DB','--remote'],['deploy']]){
    const result=spawnSync(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),...args,'--config',configFile],{cwd:root,stdio:'inherit',env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:resolve(root,'work/backend/wrangler.log')}});
    if(result.error||result.status!==0)throw new Error(`Wrangler ${args[0]} failed. Applied migrations are preserved; rerun after fixing the reported problem.`);
  }
  const url=canonicalDeployment.url;
  let checks,lastError;
  for(let attempt=0;attempt<6;attempt++){
    try{checks=await smokeBackend(url);break;}catch(error){lastError=error;if(attempt<5)await pause(2000);}
  }
  if(!checks)throw lastError;
  const report={service:canonicalDeployment.worker,database:canonicalDeployment.database,url,apiBaseUrl:`${url}/api`,version:VERSION,commit:process.env.GITHUB_SHA||null,checks};
  await writeFile(resolve(root,'work/backend/deployment.json'),JSON.stringify(report,null,2)+'\n');
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,`## Движение ${VERSION}\n\nСервер: ${url}\n\nАдрес для APK: ${url}/api\n\nHealth, JSON, D1, индивидуальная сессия и выход: проверено.\n`);
  console.log(`Backend ${VERSION} deployed and verified: ${url}`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
