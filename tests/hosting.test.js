import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.js';

test('API requires authenticated identity and cannot fall through to HTML',async()=>{
  let assets=0;
  const response=await worker.fetch(new Request('https://exercise.test/api/state'),{ASSETS:{fetch(){assets++;return new Response('wrong');}}});
  assert.equal(response.status,401);
  assert.equal(assets,0);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal((await response.json()).error.code,'SIGN_IN_REQUIRED');
});

test('static HTML is private and camera permission excludes microphone',async()=>{
  const response=await worker.fetch(new Request('https://exercise.test/'),{ASSETS:{fetch:async()=>new Response('<html lang="ru"></html>',{headers:{'content-type':'text/html; charset=utf-8','cache-control':'public,max-age=3600'}})}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.match(response.headers.get('permissions-policy'),/camera=\(self\), microphone=\(\)/);
});

test('model and WASM use the asset binding without response conversion',async()=>{
  const bytes=new Uint8Array([0,97,115,109]);
  const request=new Request('https://exercise.test/assets/wasm/vision.wasm');
  let forwarded;
  const response=await worker.fetch(request,{ASSETS:{fetch:async value=>{forwarded=value;return new Response(bytes,{headers:{'content-type':'application/wasm'}});}}});
  assert.equal(forwarded,request);
  assert.equal(response.headers.get('content-type'),'application/wasm');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
});

test('non-API asset writes are rejected',async()=>{
  const response=await worker.fetch(new Request('https://exercise.test/',{method:'POST'}),{});
  assert.equal(response.status,405);
});
