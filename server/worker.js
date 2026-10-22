import {handleApi} from './api.js';

export function protect(response){
  const headers=new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff');
  headers.set('Referrer-Policy','no-referrer');
  headers.set('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
  // Never allow authenticated responses or HTML to enter a shared browser cache.
  if((headers.get('Content-Type')??'').includes('text/html'))headers.set('Cache-Control','private, no-store');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/'))return protect(await handleApi(request,env));
    // ChatGPT sign-in/out and authentication headers belong to Sites dispatch.
    // They are not implemented or simulated in this production Worker.
    if(request.method!=='GET'&&request.method!=='HEAD')return protect(new Response('Метод не поддерживается',{status:405}));
    return protect(await env.ASSETS.fetch(request));
  },
};
