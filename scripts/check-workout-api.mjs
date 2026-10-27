import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseWorkoutCatalog,parseActivity,parseWorkoutPage} from '../src/shared/contracts/validate-workouts.ts';

const routes=[['health',null],['v2/workouts/catalog',parseWorkoutCatalog],['v2/activity',parseActivity],['v2/workouts/history?limit=1',parseWorkoutPage]];
const knownCodes=new Set(['DEVICE_AUTH_REQUIRED','PROFILE_REQUIRED','NOT_FOUND','API_NOT_FOUND','SERVER_ERROR','STORAGE_UNAVAILABLE']);
/** GET only. The returned allowlist deliberately excludes response bodies and identities. */
export async function checkWorkoutApi({apiBase,secret,request=fetch}={}){
  const base=new URL(apiBase);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||!base.pathname.endsWith('/api'))throw new Error('INVALID_API_BASE');
  if(secret!==undefined&&!/^[a-f0-9]{64}$/.test(secret))throw new Error('INVALID_CREDENTIAL');
  const checks=[];let version=null;
  for(const [route,parse] of routes){
    if(parse&&!secret){checks.push({route,status:null,code:'AUTH_NOT_CHECKED',json:false,valid:false});continue;}
    let response;
    try{response=await request(base.href+'/'+route,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json',...(parse?{Authorization:`Bearer ${secret}`}:{})}});}
    catch{checks.push({route,status:null,code:'NETWORK_OR_REDIRECT',json:false,valid:false});continue;}
    let body,json=false,valid=false,code='INVALID_JSON';
    try{body=await response.json();json=/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'');}catch{}
    if(json){
      code=knownCodes.has(body?.error?.code)?body.error.code:response.status===200?'INVALID_RESPONSE':'HTTP_ERROR';
      if(response.status===200)try{
        if(parse)parse(body);
        else if(body?.ok!==true||body.authentication!=='device-token'||typeof body.version!=='string'||!/^\d+\.\d+\.\d+$/.test(body.version)||!Array.isArray(body.apiVersions)||!body.apiVersions.includes(2))throw new Error();
        valid=true;code='OK';if(!parse)version=body.version;
      }catch{}
    }
    checks.push({route,status:response.status,code,json,valid});
  }
  return {version,authChecked:!!secret,checks,ready:!!secret&&checks.every(check=>check.valid)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==2)throw new Error('INVALID_ARGUMENTS');
    const report=await checkWorkoutApi({apiBase:process.env.WORKOUT_API_BASE||'https://movement-test-api-staging.rojoscarlos93.workers.dev/api',secret:process.env.WORKOUT_API_SECRET});
    console.log(JSON.stringify(report,null,2));process.exitCode=report.ready?0:1;
  }catch{console.log(JSON.stringify({ready:false,code:'INVALID_CONFIGURATION'}));process.exitCode=2;}
}
