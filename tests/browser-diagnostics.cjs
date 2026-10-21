const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/hand-landmarks.json'),'utf8'));
const worker=`
 const hands=${JSON.stringify(fixture.landmarks)};let hidden=false;
 self.onmessage=({data})=>{
  if(data.type==='hide'){hidden=true;return;}
  if(data.type==='load'){
   const info={delegate:'GPU',backendStatus:'Выбран',backendBenchmark:{samples:6,cpuMs:50,gpuMs:7.5},fallbackReason:null};
   self.postMessage({type:'backend',...info});self.postMessage({type:'ready',...info});return;
  }
  if(data.type==='frame'){
   const landmarks=hidden?[]:hands.map(h=>h.map(p=>({...p,y:(p.y*382+400)/1280})));
   data.bitmap.close();self.postMessage({type:'result',epoch:data.epoch,timestamp:data.timestamp,
    ms:hidden?2.5:7.5,inputWidth:540,inputHeight:960,delegate:'GPU',backendStatus:'Выбран',
    backendBenchmark:{samples:6,cpuMs:50,gpuMs:7.5},fallbackReason:null,landmarks,scores:[.9,.9]});
  }
 };
`;
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,
  args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const context=await browser.newContext({viewport:{width:393,height:852},permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage(),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   const RealWorker=Worker;window.__workers=[];
   window.Worker=class extends RealWorker{constructor(...args){super(...args);if(String(args[0]).includes('vision.worker'))window.__workers.push(this);}};
   navigator.mediaDevices.getUserMedia=async options=>{
    if(options.audio!==false)throw Error('Microphone was requested');
    const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;const ctx=canvas.getContext('2d');
    function draw(){ctx.fillStyle='#ddd';ctx.fillRect(0,0,720,1280);requestAnimationFrame(draw);}draw();return canvas.captureStream(30);
   };
  });
  await page.route('**/assets/vision.worker.js*',r=>r.fulfill({contentType:'text/javascript',body:worker}));
  await page.goto(process.env.TEST_URL||'http://localhost:4173');
  await page.locator('#diagnostics').evaluate(d=>d.open=true);
  assert.equal(await page.locator('#copy-fallback').isVisible(),true);
  await page.click('#copy');await page.waitForFunction(()=>document.getElementById('copy-status').textContent.includes('скопирован целиком'));
  let text=await page.locator('#copy-fallback').inputValue();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),text);
  assert.equal(JSON.parse(text).version,'1.4.1');assert.equal(JSON.parse(text).resolution,'—');
  checks.push('Real Clipboard API copies the entire visible short report before camera start');
  await page.click('#mode-clap');await page.click('#start');
  await page.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');
  await page.click('#copy');await page.waitForFunction(()=>document.getElementById('copy-status').textContent.includes('скопирован целиком'));
  text=await page.locator('#copy-fallback').inputValue();let d=JSON.parse(text);
  assert.equal(d.delegate,'GPU');assert.equal(d.inferenceMs,8);assert.equal(d.backendBenchmark.gpuMs,7.5);
  assert.equal(d.modelInput,'540 × 960');assert.match(d.resolution,/640 × 480/);assert.ok(d.fps>0);
  assert.equal(d.lastWithTwoHands.inferenceMs,7.5);assert.ok(text.length<6000);
  await page.waitForTimeout(300);assert.equal(await page.locator('#copy-fallback').inputValue(),text);
  checks.push('One report contains camera, fps, inference time, backend and two-hand measurements; preview stays frozen');
  await page.evaluate(()=>window.__workers.at(-1).postMessage({type:'hide'}));await page.waitForTimeout(500);
  await page.click('#copy');await page.waitForFunction(()=>document.getElementById('copy-status').textContent.includes('скопирован целиком'));
  d=JSON.parse(await page.locator('#copy-fallback').inputValue());
  assert.equal(d.handsDetected,0);assert.equal(d.lastWithTwoHands.inferenceMs,7.5);
  checks.push('Useful two-hand measurements survive loss of hands');
  await page.evaluate(()=>{
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Permission denied');}}});
   document.execCommand=()=>false;
  });
  await page.click('#copy');await page.waitForFunction(()=>document.getElementById('copy-status').textContent.includes('Автокопирование недоступно'));
  text=await page.locator('#copy-fallback').inputValue();assert.equal(await page.locator('#copy-fallback').isVisible(),true);
  await page.click('#select-report');
  assert.equal(await page.locator('#copy-fallback').evaluate(e=>e.selectionStart===0&&e.selectionEnd===e.value.length),true);
  assert.doesNotThrow(()=>JSON.parse(text));checks.push('Denied clipboard leaves a complete manually selectable report');
  await page.evaluate(()=>{
   document.execCommand=command=>{window.__legacyCopy=document.getElementById('copy-fallback').value;return command==='copy';};
  });
  await page.click('#copy');await page.waitForFunction(()=>document.getElementById('copy-status').textContent.includes('скопирован целиком'));
  assert.equal(await page.evaluate(()=>window.__legacyCopy),await page.locator('#copy-fallback').inputValue());
  checks.push('Legacy copy fallback receives exactly the visible report');
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});document.execCommand=()=>false;});
  await page.click('#copy');await page.waitForFunction(()=>document.getElementById('copy-status').textContent.includes('Автокопирование недоступно'));
  assert.equal(await page.locator('#copy').isEnabled(),true);assert.ok(JSON.parse(await page.locator('#copy-fallback').inputValue()).lastWithTwoHands);
  checks.push('Missing Clipboard API still provides manual copy and a usable button');
  await page.locator('.journal').evaluate(d=>d.open=true);const pendingDownload=page.waitForEvent('download');
  await page.click('#download-diagnostics');const download=await pendingDownload;
  const full=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  assert.equal(full.version,'1.4.1');assert.ok(full.trackingHistory.length>4);assert.ok(full.log.length>0);
  checks.push('Full journal downloads as valid JSON separately from the short report');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);await page.click('#stop');
  const report={version:'1.4.1',browser:await browser.version(),fixture:'Controlled recognition results; real Clipboard API and UI',checks,errors};
  fs.writeFileSync('work/browser-diagnostics-report.json',JSON.stringify(report,null,2)+'\n');
  for(const check of checks)console.log('PASS',check);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
