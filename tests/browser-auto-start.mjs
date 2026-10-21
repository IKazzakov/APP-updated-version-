import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {POSE_WORKER} from './browser-pose-fixture.mjs';
const require=createRequire(import.meta.url);let chromium;try{({chromium}=require('playwright-core'));}catch{({chromium}=require('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core'));}
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:4175';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const results=[],errors=[];let page;
try{
 const context=await browser.newContext({viewport:{width:393,height:852},isMobile:true,permissions:['camera']});
 await context.route('**/assets/vision.worker.js*',r=>r.fulfill({contentType:'text/javascript',body:POSE_WORKER}));
 // Observe actual Web Audio API scheduling, without replacing the audio engine.
 await context.addInitScript(()=>{window.testTones=[];const C=window.AudioContext;if(C){const create=C.prototype.createOscillator;C.prototype.createOscillator=function(){const node=create.call(this),start=node.start.bind(node);node.start=at=>{window.testTones.push({frequency:node.frequency.value,at,state:this.state});return start(at);};return node;};}});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const post=async(path,data={})=>{const response=await context.request.post(origin+path,{data,headers:{Origin:origin}});assert.ok(response.ok(),await response.text());return response.json();};
 const state=()=>context.request.get(origin+'/api/state').then(r=>r.json());
 await post('/__test/reset');await page.goto(origin+'/__test/login?user=alice');await page.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));
 let requests=0;page.on('request',r=>{if(new URL(r.url()).pathname==='/api/rounds/start')requests++;});
 await page.locator('[data-tab="training"]').click();await page.locator('#personal-mode').click();await post('/__test/pose',{name:'stand'});await page.waitForTimeout(1000);
 assert.equal(requests,0);assert.equal(await page.locator('#video').evaluate(v=>v.srcObject===null),true);assert.equal(await page.locator('#start').textContent(),'Подготовиться');results.push('Открытие страницы и выбор минутного режима не запускают камеру или минуту');
 await page.locator('#test-sound').click();assert.ok((await page.evaluate(()=>window.testTones)).length===2);assert.ok((await page.evaluate(()=>window.testTones)).every(t=>t.state==='running'));
 await page.locator('#sound-enabled').uncheck();const mutedCount=await page.evaluate(()=>window.testTones.length);
 await post('/__test/pose',{name:'missing'});await page.locator('#start').click();await page.waitForFunction(()=>document.getElementById('preparation-status').textContent.includes('Встаньте')&&!document.getElementById('preparation-status').hidden);await page.waitForTimeout(1200);assert.equal(requests,0);assert.equal((await state()).activeRound,null);assert.equal(await page.locator('#cancel-preparation').isVisible(),true);assert.equal(await page.evaluate(()=>window.testTones.length),mutedCount);results.push('Подготовка при отсутствии тела ожидает положение, не расходует попытку; выключенный звук не играет');
 await page.locator('#sound-enabled').check();await post('/__test/pose',{name:'stand'});
 await page.waitForFunction(()=>document.getElementById('countdown').textContent==='5'&&!document.getElementById('countdown').hidden,null,{timeout:12000});assert.equal(requests,0);
 await post('/__test/pose',{name:'missing'});await page.waitForFunction(()=>document.getElementById('countdown').hidden);assert.equal(requests,0);assert.equal((await state()).activeRound,null);results.push('Потеря положения в отсчёте отменяет его до обращения к серверу');
 await post('/__test/pose',{name:'stand'});await page.waitForFunction(()=>document.getElementById('countdown').textContent==='5'&&!document.getElementById('countdown').hidden,null,{timeout:8000});
 await page.locator('#cancel-preparation').click();assert.equal(await page.locator('#video').evaluate(v=>v.srcObject===null),true);await page.waitForTimeout(600);assert.equal(requests,0);results.push('Отмена подготовительного отсчёта освобождает камеру, запуск не происходит');
 // A rejected start never shows an active minute or automatically retries it.
 await page.route('**/api/rounds/start',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVER_ERROR'}})}));
 await page.locator('#start').click();await page.waitForFunction(()=>document.getElementById('app-error').textContent.includes('Не удалось сохранить'),null,{timeout:20000});assert.equal(requests,1);assert.equal(await page.locator('#early-stop').isVisible(),false);assert.equal((await state()).activeRound,null);const tonesBeforeRetry=await page.evaluate(()=>window.testTones);assert.equal(tonesBeforeRetry.filter(t=>t.frequency===1320).length,1); // only Test signal
 await page.waitForTimeout(600);assert.equal(requests,1);results.push('Ошибка сервера не имитирует активный раунд и не вызывает повторный автоматический запрос');
 await page.unroute('**/api/rounds/start');
 await page.route('**/api/rounds/start',async route=>{await post('/__test/pose',{name:'missing'});await page.waitForTimeout(1800);const response=await route.fetch();await route.fulfill({response});});
 await page.locator('#start').click();await page.waitForFunction(()=>!document.getElementById('early-stop').hidden,null,{timeout:20000});assert.equal(requests,2);assert.equal(await page.locator('#countdown').textContent(),'Старт!');const active=(await state()).activeRound;assert.ok(active);assert.equal(active.endsAt-active.startsAt,60000);assert.equal(await page.locator('#count').textContent(),'0');
 results.push('Подтверждение через 1,8 секунды при пропавшем теле запускает минуту, без скрытой отмены');
 await post('/__test/pose',{name:'stand'});await page.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');
 for(const [name,ms] of [['down',320],['bottom',500],['down',240],['stand',600]]){await post('/__test/pose',{name});await page.waitForTimeout(ms);}
 await page.waitForFunction(()=>document.getElementById('count').textContent==='1');
 const tones=await page.evaluate(()=>window.testTones);assert.equal(tones.filter(t=>t.frequency===1320).length,2);assert.ok(tones.some(t=>t.frequency===520));assert.ok(tones.some(t=>t.frequency===660));
 await post('/__test/pose',{name:'missing'});await page.waitForTimeout(1100);assert.equal(await page.locator('#countdown').isVisible(),false);assert.equal(requests,2);assert.equal((await state()).activeRound.id,active.id);results.push('Единственное подтверждение запускает 60 секунд; потеря тела во время минуты не возвращает отсчёт');
 await post('/__test/time',{advanceMs:60000});await page.evaluate(()=>{const original=performance.now.bind(performance);performance.now=()=>original()+61000;});await page.waitForFunction(()=>document.getElementById('round-result').textContent.includes('Результат сохранён'),null,{timeout:12000});assert.ok((await page.evaluate(()=>window.testTones)).some(t=>t.frequency===330));assert.ok((await page.locator('#round-result').textContent()).includes('Время вышло'));assert.equal(await page.locator('#countdown').textContent(),'Время вышло');const finished=await state();assert.equal(finished.rounds.length,1);assert.equal(finished.rounds[0].count,1);
 await post('/__test/pose',{name:'stand'});await page.waitForTimeout(1200);assert.equal(requests,2);assert.equal((await state()).rounds.length,1);assert.equal(await page.locator('#start').textContent(),'Подготовиться');results.push('Окончание даёт отдельный сигнал, один сохранённый результат и требует новой явной подготовки');
 assert.deepEqual(errors,[]);await mkdir('test-results',{recursive:true});await writeFile('test-results/browser-auto-start.json',JSON.stringify({syntheticCamera:true,realPhoneAudioVerified:false,results,pageErrors:errors},null,2));await page.screenshot({path:'work/auto-start-mobile.png',fullPage:true});console.log(JSON.stringify({passed:results.length,results,pageErrors:errors},null,2));
}catch(e){if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:'work/auto-start-error.png',fullPage:true});}throw e;}finally{await browser.close();}
