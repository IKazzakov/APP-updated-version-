// Real optical worker with deliberately textureless images plus controlled NN.
// Poor texture must not permanently disable the hybrid pipeline. Real Tasks
// Vision recognition is tested separately in browser-claps.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const fs=require('node:fs');const assert=require('node:assert/strict');
const fixture=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'fixtures/hand-landmarks.json')));
const worker=`
 const original=${JSON.stringify(fixture.landmarks)},ids=[0,5,9,13,17];
 const points=original.map(hand=>hand.map(p=>({x:p.x*720,y:p.y*382})));
 const centres=points.map(p=>({x:ids.reduce((a,i)=>a+p[i].x,0)/5,y:ids.reduce((a,i)=>a+p[i].y,0)/5}));
 const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
 const sizes=points.map(p=>(dist(p[0],p[9])+dist(p[5],p[17]))/2),factor=100/((sizes[0]+sizes[1])/2);
 let wave=null,hidden=false;
 self.onmessage=({data})=>{
   if(data.type==='testWave'){wave=data.wave;hidden=!!data.hidden;return;}
   if(data.type==='load'){self.postMessage({type:'ready',delegate:'CPU'});return;}
   if(data.type!=='frame')return;
   const elapsed=wave?data.timestamp-wave.startAt:-1;
   const active=wave&&elapsed>=0&&elapsed<wave.cycles*1000/wave.hz;
   const distance=active?255+105*Math.cos(2*Math.PI*wave.hz*elapsed/1000):360;
   const landmarks=hidden?[]:points.map((hand,j)=>hand.map(p=>({
     x:((wave?.oneMoving?(j?180+distance:180):320+(j?distance/2:-distance/2))+(p.x-centres[j].x)*factor)/640,
     y:(240+(p.y-centres[j].y)*factor)/480,
   })));
   data.bitmap.close();
   self.postMessage({type:'result',epoch:data.epoch,timestamp:data.timestamp,ms:1,inputWidth:640,inputHeight:480,
     delegate:'CPU',backendStatus:'Контрольные координаты',landmarks,scores:[0.51,0.51]});
 };
`;
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,
   args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:393,height:852}}),errors=[],report=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.__workers=[];window.__streams=[];const OriginalWorker=Worker;
    window.Worker=class extends OriginalWorker{constructor(...args){super(...args);if(String(args[0]).includes('vision.worker'))window.__workers.push(this);}};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__diagnostic=text}});
    navigator.mediaDevices.getUserMedia=async options=>{
      if(options.audio!==false)throw Error('Unexpected microphone request');
      const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;
      const ctx=canvas.getContext('2d');function draw(){ctx.fillStyle='#eee';ctx.fillRect(0,0,720,1280);requestAnimationFrame(draw);}draw();
      const stream=canvas.captureStream(30);window.__streams.push(stream);return stream;
    };
  });
  await page.route('**/assets/vision.worker.js*',r=>r.fulfill({contentType:'text/javascript',body:worker}));
  await page.goto(process.env.TEST_URL||'http://localhost:4173');
  await page.click('#mode-clap');await page.click('#start');
  await page.locator('#diagnostics').evaluate(d=>d.open=true);
  await page.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт');
  async function diagnostic(){await page.click('#copy');return page.evaluate(()=>JSON.parse(window.__diagnostic));}
  assert.equal((await diagnostic()).trackingSource,'Модель + оптический трекер');
  let total=0;
  for(const {hz,oneMoving} of [{hz:2},{hz:3},{hz:4},{hz:4,oneMoving:true}]){
    await page.evaluate(({hz,oneMoving})=>window.__workers.at(-1).postMessage({type:'testWave',wave:{hz,oneMoving,cycles:10,startAt:performance.now()+100}}),{hz,oneMoving});
    await page.waitForTimeout(100+10000/hz+400);
    const d=await diagnostic();total+=10;
    report.push({hz,oneMoving:!!oneMoving,expected:10,counted:d.count-(total-10),processedFps:d.fps});
    assert.equal(d.count,total,JSON.stringify(report.at(-1)));
    console.log('PASS continuous app rhythm',JSON.stringify(report.at(-1)));
  }
  const healthy=await diagnostic();assert.equal(healthy.trackingSource,'Модель + оптический трекер');
  assert.equal(healthy.motionFallback,null);assert.equal(healthy.motion.opticalValidFrames,0);
  // A true long disappearance must discard the old stroke, then continuous
  // new motion must rearm without asking the user to hold an endpoint.
  await page.evaluate(()=>window.__workers.at(-1).postMessage({type:'testWave',hidden:true}));
  await page.waitForTimeout(1200);assert.equal((await diagnostic()).count,total);
  await page.evaluate(()=>window.__workers.at(-1).postMessage({type:'testWave',wave:{hz:3,cycles:10,startAt:performance.now()+100}}));
  await page.waitForTimeout(100+10000/3+500);
  const recovered=await diagnostic(),added=recovered.count-total;
  assert.ok(added>=9&&added<=10,`long-loss recovery: ${added}/10`);total=recovered.count;
  assert.equal(recovered.trackingSource,'Модель + оптический трекер');
  report.push({scenario:'long-loss recovery without an endpoint hold',expected:10,counted:added});
  console.log('PASS long tracking loss, moving reacquisition, no permanent fallback',added);
  // Pause interrupts the approach before its first near minimum.
  await page.evaluate(()=>window.__workers.at(-1).postMessage({type:'testWave',wave:{hz:2,cycles:10,startAt:performance.now()+100}}));
  await page.waitForTimeout(160);await page.click('#pause');
  assert.equal(await page.locator('#state').textContent(),'Пауза');
  await page.evaluate(()=>window.__workers.at(-1).postMessage({type:'testWave',wave:null}));
  await page.click('#pause');await page.waitForTimeout(2800);
  assert.equal((await diagnostic()).count,total);
  await page.evaluate(()=>window.__workers.at(-1).postMessage({type:'testWave',hidden:true}));
  await page.waitForTimeout(900);assert.equal((await diagnostic()).count,total);
  await page.evaluate(()=>window.__workers.at(-1).postMessage({type:'testWave',hidden:false}));
  await page.waitForTimeout(700);assert.equal((await diagnostic()).count,total);
  await page.click('#reset');assert.equal(await page.locator('#count').textContent(),'0');
  await page.click('#stop');assert.equal(await page.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
  assert.deepEqual(errors,[]);
  fs.writeFileSync('work/browser-rhythm-report.json',JSON.stringify({version:'1.4.1',browser:await browser.version(),
    fixture:'Textureless generated 30fps stream, real optical/fusion Worker, controlled neural coordinates; not human applause',report,errors},null,2)+'\n');
  console.log('PASS interrupted approach, pause, missing hands, return, reset and stream stop');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
