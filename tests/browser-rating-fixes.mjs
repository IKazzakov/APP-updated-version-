// Isolated test database and identities. Never points at the deployed Site.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require('playwright-core'));}catch{({chromium}=require('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core'));}
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:4175';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const results=[],errors=[],contexts=[];
async function post(c,path,data){const r=await c.request.post(origin+path,{data,headers:{Origin:origin}});const b=await r.json();assert.equal(r.ok(),true,JSON.stringify(b));return b;}
async function state(c){return (await c.request.get(origin+'/api/state')).json();}
async function actor(user){const c=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true}),p=await c.newPage();contexts.push(c);p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/__test/login?user='+user);await p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));return {c,p};}
try{
  const setup=await browser.newContext();await post(setup,'/__test/reset',{});await setup.close();
  const a=await actor('alice'),b=await actor('bob');
  assert.equal((await state(a.c)).profile.rankingsEnabled,true);await a.p.locator('#profile-toggle').click();assert.equal(await a.p.locator('#rankings-excluded').isChecked(),false);assert.ok((await a.p.locator('#profile-panel').textContent()).replace(/\s+/g,' ').includes('Не участвовать в общих рейтингах'));await a.p.locator('#profile-toggle').click();
  let requests=0,fail=false;
  await a.p.route(/\/api\/(?:v2\/)?leaderboards(?:\?|$)/,async route=>{requests++;await a.p.waitForTimeout(350);if(fail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SERVER_ERROR'}})});return route.continue();});
  await a.p.locator('[data-tab="competitions"]').click();await a.p.locator('#competition-tab-points').click();await a.p.waitForFunction(()=>document.querySelectorAll('#league-table tbody tr').length===2&&!document.getElementById('refresh-league').disabled);
  await a.p.evaluate(()=>{window.emptyTableRenders=0;window.loadingRenders=0;new MutationObserver(()=>{if(!document.querySelector('#league-table tbody'))window.emptyTableRenders++;if(document.getElementById('league-status').textContent.includes('Загружаем'))window.loadingRenders++;}).observe(document.getElementById('league-panel'),{childList:true,subtree:true});});
  const first=requests;
  for(let i=0;i<5;i++){await a.p.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'movement.sync.test',newValue:String(Math.random())})));await a.p.waitForTimeout(200);}
  await a.p.waitForTimeout(11500); // Includes the real 10-second empty-outbox tick.
  assert.equal(requests,first);assert.equal(await a.p.evaluate(()=>window.emptyTableRenders),0);assert.equal(await a.p.evaluate(()=>window.loadingRenders),0);
  results.push('Открытый рейтинг переживает повторы общего состояния и реальный 10-секундный тик очереди без перезагрузок и очистки таблицы');
  await a.p.locator('#refresh-league').evaluate(b=>{b.click();b.click();});await a.p.waitForTimeout(100);assert.equal(await a.p.locator('#league-table tbody tr').count(),2);await a.p.waitForFunction(()=>!document.getElementById('refresh-league').disabled);assert.equal(requests,first+1);
  fail=true;await a.p.locator('#refresh-league').click();await a.p.waitForFunction(()=>document.getElementById('league-status').textContent.startsWith('Не удалось'));assert.equal(await a.p.locator('#league-table tbody tr').count(),2);assert.ok((await a.p.locator('#league-status').textContent()).includes('предыдущие'));fail=false;await a.p.locator('#refresh-league').click();await a.p.waitForFunction(()=>!document.getElementById('refresh-league').disabled);
  await a.p.locator('#competition-tab-result').click();await a.p.locator('#competition-tab-points').click();await a.p.waitForFunction(()=>document.querySelectorAll('#league-table tbody tr').length===2&&!document.getElementById('refresh-league').disabled);await a.p.waitForTimeout(600);assert.equal(await a.p.locator('#league-title').textContent(),'Баллы за движение');
  results.push('Ручное обновление сохраняет строки, двойной клик отправляет один запрос, ошибки и поздние ответы вкладок не стирают/не подменяют данные');
  await a.p.locator('#profile-toggle').click();await a.p.locator('#rankings-excluded').check();await a.p.locator('#profile-form button').click();await a.p.waitForFunction(()=>document.querySelectorAll('#league-table tbody tr').length===1&&!document.getElementById('refresh-league').disabled);assert.equal((await state(a.c)).profile.rankingsEnabled,false);
  await a.p.reload();await a.p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));await a.p.locator('#profile-toggle').click();assert.equal(await a.p.locator('#rankings-excluded').isChecked(),true);await a.p.locator('#rankings-excluded').uncheck();await a.p.locator('#profile-form button').click();await a.p.locator('#profile-panel').waitFor({state:'hidden'});assert.equal((await state(a.c)).profile.rankingsEnabled,true);
  results.push('Участие включено по умолчанию; галочка отказа скрывает пользователя, сохраняется после перезагрузки и снимается обратно');
  await a.p.locator('[data-tab="competitions"]').click();await a.p.locator('#create-challenge').click();await a.p.locator('#cancel-created-challenge').waitFor({state:'visible'});const link=await a.p.locator('#invite-url').inputValue();await a.p.locator('#cancel-created-challenge').click();await a.p.locator('#invite-created').waitFor({state:'hidden'});assert.ok((await a.p.locator('#competition-list').textContent()).includes('Вызов отменён'));assert.equal((await state(a.c)).competitions[0].canCancel,false);assert.equal((await state(a.c)).activeRound,null);
  await b.p.goto(origin+'/'+new URL(link).hash);await b.p.waitForFunction(()=>document.getElementById('invite-preview').textContent.includes('Автор отменил'));assert.equal(await b.p.locator('#accept-challenge').isDisabled(),true);
  await a.p.locator('#create-challenge').click();await a.p.locator('#invite-created').waitFor({state:'visible'});const second=await a.p.locator('#invite-url').inputValue();await b.p.goto(origin+'/'+new URL(second).hash);await b.p.waitForFunction(()=>!document.getElementById('accept-challenge').disabled);await b.p.locator('#accept-challenge').click();await a.p.locator('#refresh-challenges').click();await a.p.locator('[data-attempt]').waitFor({state:'visible'});assert.equal(await a.p.locator('[data-cancel-challenge]').count(),0);assert.equal(await a.p.locator('#cancel-created-challenge').isVisible(),false);
  results.push('Автор отменяет непринятый вызов через интерфейс; старая ссылка недействительна, новая принимается, принятую дуэль отменить нельзя');
  assert.deepEqual(errors,[]);await mkdir('test-results',{recursive:true});await writeFile('test-results/browser-rating-fixes.json',JSON.stringify({results,pageErrors:errors,testDatabase:true,realPhoneVerified:false},null,2));console.log(JSON.stringify({passed:results.length,results,pageErrors:errors},null,2));
}finally{await browser.close();}
