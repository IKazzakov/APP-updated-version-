import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/cloudflare.js';
import {isPreviewOrigin,approveBrowserOrigin,isBrowserOriginApproved,withPreviewCors} from '../server/browser-origin.js';

const alias='https://preview-67f2889c80972c44.movement-preview.pages.dev';
const endpoint='https://movement.test/api/state';
const options=(origin=alias,method='POST',headers='authorization, CONTENT-TYPE')=>new Request(endpoint,{method:'OPTIONS',headers:{...(origin===null?{}:{Origin:origin}),'Access-Control-Request-Method':method,'Access-Control-Request-Headers':headers}});
const env={get DB(){throw new Error('preflight accessed DB');}};

test('only canonical controlled preview aliases match',()=>{
 assert.equal(isPreviewOrigin(alias),true);
 for(const origin of [null,'null','http://preview-67f2889c80972c44.movement-preview.pages.dev',alias+':443',alias+'/',alias+'?x=1',alias+'#x',alias+'.evil.test',alias+'\n','https://user@preview-67f2889c80972c44.movement-preview.pages.dev','https://67f2889c.movement-preview.pages.dev','https://movement-preview.pages.dev','https://preview-67F2889C80972C44.movement-preview.pages.dev','https://preview-67f2889c80972c44.other.pages.dev'])assert.equal(isPreviewOrigin(origin),false,String(origin));
});

test('approval is opaque, bound to request identity and snapshot',()=>{
 const request=new Request(endpoint,{method:'POST',headers:{Origin:alias}});
 const approval=approveBrowserOrigin(request);
 assert.ok(Object.isFrozen(approval));assert.deepEqual(Object.keys(approval),[]);assert.equal(JSON.stringify(approval),'{}');
 assert.equal(isBrowserOriginApproved(request,approval),true);
 for(const fake of [null,true,'approved',{},JSON.parse(JSON.stringify(approval)),Symbol('proof')])assert.equal(isBrowserOriginApproved(request,fake),false);
 for(const other of [request.clone(),new Request(endpoint,{method:'POST',headers:{Origin:alias}}),new Request(endpoint+'/other',{method:'POST',headers:{Origin:alias}}),new Request(endpoint,{method:'GET',headers:{Origin:alias}})])assert.equal(isBrowserOriginApproved(other,approval),false);
 request.headers.set('Origin','https://evil.test');assert.equal(isBrowserOriginApproved(request,approval),false);
 for(const origin of ['null','https://evil.test'])assert.equal(approveBrowserOrigin(new Request(endpoint,{headers:{Origin:origin}})),null);
 assert.equal(approveBrowserOrigin(new Request(endpoint)),null);
});

test('preflight is exact and never touches storage',async()=>{
 for(const method of ['GET','HEAD','POST'])for(const headers of ['', 'Authorization','content-type','AUTHORIZATION, Content-Type']){
  const response=await worker.fetch(options(alias,method,headers),env);
  assert.equal(response.status,204);assert.equal(await response.text(),'');
  assert.equal(response.headers.get('access-control-allow-origin'),alias);
  assert.equal(response.headers.get('access-control-allow-methods'),'GET, HEAD, POST');
  assert.equal(response.headers.get('access-control-allow-headers'),'Authorization, Content-Type');
  assert.equal(response.headers.get('access-control-max-age'),'300');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(response.headers.get('vary').split(',').map(x=>x.trim()),['Origin','Access-Control-Request-Method','Access-Control-Request-Headers']);
  assert.equal(response.headers.get('access-control-allow-credentials'),null);
 }
});

test('preflight rejects untrusted origins and invalid methods or headers',async()=>{
 for(const origin of [null,'null','https://other.test','http://preview-67f2889c80972c44.movement-preview.pages.dev',alias+':443',alias+'/','https://abc.movement-preview.pages.dev','https://user@preview-67f2889c80972c44.movement-preview.pages.dev']){
  const response=await worker.fetch(options(origin),env);assert.equal(response.status,403);assert.equal((await response.json()).error.code,'ORIGIN_FORBIDDEN');assert.equal(response.headers.get('access-control-allow-origin'),null);
 }
 for(const [method,headers] of [['DELETE',''],['get',''],['',''],['POST','X-Test-User-Id'],['POST','Authorization,'],['POST','Cookie']]){
  const response=await worker.fetch(options(alias,method,headers),env);assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_PREFLIGHT');assert.equal(response.headers.get('access-control-allow-origin'),alias);assert.equal(response.headers.get('access-control-allow-credentials'),null);
 }
});

test('CORS preserves status, cache and existing Vary',()=>{
 const response=withPreviewCors(new Response('body',{status:409,headers:{Vary:'Accept-Encoding, origin','Cache-Control':'private, no-store'}}),alias);
 assert.equal(response.headers.get('vary'),'Accept-Encoding, origin');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.status,409);
});
