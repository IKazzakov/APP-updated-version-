// Browser integration against the actual Pose Full Worker/WASM. Chromium's
// built-in fake camera contains no human, so this verifies loading/inference,
// controls and errors, never recognition accuracy on a real phone.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
let chromium;
try{({chromium}=require('playwright-core'));}
catch{({chromium}=require('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core'));}
const origin=process.env.MODEL_TEST_ORIGIN||'http://127.0.0.1:4177';
const browser=await chromium.launch({
  executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,
  args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],
});
const results=[],errors=[];let currentPage;
async function profilePage(context){
  const page=await context.newPage();currentPage=page;page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}${process.env.MODEL_TEST_LOGIN_PATH||'/signin-with-chatgpt?return_to=%2F'}`);
  await page.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'),null,{timeout:20000});
  await page.locator('#today-train').click();return page;
}
async function ready(page){
  await page.waitForFunction(()=>document.getElementById('model-status').textContent==='Pose Landmarker Full · Готово',null,{timeout:90000});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('#diag-values dd')).some(el=>Number(el.textContent)>0),null,{timeout:20000});
  // Inference time must be positive; the resolution itself is not a number.
  await page.waitForFunction(()=>{const d=document.getElementById('diag-values');const key=[...d.querySelectorAll('dt')].find(el=>el.textContent==='Обработка, мс');return key&&Number(key.nextElementSibling.textContent)>0;},null,{timeout:20000});
}
try{
  const context=await browser.newContext({viewport:{width:393,height:851},isMobile:true,hasTouch:true,permissions:['camera']});
  const assets=[];
  context.on('response',response=>{const path=new URL(response.url()).pathname;if(/\/assets\/(models|wasm)\//.test(path))assets.push({path,status:response.status()});});
  const page=await profilePage(context);
  await page.locator('#start').click();await ready(page);
  assert.equal(await page.locator('#app-error').isVisible(),false);
  await page.locator('details.diagnostics > summary').click();await page.locator('#copy').click();
  const diagnostic=JSON.parse(await page.locator('#copy-fallback').inputValue());
  assert.equal(diagnostic.model,'Pose Landmarker Full');assert.equal(diagnostic.modelStatus,'Готово');
  assert.ok(diagnostic.inferenceMs>0);assert.equal(diagnostic.errors.length,0);
  assert.ok(assets.some(asset=>asset.path.endsWith('pose_landmarker_full.task')&&asset.status===200));
  assert.ok(assets.some(asset=>asset.path.endsWith('.wasm')&&asset.status===200));
  await page.evaluate(()=>{window.__testCameraTracks=document.getElementById('video').srcObject.getTracks();});
  await page.locator('#diagnostics>summary').click();
  await page.locator('#stop').click();
  assert.equal(await page.evaluate(()=>document.getElementById('video').srcObject===null&&window.__testCameraTracks.every(track=>track.readyState==='ended')),true);
  results.push({case:'actual-pose-full-load',passed:true,workerInterception:false,fakeCamera:true,inferenceMs:diagnostic.inferenceMs,fps:diagnostic.fps,assets});
  await context.close();

  const failed=await browser.newContext({viewport:{width:393,height:851},permissions:['camera']});
  let blocked=0;
  const modelPattern='**/assets/models/pose_landmarker_full.task';
  await failed.route(modelPattern,route=>{blocked++;return route.fulfill({status:503,contentType:'text/plain',body:'Temporary model load test failure'});});
  const failedPage=await profilePage(failed);await failedPage.locator('#start').click();
  await failedPage.waitForFunction(()=>document.getElementById('app-error').textContent.includes('Файл модели недоступен (HTTP 503)'),null,{timeout:20000});
  assert.ok(blocked>0);assert.equal(await failedPage.locator('#app-error').isVisible(),true);
  await failedPage.waitForFunction(()=>!document.getElementById('start').disabled);
  assert.equal(await failedPage.evaluate(()=>document.getElementById('video').srcObject===null),true);
  await failed.unroute(modelPattern);await failedPage.locator('#start').click();await ready(failedPage);
  assert.equal(await failedPage.locator('#app-error').isVisible(),false);
  await failedPage.locator('#stop').click();
  results.push({case:'model-http503-and-real-retry',passed:true,readableError:true,retrySucceeded:true,stoppedFailedCamera:true});
  await failed.close();assert.deepEqual(errors,[]);
  await mkdir('test-results',{recursive:true});
  await writeFile('test-results/browser-model.json',JSON.stringify({date:new Date().toISOString(),localOnly:true,realCameraAccuracyChecked:false,results,pageErrors:errors},null,2));
  console.log(JSON.stringify({passed:results.length,results,pageErrors:errors},null,2));
}catch(error){
  if(currentPage&&!currentPage.isClosed())console.error(await currentPage.evaluate(()=>{const v=document.getElementById('video');return {hidden:document.hidden,error:document.getElementById('app-error').textContent,model:document.getElementById('model-status').textContent,video:{readyState:v.readyState,paused:v.paused,currentTime:v.currentTime,rect:v.getBoundingClientRect().toJSON()},metrics:document.getElementById('diag-values').textContent};}));
  throw error;
}finally{await browser.close();}
