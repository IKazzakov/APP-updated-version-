// TEST ONLY: real application UI and API, synthetic pose worker, simulated
// Capacitor HTTP bridge. Android's permission dialog requires a physical device.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {POSE_WORKER} from './browser-pose-fixture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright-core');
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:4175';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const errors=[],results=[];
async function context(failure){
  const c=await browser.newContext({viewport:{width:393,height:852},isMobile:true,permissions:['camera'],serviceWorkers:'block'});
  c.setDefaultTimeout(15000);
  await c.route('**/assets/vision.worker.js*',r=>r.fulfill({contentType:'text/javascript',body:POSE_WORKER}));
  await c.addInitScript(({failure})=>{
    window.androidBridge={};window.nativeCalls=[];window.cameraRequests=0;
    const media=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=options=>{window.cameraRequests++;return media(options);};
    window.Capacitor={
      PluginHeaders:[{name:'CapacitorHttp',methods:[{name:'request',rtype:'promise'}]},{name:'WorkoutScreen',methods:[{name:'setEnabled',rtype:'promise'}]}],
      nativePromise:async(plugin,method,options)=>{
        if(plugin==='WorkoutScreen')return {};
        window.nativeCalls.push(options);
        if(failure==='network')throw new Error('Simulated server unavailable');
        if(failure==='html')return {status:200,data:'<html>Preview sign-in</html>'};
        const url=new URL(options.url);
        // Deliver to the real disposable API/SQLite fixture, keeping native
        // headers for assertions. fetch itself supplies the local Origin.
        const headers={...options.headers};delete headers.Origin;
        const response=await fetch('/api'+url.pathname.split('/api')[1],{method:options.method,headers,...(options.data===undefined?{}:{body:JSON.stringify(options.data)})});
        return {status:response.status,data:await response.text()};
      },
    };
  },{failure});
  const p=await c.newPage();p.on('pageerror',e=>{errors.push(e.message);console.error('Page error:',e.message);});
  await p.goto(origin);
  return {c,p};
}
async function pose(c,name,ms=450){await c.request.post(origin+'/__test/pose',{data:{name},headers:{Origin:origin}});await new Promise(r=>setTimeout(r,ms));}
try{
  await fetch(origin+'/__test/reset',{method:'POST'});
  const offline=await context('network');
  await offline.p.waitForFunction(()=>document.getElementById('server-result').textContent==='NETWORK');
  console.log('Network failure shown');
  assert.equal(await offline.p.locator('#auth-panel').isVisible(),true);
  await offline.p.locator('#today-train').click();
  assert.equal(await offline.p.locator('#start').isEnabled(),true);
  await offline.p.locator('#start').click();
  await offline.p.waitForFunction(()=>!!document.getElementById('video').srcObject);
  console.log('Camera started');
  assert.equal(await offline.p.evaluate(()=>window.cameraRequests),1);
  await pose(offline.c,'stand');await offline.p.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');
  await pose(offline.c,'down');await pose(offline.c,'bottom');await pose(offline.c,'down');await pose(offline.c,'stand',800);
  console.log('Offline state:',await offline.p.locator('#state').textContent(),await offline.p.locator('#hint').textContent(),await offline.p.locator('#count').textContent());
  await offline.p.waitForFunction(()=>Number(document.getElementById('count').textContent)>=1);
  assert.match(await offline.p.locator('#local-practice-note').textContent(),/не сохраняются/);
  assert.equal(await offline.p.evaluate(()=>window.nativeCalls.filter(c=>c.method==='POST').length),0);
  await offline.p.locator('#stop').click();await offline.p.locator('#personal-mode').click();
  assert.equal(await offline.p.locator('#start').isDisabled(),true);
  assert.match(await offline.p.locator('#local-practice-note').textContent(),/требуют подключения/);
  results.push('Сервер недоступен: камера запрошена, повторение посчитано локально, серверный раунд заблокирован с объяснением');
  await offline.p.locator('#diagnostics>summary').click();
  await offline.p.locator('#server-settings summary').click();
  await offline.p.locator('#server-url').fill('https://new-server.test/');await offline.p.locator('#server-form button').click();
  await offline.p.waitForFunction(()=>document.getElementById('server-url').value==='https://new-server.test/api');
  assert.equal(await offline.p.evaluate(()=>localStorage.getItem('movement.nativeApi')),'https://new-server.test/api');
  results.push('Адрес API меняется в APK и сохраняется после перезапуска');
  await offline.c.close();

  const html=await context('html');
  await html.p.waitForFunction(()=>document.getElementById('server-result').textContent==='HTTP 200 · API_RESPONSE_INVALID');
  assert.match(await html.p.locator('#app-error').textContent(),/страницу вместо данных/);await html.c.close();
  results.push('HTML страницы входа распознаётся как неверный ответ API с HTTP 200');

  const denied=await context('network');
  await denied.p.waitForFunction(()=>document.getElementById('server-result').textContent==='NETWORK');
  await denied.p.evaluate(()=>{navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Denied','NotAllowedError'));});
  await denied.p.locator('#today-train').click();await denied.p.locator('#start').click();
  await denied.p.waitForFunction(()=>document.getElementById('app-error').textContent.includes('настройки Android'));
  assert.equal(await denied.p.locator('#video').evaluate(v=>v.srcObject),null);await denied.c.close();
  results.push('Отказ камеры в APK объясняет путь к разрешениям Android');

  const online=await context(null);
  await online.p.locator('#auth-panel').waitFor({state:'visible'});
  await online.p.locator('#quick-guest-btn').click();
  await online.p.waitForFunction(()=>document.getElementById('connection').textContent.includes('подтверждён'));
  assert.equal(await online.p.locator('#server-result').textContent(),'HTTP 200 · OK');
  const posts=await online.p.evaluate(()=>window.nativeCalls.filter(c=>c.method==='POST'));
  assert.ok(posts.length>0);assert.ok(posts.every(p=>p.headers.Origin===new URL(p.url).origin));
  assert.ok(posts.every(p=>p.headers['x-test-user-id']));
  await online.p.locator('#today-train').click();await online.p.locator('#start').click();
  await online.p.waitForFunction(()=>!!document.getElementById('video').srcObject);
  assert.equal(await online.p.locator('#local-practice-note').isVisible(),false);
  await pose(online.c,'stand');await online.p.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');
  await pose(online.c,'down');await pose(online.c,'bottom');await pose(online.c,'down');await pose(online.c,'stand',800);
  await online.p.waitForFunction(()=>Number(document.getElementById('daily-number').textContent)>=1);
  await online.p.locator('#stop').click();
  results.push('Нативный HTTP-мост: гостевой профиль создаётся, POST передаёт Origin и ID, повторение сохраняется настоящим API в SQLite');
  await online.c.close();
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.length,results},null,2));
}finally{await browser.close();}
