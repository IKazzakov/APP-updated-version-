// Runs the existing API and web client together on AI Studio / Cloud Run.
// Sites continues to use server/worker.js and its managed D1 binding.
import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,relative,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './sqlite.js';
import worker from './cloudflare.js';
import {VERSION} from '../src/config.js';

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.wasm':'application/wasm','.task':'application/octet-stream','.woff2':'font/woff2','.apk':'application/vnd.android.package-archive'};

export async function createNodeServer({databasePath=process.env.MOVEMENT_DB_PATH||'.data/movement.sqlite',assetsDirectory=resolve('dist/client'),publicOrigin=process.env.PUBLIC_ORIGIN,dev=false}={}){
  const db=openDatabase(databasePath),root=resolve(assetsDirectory);
  let vite;
  async function assetsFetch(request){
    const url=new URL(request.url);let path;
    try{path=decodeURIComponent(url.pathname);}catch{return new Response('Bad path',{status:400});}
    if(path.includes('\0'))return new Response('Bad path',{status:400});
    let file=resolve(root,`.${path==='/'?'/index.html':path}`);
    if(relative(root,file).startsWith('..'))return new Response('Not found',{status:404});
    if(!(await stat(file).catch(()=>null))?.isFile()){
      if(extname(path))return new Response('Not found',{status:404});
      file=resolve(root,'index.html');
    }
    const info=await stat(file);
    return new Response(request.method==='HEAD'?null:await readFile(file),{headers:{'content-type':mime[extname(file)]||'application/octet-stream','content-length':String(info.size),'cache-control':'private, no-store'}});
  }
  const server=http.createServer(async(incoming,outgoing)=>{
    try{
      if(!incoming.url?.startsWith('/')||incoming.url.startsWith('//')){outgoing.writeHead(400);outgoing.end();return;}
      if(dev&&!incoming.url.startsWith('/api')&&incoming.url.split('?')[0]!=='/healthz'){
        vite.middlewares(incoming,outgoing);return;
      }
      const headers=new Headers(incoming.headers);
      // Node mirrors the deployed API's individual device authentication.
      for(const key of [...headers.keys()])if(key.startsWith('oai-authenticated-'))headers.delete(key);
      const protocol=incoming.headers['x-forwarded-proto']?.split(',')[0].trim()==='https'?'https':'http';
      const origin=publicOrigin?new URL(publicOrigin).origin:`${protocol}://${incoming.headers.host}`;
      const method=incoming.method||'GET';
      const chunks=[];let size=0;
      for await(const chunk of incoming){size+=chunk.length;if(size>65536){outgoing.writeHead(413,{'content-type':'application/json'});outgoing.end(JSON.stringify({error:{code:'TOO_LARGE'}}));return;}chunks.push(chunk);}
      const request=new Request(new URL(incoming.url,origin),{method,headers,...(['GET','HEAD'].includes(method)?{}:{body:Buffer.concat(chunks)})});
      const response=await worker.fetch(request,{DB:db,ASSETS:{fetch:assetsFetch},STORAGE_KIND:'sqlite'});
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));
      outgoing.end(method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));
    }catch(error){
      console.error('Request failed:',error.name);
      if(!outgoing.headersSent)outgoing.writeHead(500,{'content-type':'application/json'});
      outgoing.end(JSON.stringify({error:{code:'SERVER_ERROR'}}));
    }
  });
  try{
    if(dev){
      const {createServer}=await import('vite');
      vite=await createServer({configFile:false,server:{middlewareMode:true,hmr:{server}},appType:'spa'});
    }else await stat(resolve(root,'index.html'));
  }catch(error){db.close();throw error;}
  return {server,async close(){await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));await vite?.close();db.close();}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535');
  const app=await createNodeServer({dev:process.argv.includes('--dev')});
  app.server.listen(port,'0.0.0.0',()=>console.log(`Движение ${VERSION}: web + API listening on port ${port}`));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>app.close().then(()=>process.exit(0)).catch(()=>process.exit(1)));
}
