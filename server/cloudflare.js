import {runMaintenance} from './maintenance.js';
import siteWorker,{protect} from './worker.js';
import {handleApi} from './api.js';
import {authenticateDevice,registerDevice,revokeDevice,authError} from './device-auth.js';
import {VERSION} from '../src/config.js';
import {isPreviewOrigin,approveBrowserOrigin,validPreflight,withPreviewCors} from './browser-origin.js';

export default {
  async scheduled(controller,env,ctx){
    const task=runMaintenance(env.DB,controller.scheduledTime??Date.now());
    ctx?.waitUntil(task);return task;
  },
  async fetch(request,env){
    const url=new URL(request.url),path=url.pathname;
    if(!path.startsWith('/api')&&path!=='/healthz')return siteWorker.fetch(request,env);
    const apiPath=path.startsWith('/api/'),origin=request.headers.get('origin');
    // Node uses this adapter with STORAGE_KIND=sqlite; its Origin policy remains unchanged.
    const preview=apiPath&&env.STORAGE_KIND!=='sqlite'&&isPreviewOrigin(origin);
    const cors=preview&&['GET','HEAD','POST'].includes(request.method);
    const finish=response=>protect(cors?withPreviewCors(response,origin):response);
    if(apiPath&&request.method==='OPTIONS'&&env.STORAGE_KIND!=='sqlite'){
      if(!preview)return protect(authError('ORIGIN_FORBIDDEN',403));
      if(!validPreflight(request))return protect(withPreviewCors(authError('INVALID_PREFLIGHT',400),origin));
      return protect(withPreviewCors(new Response(null,{status:204}),origin,{preflight:true}));
    }
    if(apiPath&&request.method==='POST'&&origin!==url.origin&&!preview)return protect(authError('ORIGIN_FORBIDDEN',403));
    try{
      if(!env.DB)return finish(authError('STORAGE_UNAVAILABLE',503));
      if(path==='/api/health'||path==='/healthz'){
        if(!['GET','HEAD'].includes(request.method))return finish(authError('METHOD_NOT_ALLOWED',405));
        await env.DB.prepare('SELECT token_hash FROM device_sessions LIMIT 1').all();
        return finish(new Response(request.method==='HEAD'?null:JSON.stringify({ok:true,version:VERSION,authentication:'device-token',apiVersions:[1,2],storage:env.STORAGE_KIND||'d1'}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}));
      }
      if(request.method==='POST'&&!apiPath&&origin!==url.origin)return finish(authError('ORIGIN_FORBIDDEN',403));
      if(path==='/api/auth/guest')return finish(request.method==='POST'?await registerDevice(request,env):authError('METHOD_NOT_ALLOWED',405));
      const session=await authenticateDevice(request,env.DB);
      if(!session)return finish(authError('DEVICE_AUTH_REQUIRED'));
      if(path==='/api/auth/logout')return finish(request.method==='POST'?await revokeDevice(session,env.DB):authError('METHOD_NOT_ALLOWED',405));
      // No identity supplied by a caller is trusted on the public endpoint.
      const headers=new Headers(request.headers);
      for(const name of [...headers.keys()])if(name.startsWith('oai-authenticated-')||name==='x-test-user-id'||name==='authorization')headers.delete(name);
      headers.set('oai-authenticated-user-id',session.userId);
      if(!path.startsWith('/api/'))return finish(authError('NOT_FOUND',404));
      const apiRequest=new Request(request,{headers});
      const originApproval=preview?approveBrowserOrigin(apiRequest):null;
      return finish(await handleApi(apiRequest,env,{originApproval}));
    }catch(error){
      // Never log request bodies, authorization headers, names or DB rows.
      console.error('Backend request failed:',error.name);
      return finish(authError('SERVER_ERROR',500));
    }
  },
};
