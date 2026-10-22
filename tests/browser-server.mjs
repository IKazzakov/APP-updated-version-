// TEST ONLY. This loopback harness, identities, clock and synthetic poses are
// never imported by the production Worker or copied into dist/client.
import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {dirname,resolve,relative,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleApi} from '../server/api.js';
import worker from '../server/worker.js';
import {createTestDatabase} from './server-db.js';
import {build} from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const clientRoot=resolve(root,'dist/client');
// Exercise the same Capacitor-dependent API module as the production bundle.
const testApiSource=(await build({entryPoints:[resolve(root,'src/api.js')],bundle:true,write:false,format:'esm',platform:'browser'})).outputFiles[0].text;
const port=Number(process.env.TESTSERVERPORT ?? 4175);
if (!Number.isInteger(port) || port<0 || port>65535) throw new Error('TESTSERVERPORT must be a local TCP port');
await stat(resolve(clientRoot,'index.html')).catch(()=>{throw new Error('No dist/client/index.html. Run npm run build before starting browser-server.');});
let db=createTestDatabase(),clockOffset=0,pose='stand';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.wasm':'application/wasm','.task':'application/octet-stream','.woff2':'font/woff2'};
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});

async function assetFetch(request) {
  const url=new URL(request.url);
  let path;
  try {path=decodeURIComponent(url.pathname);}catch{return new Response('Bad path',{status:400});}
  if (path.includes('\0')) return new Response('Bad path',{status:400});
  let file=resolve(clientRoot,`.${path==='/'?'/index.html':path}`);
  if (relative(clientRoot,file).startsWith('..')) return new Response('Not found',{status:404});
  let info=await stat(file).catch(()=>null);
  if (!info?.isFile()) {
    if (extname(path)) return new Response('Not found',{status:404});
    file=resolve(clientRoot,'index.html');info=await stat(file);
  }
  const headers={'content-type':mime[extname(file)] ?? 'application/octet-stream','content-length':String(info.size),'cache-control':'private, no-store'};
  return new Response(request.method==='HEAD'?null:await readFile(file),{status:200,headers});
}

// Pixel-space geometry is scaled uniformly by image height, then normalized
// for the requested aspect. Thus camera aspect cannot change the test angles.
function landmarks(name,width=640,height=480) {
  if(name==='missing')return [];
  const poses={
    stand:[[320,90],[320,200],[320,310],[320,420]],
    down:[[300,145],[300,255],[345,325],[320,420]],
    bottom:[[270,200],[270,320],[380,320],[380,420]],
  };
  const points=Array.from({length:33},()=>({x:0.5,y:0.15,z:0,visibility:0.99,presence:0.99}));
  const project=([x,y])=>({x:((x-320)*height/480+width/2)/width,y:y/480,z:0,visibility:0.99,presence:0.99});
  for (let side=0;side<2;side++) {
    const ids=side?[12,24,26,28]:[11,23,25,27],coords=poses[name] ?? poses.stand;
    ids.forEach((id,index)=>{points[id]=project([coords[index][0]+side*20,coords[index][1]]);});
    const ankle=coords[3];points[side?30:29]=project([ankle[0]-10+side*20,430]);points[side?32:31]=project([ankle[0]+20+side*20,430]);
  }
  return [points];
}

async function dispatch(request) {
  const url=new URL(request.url);
  if(url.pathname==='/__test/health')return json({ok:true,testOnly:true,clockOffsetMs:clockOffset,pose});
  if(url.pathname==='/__test/login') {
    const actor=url.searchParams.get('user');
    if (!['alice','bob','charlie'].includes(actor))return json({error:'Unknown test actor'},400);
    return new Response(null,{status:303,headers:{location:'/','set-cookie':`test_actor=${actor}; Path=/; HttpOnly; SameSite=Strict`,'cache-control':'no-store'}});
  }
  if(url.pathname==='/__test/logout')return new Response(null,{status:303,headers:{location:'/','set-cookie':'test_actor=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'}});
  if(url.pathname==='/__test/time'&&request.method==='POST') {
    const body=await request.json();
    if(!Number.isSafeInteger(body.advanceMs)||body.advanceMs<0||body.advanceMs>366*86400000)return json({error:'Invalid advanceMs'},400);
    clockOffset+=body.advanceMs;return json({now:Date.now()+clockOffset,offsetMs:clockOffset});
  }
  if(url.pathname==='/__test/reset'&&request.method==='POST') {
    db.close();db=createTestDatabase();clockOffset=0;pose='stand';return json({ok:true,testOnly:true});
  }
  if(url.pathname==='/__test/pose') {
    if(request.method==='POST') {
      const body=await request.json();
      if(!['stand','down','bottom','missing'].includes(body.name))return json({error:'Unknown synthetic pose'},400);
      pose=body.name;
    }
    return json({name:pose});
  }
  if(url.pathname==='/__test/landmarks') {
    const width=Number(url.searchParams.get('width')??640),height=Number(url.searchParams.get('height')??480);
    if(!(width>0&&height>0&&width<=8192&&height<=8192))return json({error:'Invalid dimensions'},400);
    return json({name:pose,landmarks:landmarks(pose,width,height)});
  }
  if(url.pathname.startsWith('/__test/source/')) {
    const name=url.pathname.slice('/__test/source/'.length);
    if(!['outbox.js','api.js','config.js','progress.js'].includes(name))return json({error:'Source not allowed'},404);
    return new Response(name==='api.js'?testApiSource:await readFile(resolve(root,'src',name)),{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'}});
  }
  if(url.pathname.startsWith('/__test/'))return json({error:'Unknown test endpoint'},404);
  // Ignore every user-supplied identity header. Only this TEST server maps its
  // own fixed test cookie to a test ID; the production Worker has no such route.
  const headers=new Headers(request.headers);
  for(const name of [...headers.keys()])if(name.startsWith('oai-authenticated-'))headers.delete(name);
  const actor=(headers.get('cookie')??'').split(';').map(item=>item.trim()).find(item=>item.startsWith('test_actor='))?.slice(11);
  if(['alice','bob','charlie'].includes(actor))headers.set('oai-authenticated-user-id',actor);
  const trusted=new Request(request,{headers});
  const env={DB:db,ASSETS:{fetch:assetFetch}};
  if(url.pathname.startsWith('/api/'))return handleApi(trusted,env,{now:()=>Date.now()+clockOffset});
  return worker.fetch(trusted,env);
}

const server=http.createServer(async(incoming,outgoing)=>{
  try {
    const method=incoming.method??'GET';
    const chunks=[];let size=0;
    for await(const chunk of incoming){size+=chunk.length;if(size>128*1024){outgoing.writeHead(413);outgoing.end();return;}chunks.push(chunk);}
    const request=new Request(`http://${incoming.headers.host??`127.0.0.1:${port}`}${incoming.url??'/'}`,{method,headers:incoming.headers,...(['GET','HEAD'].includes(method)?{}:{body:Buffer.concat(chunks)})});
    const response=await dispatch(request);
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));
    outgoing.end(method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));
  } catch(error) {
    console.error('TEST harness request failed:',error.name,error.message);
    if(!outgoing.headersSent)outgoing.writeHead(500,{'content-type':'application/json'});
    outgoing.end(JSON.stringify({error:'Test harness failure'}));
  }
});
server.once('error',error=>{console.error(`TEST harness startup failed: ${error.code??error.message}`);db.close();process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`TEST ONLY browser server ready at http://127.0.0.1:${server.address().port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
