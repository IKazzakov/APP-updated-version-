const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');const assert=require('node:assert/strict');const fs=require('node:fs');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});try{const context=await browser.newContext({viewport:{width:393,height:852}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__diagnostic=text}});
  window.__shift=0;window.__hideHands=false;window.__streams=[];
  navigator.mediaDevices.getUserMedia=async options=>{
   if(options.audio!==false)throw Error('Unexpected audio request');
   const image=new Image();image.src='/__test__/hands.jpg';await image.decode();const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;const ctx=canvas.getContext('2d');
   let displayed=0,last=performance.now();
   function draw(now=performance.now()){
    const step=Math.max(0,Math.min(50,now-last))*.3;last=now;
    // Smooth the scripted target into continuous image motion. Instantaneous
    // 30px teleports previously tested re-detection rather than a hand stroke.
    displayed+=Math.max(-step,Math.min(step,window.__shift-displayed));
    ctx.fillStyle='white';ctx.fillRect(0,0,720,1280);
    if(!window.__hideHands){ctx.drawImage(image,0,0,360,382,displayed,420,360,382);ctx.drawImage(image,360,0,360,382,360-displayed,420,360,382);}
    requestAnimationFrame(draw);
   }draw();const stream=canvas.captureStream(30);window.__streams.push(stream);return stream;
  };
 });
 await page.route('**/__test__/hands.jpg',r=>r.fulfill({path:require('node:path').join(__dirname,'fixtures','hands.jpg'),contentType:'image/jpeg'}));await page.goto(process.env.TEST_URL||'http://localhost:4173');await page.click('#mode-clap');await page.click('#start');await page.locator('#diagnostics').evaluate(d=>d.open=true);
 await page.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт',{},{timeout:45000});console.log('PASS real hands recognized and open baseline established');
 const painted=await page.locator('#overlay').evaluate(c=>{const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<data.length;i+=4)if(data[i])n++;return n;});assert.ok(painted>100);console.log('PASS hand overlay visible',painted);
 await page.click('#copy');let d=await page.evaluate(()=>JSON.parse(window.__diagnostic));assert.equal(d.version,'1.4.1');assert.equal(d.handsDetected,2);assert.equal(d.modelInput,'640 × 480');console.log('PASS camera profile, version and hand diagnostics',JSON.stringify({source:d.trackingSource,anchor:d.motionAnchor,motion:d.motion}));
 for(const shift of [30,60,90,110,120,130,120,100,70,40,0]){await page.evaluate(x=>window.__shift=x,shift);await page.waitForTimeout(100);}
 try{await page.waitForFunction(()=>Number(document.getElementById('count').textContent)===1,{},{timeout:5000});}catch(e){await page.click('#copy');const failed=await page.evaluate(()=>JSON.parse(window.__diagnostic));fs.writeFileSync('work/clap-browser-failed.json',JSON.stringify(failed,null,2));console.log('FAILED EVIDENCE',JSON.stringify({fps:failed.fps,ms:failed.inferenceMs,states:failed.trackingHistory.filter((r,i,a)=>i===0||r.phase!==a[i-1].phase||r.featureReason!==a[i-1].featureReason),min:Math.min(...failed.trackingHistory.filter(r=>r.valid).map(r=>r.ratio)),log:failed.log}));throw e;}await page.click('#copy');d=await page.evaluate(()=>JSON.parse(window.__diagnostic));assert.ok(d.attempts.some(x=>x.status==='counted'&&x.closeObserved));console.log('PASS real detector + features + app count one controlled approach/open cycle',JSON.stringify({fps:d.fps,ms:d.inferenceMs,states:[...new Set(d.trackingHistory.map(x=>x.phase))]}));
 await page.waitForTimeout(600);
 const slow=[...Array.from({length:12},(_,i)=>(i+1)*10),...Array.from({length:12},(_,i)=>110-i*10)];
 for(const shift of slow){await page.evaluate(x=>window.__shift=x,shift);await page.waitForTimeout(180);}
 await page.waitForFunction(()=>Number(document.getElementById('count').textContent)===2,{},{timeout:5000});
 await page.evaluate(()=>window.__hideHands=true);await page.waitForTimeout(1800);await page.click('#copy');d=await page.evaluate(()=>JSON.parse(window.__diagnostic));
 assert.equal(d.handsDetected,0);assert.equal(d.count,2);assert.equal(d.attempts.filter(a=>a.status==='counted').length,2);assert.equal(d.currentAttempt,null);
 assert.ok(d.attempts.every(a=>a.referenceScalePx>0&&a.minimumDistancePx>0&&a.closeObserved));
 console.log('PASS slow cycle counts, and attempt summaries survive hands leaving camera',JSON.stringify(d.attempts.map(a=>({status:a.status,minimum:a.minimumRatio,reference:a.referenceRatio}))));
 await page.click('#pause');assert.equal(await page.locator('#state').textContent(),'Пауза');await page.click('#pause');await page.click('#reset');assert.equal(await page.locator('#count').textContent(),'0');await page.click('#stop');assert.equal(await page.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);assert.deepEqual(errors,[]);
 fs.writeFileSync('work/clap-browser-report.json',JSON.stringify({browser:await browser.version(),overlayPixels:painted,diagnostic:d,errors,fixture:'Generated portrait camera with translated public test-image hands; not a real human clap'},null,2));console.log('PASS pause, reset, stream stop; no JS errors');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
