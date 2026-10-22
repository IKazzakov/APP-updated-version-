// TEST ONLY: secure Worker with an isolated DB; simulated native HTTP bridge.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {POSE_WORKER,OBSERVE_POSES} from './browser-pose-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require('playwright-core');
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:4178';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const errors=[],contexts=[],results=[];
async function actor(native=false){
 const c=await browser.newContext({viewport:{width:393,height:852},isMobile:true,permissions:['camera'],serviceWorkers:'block'});contexts.push(c);c.setDefaultTimeout(20000);
 await c.route('**/assets/vision.worker.js*',r=>r.fulfill({contentType:'text/javascript',body:POSE_WORKER}));
 await c.addInitScript(OBSERVE_POSES);
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
 if(native){
  await p.waitForFunction(()=>document.getElementById('server-result').textContent.includes('DEVICE_AUTH_REQUIRED'));
  assert.match(await p.locator('#connection').textContent(),/Сервер доступен.*Быстрый старт/);
  assert.equal(await p.locator('#connection').evaluate(el=>el.classList.contains('warning')),false);
  await p.locator('#profile-toggle').click();
  assert.equal(await p.locator('#profile-panel').isVisible(),false);
  assert.equal(await p.locator('#auth-panel').isVisible(),true);
  await p.locator('#diagnostics>summary').click();
  assert.equal(await p.locator('#retry-sync').isVisible(),false);
  await p.locator('#diagnostics-sign-in').click();
  assert.equal(await p.locator('#diagnostics').evaluate(el=>el.open),false);
  assert.equal(await p.locator('#quick-guest-btn').evaluate(el=>document.activeElement===el),true);
  const posts=await p.evaluate(()=>window.bridgeCalls.filter(call=>call.method==='POST').length);
  assert.equal(posts,0);
  results.push('Первый запуск APK: 401 объясняет вход, профиль и диагностика ведут к гостевому старту без создания лишних сессий');
 }
 await p.locator('#test-username-input').fill('Одинаковое имя');await p.locator('#test-login-btn').click();await p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));
 return {c,p};
}
const state=p=>p.evaluate(async()=>{
 const key=Object.keys(localStorage).find(k=>k.startsWith('movement.device-session.'));
 return fetch('/api/state',{headers:{Authorization:`Bearer ${localStorage.getItem(key)}`}}).then(r=>r.json());
});
const pose=async(actor,name)=>{await actor.c.request.post(origin+'/__test/pose',{data:{name}});await actor.p.waitForFunction(expected=>window.testPoseFrames.name===expected,name);await actor.p.waitForTimeout(650);};
try{
 await fetch(origin+'/__test/reset',{method:'POST'});
 const a=await actor(),b=await actor(true);
 assert.equal(await b.p.locator('#server-url').inputValue(),'https://movement-test-api.rojoscarlos93.workers.dev/api');
 const aId=(await state(a.p)).profile.id,bId=(await state(b.p)).profile.id;
 assert.notEqual(aId,bId);assert.equal((await state(a.p)).profile.displayName,(await state(b.p)).profile.displayName);
 results.push('Браузер и APK создают отдельные профили даже с одинаковым именем');
 await b.p.reload();await b.p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));assert.equal((await state(b.p)).profile.id,bId);
 results.push('После перезапуска индивидуальная сессия и профиль сохраняются');
 await b.p.locator('#today-train').click();await b.p.locator('#start').click();await pose(b,'stand');await b.p.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');
 for(const name of ['down','bottom','down','stand'])await pose(b,name);
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
 // Keep the last repetition in flight while the native participant presses
 // early stop. Then lose the abort response AFTER the server has committed it.
 // Retrying must preserve the original score and consume exactly one attempt.
 const repetitions=/\/api\/(?:v2\/)?repetitions$/;
 const abort=/\/api\/(?:v2\/)?rounds\/[^/]+\/abort$/;
 let release,requested,abortRequests=0,loseResponse=true;
 const held=new Promise(resolve=>release=resolve),sent=new Promise(resolve=>requested=resolve);
 await b.p.route(repetitions,async route=>{requested();await held;await route.continue();});
 await b.p.route(abort,async route=>{abortRequests++;const response=await route.fetch();if(loseResponse){loseResponse=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVER_ERROR'}})});}else await route.fulfill({response});});
 try{
  await b.c.request.post(origin+'/__test/pose',{data:{name:'stand'}});
  await b.p.locator('[data-attempt]').click();await b.p.locator('#start').click();
  await b.p.waitForFunction(()=>!document.getElementById('early-stop').hidden,null,{timeout:20000});
  await b.p.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');
  for(const name of ['down','bottom','down','stand'])await pose(b,name);
  await b.p.waitForFunction(()=>document.getElementById('count').textContent==='1');
  await sent;await b.p.locator('#early-stop').click();await b.p.waitForTimeout(150);
  assert.equal(abortRequests,0,'Abort must wait for the last repetition acknowledgement');
  release();await b.p.locator('#retry-round').click();
  await b.p.waitForFunction(()=>document.getElementById('round-result').textContent.includes('Повторения засчитаны в вызове'));
  assert.match(await b.p.locator('#round-result').textContent(),/Вызов · засчитано: 1/);
  const after=await state(b.p),me=after.competitions[0].participants.find(p=>p.isYou);
  assert.equal(after.today.count,2);assert.equal(after.rounds.length,0);
  assert.equal(me.best,1);assert.equal(me.attemptsUsed,1);assert.equal(me.attemptsLeft,2);assert.equal(abortRequests,2);
  await b.p.locator('[data-tab="competitions"]').click();
  await b.p.waitForFunction(()=>document.querySelector('.competition-card .player:nth-child(2) .score').textContent==='1');
 }finally{release();await b.p.unroute(repetitions);await b.p.unroute(abort);}
 results.push('Досрочный стоп APK ждёт последнего повторения; потерянный ответ и повтор сохранения оставляют один счёт вызова, одну попытку и дневной прогресс');
 await a.p.locator('#refresh-challenges').click();
 await a.p.locator('[data-attempt]').waitFor({state:'visible'});
 await a.c.request.post(origin+'/__test/pose',{data:{name:'stand'}});
 await a.p.locator('[data-attempt]').click();await a.p.locator('#start').click();
 await a.p.waitForFunction(()=>!document.getElementById('early-stop').hidden,null,{timeout:20000});
 await a.p.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');
 for(let i=1;i<=2;i++){
  for(const name of ['down','bottom','down','stand'])await pose(a,name);
  await a.p.waitForFunction(count=>document.getElementById('count').textContent===String(count),i);
 }
 await a.p.locator('#early-stop').click();
 await a.p.waitForFunction(()=>document.getElementById('round-result').textContent.includes('Повторения засчитаны в вызове'));
 await a.p.locator('[data-tab="competitions"]').click();
 await a.p.waitForFunction(()=>document.querySelector('.competition-card .player:first-child .score').textContent==='2');
 await b.p.locator('#refresh-challenges').click();
 await b.p.waitForFunction(()=>document.querySelector('.competition-card .player:first-child .score').textContent==='2');
 const duel=(await state(a.p)).competitions[0];
 assert.deepEqual(duel.participants.map(p=>p.best),[2,1]);
 assert.equal((await state(a.p)).today.count,2);assert.equal((await state(b.p)).today.count,2);
 assert.equal((await state(a.p)).rounds.length,0);assert.equal((await state(b.p)).rounds.length,0);
 await a.p.reload();await a.p.locator('[data-tab="competitions"]').click();
 await a.p.waitForFunction(()=>document.querySelector('.competition-card .player:first-child .score').textContent==='2');
 results.push('Оба участника видят досрочные результаты 2:1, включая перезапуск; повторения не переходят между профилями и не создают рекорд за минуту');
 await b.p.locator('#profile-toggle').click();await b.p.locator('#sign-out-btn').click();await b.p.locator('#auth-panel').waitFor({state:'visible'});
 assert.equal(await b.p.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('movement.device-session.'))),false);
 await b.p.locator('#quick-guest-btn').click();await b.p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));
 const after=await state(b.p);assert.notEqual(after.profile.id,bId);assert.equal(after.today.count,0);assert.equal(after.competitions.length,0);
 results.push('Выход отзывает сессию; новый гостевой профиль не получает чужие повторения или дуэли');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.length,results,pageErrors:errors},null,2));
}finally{for(const c of contexts)await c.close();await browser.close();}
