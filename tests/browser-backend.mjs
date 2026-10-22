// TEST ONLY: secure Worker with an isolated DB; simulated native HTTP bridge.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {POSE_WORKER} from './browser-pose-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright-core');
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:4178';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const errors=[],contexts=[],results=[];
async function actor(native=false){
 const c=await browser.newContext({viewport:{width:393,height:852},isMobile:true,permissions:['camera'],serviceWorkers:'block'});contexts.push(c);c.setDefaultTimeout(20000);
 await c.route('**/assets/vision.worker.js*',r=>r.fulfill({contentType:'text/javascript',body:POSE_WORKER}));
 if(native)await c.addInitScript(()=>{
  if(!localStorage.getItem('movement.backend-migration.2.5.2'))localStorage.setItem('movement.nativeApi','https://ais-dev-unwfcvynbcdvpumsvvws2k-220077059769.europe-west2.run.app/api');
  window.androidBridge={};window.bridgeCalls=[];
  window.Capacitor={PluginHeaders:[{name:'CapacitorHttp',methods:[{name:'request',rtype:'promise'}]},{name:'WorkoutScreen',methods:[{name:'setEnabled',rtype:'promise'}]}],nativePromise:async(plugin,method,o)=>{
   if(plugin==='WorkoutScreen')return {};
   window.bridgeCalls.push({url:o.url,method:o.method,hasBearer:!!o.headers.Authorization,testIdentity:!!o.headers['x-test-user-id'],origin:o.headers.Origin});
   const u=new URL(o.url),headers={...o.headers};delete headers.Origin;
   const r=await fetch(u.pathname+u.search,{method:o.method,headers,...(o.data===undefined?{}:{body:JSON.stringify(o.data)})});return {status:r.status,data:await r.text()};
  }};
 });
 const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(origin);await p.locator('#auth-panel').waitFor({state:'visible'});
 await p.locator('#test-username-input').fill('Одинаковое имя');await p.locator('#test-login-btn').click();await p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));
 return {c,p};
}
const state=p=>p.evaluate(async()=>{
 const key=Object.keys(localStorage).find(k=>k.startsWith('movement.device-session.'));
 return fetch('/api/state',{headers:{Authorization:`Bearer ${localStorage.getItem(key)}`}}).then(r=>r.json());
});
const pose=async(c,name)=>{await c.request.post(origin+'/__test/pose',{data:{name}});await new Promise(r=>setTimeout(r,450));};
try{
 await fetch(origin+'/__test/reset',{method:'POST'});
 const a=await actor(),b=await actor(true);
 assert.equal(await b.p.locator('#server-url').inputValue(),'https://movement-test-api.rojoscarlos93.workers.dev/api');
 const aId=(await state(a.p)).profile.id,bId=(await state(b.p)).profile.id;
 assert.notEqual(aId,bId);assert.equal((await state(a.p)).profile.displayName,(await state(b.p)).profile.displayName);
 results.push('Браузер и APK создают отдельные профили даже с одинаковым именем');
 await b.p.reload();await b.p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));assert.equal((await state(b.p)).profile.id,bId);
 results.push('После перезапуска индивидуальная сессия и профиль сохраняются');
 await b.p.locator('#today-train').click();await b.p.locator('#start').click();await pose(b.c,'stand');await b.p.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');
 for(const name of ['down','bottom','down','stand'])await pose(b.c,name);
 await b.p.waitForFunction(()=>document.getElementById('daily-number').textContent==='1');await b.p.locator('#stop').click();
 assert.equal((await state(a.p)).today.count,0);
 const calls=await b.p.evaluate(()=>window.bridgeCalls);assert.ok(calls.some(c=>c.method==='POST'&&c.hasBearer));assert.ok(calls.every(c=>!c.testIdentity));assert.ok(calls.filter(c=>c.method==='POST').every(c=>c.origin===new URL(c.url).origin));
 results.push('Камера считает; нативный HTTP отправляет Bearer и сохраняет повторение только владельцу');
 await a.p.locator('[data-tab="competitions"]').click();await a.p.locator('#create-challenge').click();await a.p.locator('#invite-created').waitFor({state:'visible'});
 const hash=new URL(await a.p.locator('#invite-url').inputValue()).hash;
 await b.p.goto(origin+'/'+hash);await b.p.locator('#accept-challenge').waitFor({state:'visible'});await b.p.locator('#accept-challenge').click();
 await b.p.waitForFunction(()=>document.getElementById('invite-accept').hidden);
 assert.equal((await state(b.p)).competitions[0].id,(await state(a.p)).competitions[0].id);
 results.push('Дуэль создаётся и принимается между браузером и APK с индивидуальной авторизацией');
 await b.p.locator('#profile-toggle').click();await b.p.locator('#sign-out-btn').click();await b.p.locator('#auth-panel').waitFor({state:'visible'});
 assert.equal(await b.p.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('movement.device-session.'))),false);
 await b.p.locator('#quick-guest-btn').click();await b.p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));
 const after=await state(b.p);assert.notEqual(after.profile.id,bId);assert.equal(after.today.count,0);assert.equal(after.competitions.length,0);
 results.push('Выход отзывает сессию; новый гостевой профиль не получает чужие повторения или дуэли');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.length,results,pageErrors:errors},null,2));
}finally{for(const c of contexts)await c.close();await browser.close();}
