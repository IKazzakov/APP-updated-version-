// Local integration checks. Test identities/clock/poses exist ONLY in the
// loopback harness, never in the deployed Worker or the real database.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require('playwright-core'));}catch{({chromium}=require('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core'));}
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:4175';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const results=[],errors=[],pages=[];
import {POSE_WORKER as worker} from './browser-pose-fixture.mjs';
async function context(actor,synthetic=true){
 const c=await browser.newContext({viewport:{width:393,height:852},deviceScaleFactor:1,isMobile:true,hasTouch:true,permissions:['camera','clipboard-read','clipboard-write'],timezoneId:'Europe/Moscow'});
 if(synthetic)await c.route('**/assets/vision.worker.js*',r=>r.fulfill({status:200,contentType:'application/javascript',body:worker}));
 const p=await c.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));
 await p.goto(`${origin}/__test/login?user=${actor}`);await p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));
 return {c,p};
}
async function post(c,path,body){const r=await c.request.post(`${origin}${path}`,{data:body,headers:{Origin:origin}});const json=await r.json();assert.equal(r.ok(),true,JSON.stringify(json));return json;}
async function pose(c,name,ms=0){await post(c,'/__test/pose',{name});if(ms)await new Promise(r=>setTimeout(r,ms));}
async function cycle(c){await pose(c,'down',320);await pose(c,'bottom',500);await pose(c,'down',240);await pose(c,'stand',600);}
try{
 const setup=await browser.newContext();await post(setup,'/__test/reset',{});await setup.close();
 const alice=await context('alice'),bob=await context('bob');
 await alice.p.locator('#profile-toggle').click();await alice.p.locator('#display-name').fill('Аня');await alice.p.locator('#profile-form button').click();
 await bob.p.locator('#profile-toggle').click();await bob.p.locator('#display-name').fill('Борис');await bob.p.locator('#profile-form button').click();
 await alice.p.locator('#today-train').click();await alice.p.locator('#start').click();
 await alice.p.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт',null,{timeout:12000});
 await cycle(alice.c);await alice.p.waitForFunction(()=>document.getElementById('count').textContent==='1');
 await alice.p.locator('#pause').click();await pose(alice.c,'bottom',400);await pose(alice.c,'stand',400);assert.equal(await alice.p.locator('#count').textContent(),'1');await alice.p.locator('#pause').click();
 await alice.p.locator('#reset').click();assert.equal(await alice.p.locator('#count').textContent(),'0');
 await alice.p.locator('#stop').click();assert.equal(await alice.p.locator('#video').evaluate(v=>v.srcObject===null),true);
 await alice.p.locator('[data-tab="today"]').click();await alice.p.waitForFunction(()=>document.getElementById('daily-number').textContent==='1');results.push('Камера, синтетический полный цикл, пауза, сброс без удаления дневного прогресса, освобождение потока');
 // Durable IndexedDB + idempotent two-tab delivery uses production Outbox code.
 await alice.p.evaluate(async()=>{const {Outbox}=await import('/__test/source/outbox.js');const s=await fetch('/api/state').then(r=>r.json());window.testQueue=new Outbox(s.profile.id,{autoRetry:false});await window.testQueue.init();});
 await alice.c.setOffline(true);
 await alice.p.evaluate(async()=>{for(let i=0;i<9;i++)await window.testQueue.add({id:crypto.randomUUID(),occurredAt:new Date().toISOString()});});
 assert.equal(await alice.p.locator('#daily-number').textContent(),'1');
 await alice.c.setOffline(false);await alice.p.reload();await alice.p.waitForFunction(()=>document.getElementById('daily-number').textContent==='10');assert.equal(await alice.p.locator('#regularity-points').textContent(),'10');results.push('Настоящий IndexedDB: девять событий переживают отсутствие сети и обновление, дневная награда однократная');
 await alice.p.locator('[data-tab="competitions"]').click();await alice.p.locator('#create-challenge').click();await alice.p.locator('#invite-created').waitFor({state:'visible'});const invite=await alice.p.locator('#invite-url').inputValue();const fragment=new URL(invite).hash;
 await bob.p.goto(origin+'/'+fragment);await bob.p.locator('#accept-challenge').waitFor({state:'visible'});await bob.p.waitForFunction(()=>!document.getElementById('accept-challenge').disabled);await bob.p.locator('#accept-challenge').click();await bob.p.locator('.competition-card').waitFor();
 await alice.p.locator('#refresh-challenges').click();await alice.p.locator('[data-attempt]').waitFor();results.push('Два отдельных тестовых входа: приглашение через интерфейс, принятие другом, имена и оставшиеся попытки');
 await alice.p.route('**/api/rounds/start',async route=>{await pose(alice.c,'missing');await alice.p.waitForTimeout(1800);const response=await route.fetch();await route.fulfill({response});});
 await alice.p.locator('[data-attempt]').first().click();await alice.p.locator('#start').click();await alice.p.waitForFunction(()=>!document.getElementById('early-stop').hidden,null,{timeout:20000});
 await pose(alice.c,'stand');await alice.p.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');await cycle(alice.c);await alice.p.waitForFunction(()=>document.getElementById('count').textContent==='1');
 const active=(await alice.c.request.get(origin+'/api/state').then(r=>r.json())).activeRound;
 // Opening a second tab must not interrupt the first tab's live round.
 const second=await alice.c.newPage();await second.goto(origin);await second.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));const activeAgain=(await alice.c.request.get(origin+'/api/state').then(r=>r.json())).activeRound;assert.equal(activeAgain.id,active.id);await second.locator('#today-train').click();await second.locator('#start').click();await second.waitForFunction(()=>document.getElementById('app-error').textContent.includes('другой вкладкой'));assert.equal(await second.locator('#video').evaluate(v=>v.srcObject===null),true);await second.close();
 await post(alice.c,'/__test/time',{advanceMs:60000});await alice.p.evaluate(()=>{const original=performance.now.bind(performance);performance.now=()=>original()+61000;});await alice.p.waitForFunction(()=>document.getElementById('round-result').textContent.includes('Результат сохранён'),null,{timeout:12000});
 await alice.p.locator('#see-progress').click();assert.equal(await alice.p.locator('#last-result').textContent(),'1');assert.equal(await alice.p.locator('.history-row').count(),1);results.push('Соревновательная минута: 5–4–3–2–1, серверный старт, полный цикл, конец по времени, результат и одна запись истории; вторая вкладка не прерывает раунд');
 const competition=(await bob.c.request.get(origin+'/api/state').then(r=>r.json())).competitions[0];
 // Other five attempts are API integration operations, with an isolated test
 // clock. This completes a competition without waiting six physical minutes.
 for(const {c,score,count} of [{c:alice.c,score:0,count:2},{c:bob.c,score:2,count:3}])for(let i=0;i<count;i++){
   const started=await post(c,'/api/rounds/start',{requestId:crypto.randomUUID(),kind:'competition',competitionId:competition.id});
   const now=started.serverNow;await post(c,'/__test/time',{advanceMs:4000});
   if(score)await post(c,'/api/repetitions',{events:Array.from({length:score},(_,j)=>({id:crypto.randomUUID(),occurredAt:now+1000+j*1000,roundId:started.round.id,elapsedMs:1000+j*1000}))});
   await post(c,'/__test/time',{advanceMs:56000});await post(c,`/api/rounds/${started.round.id}/finish`,{});
 }
 await bob.p.locator('[data-tab="competitions"]').click();await bob.p.locator('#refresh-challenges').click();await bob.p.waitForFunction(()=>document.getElementById('competition-list').textContent.includes('Победа: Борис'));results.push('Все шесть попыток завершены в отдельной тестовой базе; интерфейс показывает победителя по лучшему результату');
 await alice.p.locator('[data-tab="training"]').click();await alice.p.locator('details.diagnostics > summary').click();await alice.p.locator('#copy').click();const report=JSON.parse(await alice.p.locator('#copy-fallback').inputValue());assert.equal(report.rulesVersion,'squat-v1');assert.ok(!JSON.stringify(report).includes('Аня'));assert.ok(!JSON.stringify(report).includes(fragment.slice(8)));results.push('Диагностика копируется и видна целиком; нет имён, приглашения и координат');
 for(const item of [alice,bob]){await item.p.screenshot({path:`work/mvp-${item===alice?'mobile':'competition'}.png`,fullPage:true});assert.equal(await item.p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 const denied=await browser.newContext({viewport:{width:1280,height:900}});await denied.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:()=>Promise.reject(new DOMException('denied','NotAllowedError'))});});const dp=await denied.newPage();await dp.goto(origin+'/__test/login?user=charlie');await dp.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));await dp.locator('#today-train').click();await dp.locator('#start').click();await dp.waitForFunction(()=>document.getElementById('app-error').textContent.includes('Доступ к камере запрещён'));await dp.screenshot({path:'work/mvp-desktop.png',fullPage:true});results.push('Отказ камеры объяснён; интерфейс проверен на ширине393 и1280px без горизонтальной прокрутки');
 assert.deepEqual(errors,[]);
 await mkdir('test-results',{recursive:true});await writeFile('test-results/browser-mvp.json',JSON.stringify({date:new Date().toISOString(),synthetic:true,hostedDatabaseTouched:false,results,pageErrors:errors},null,2));console.log(JSON.stringify({passed:results.length,results,pageErrors:errors},null,2));
}catch(error){for(let i=0;i<pages.length;i++){console.error('TEST PAGE',i,await pages[i].locator('body').innerText());await pages[i].screenshot({path:`work/mvp-failure-${i}.png`,fullPage:true});}console.error({results,errors});throw error;}finally{await browser.close();}
