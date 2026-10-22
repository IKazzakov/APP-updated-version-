import {runMaintenance} from './maintenance.js';
import siteWorker,{protect} from './worker.js';
import {handleApi} from './api.js';
import {authenticateDevice,registerDevice,revokeDevice,authError} from './device-auth.js';
import {VERSION} from '../src/config.js';

export default {
  async scheduled(controller,env,ctx){
    const task=runMaintenance(env.DB,controller.scheduledTime??Date.now());
    ctx?.waitUntil(task);return task;
  },
  async fetch(request,env){
    const url=new URL(request.url),path=url.pathname;
    if(!path.startsWith('/api')&&path!=='/healthz')return siteWorker.fetch(request,env);
    try{
      if(!env.DB)return protect(authError('STORAGE_UNAVAILABLE',503));
      if(path==='/api/health'||path==='/healthz'){
        if(!['GET','HEAD'].includes(request.method))return protect(authError('METHOD_NOT_ALLOWED',405));
        await env.DB.prepare('SELECT token_hash FROM device_sessions LIMIT 1').all();
        return protect(new Response(request.method==='HEAD'?null:JSON.stringify({ok:true,version:VERSION,authentication:'device-token',apiVersions:[1,2],storage:env.STORAGE_KIND||'d1'}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}));
      }
      if(request.method==='POST'&&request.headers.get('origin')!==url.origin)return protect(authError('ORIGIN_FORBIDDEN',403));
      if(path==='/api/auth/guest')return protect(request.method==='POST'?await registerDevice(request,env):authError('METHOD_NOT_ALLOWED',405));
      const session=await authenticateDevice(request,env.DB);
      if(!session)return protect(authError('DEVICE_AUTH_REQUIRED'));
      if(path==='/api/auth/logout')return protect(request.method==='POST'?await revokeDevice(session,env.DB):authError('METHOD_NOT_ALLOWED',405));
      // No identity supplied by a caller is trusted on the public endpoint.
      const headers=new Headers(request.headers);
      for(const name of [...headers.keys()])if(name.startsWith('oai-authenticated-')||name==='x-test-user-id'||name==='authorization')headers.delete(name);
      headers.set('oai-authenticated-user-id',session.userId);
      if(!path.startsWith('/api/'))return protect(authError('NOT_FOUND',404));
      return protect(await handleApi(new Request(request,{headers}),env));
    }catch(error){
      // Never log request bodies, authorization headers, names or DB rows.
      console.error('Backend request failed:',error.name);
      return protect(authError('SERVER_ERROR',500));
    }
  },
};
