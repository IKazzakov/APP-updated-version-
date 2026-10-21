// Browser integration tolerates one missed cycle per ten under real scheduling
// jitter (the requested 90% target); deterministic unit sequences require 10/10.
// Real pixels + real optical worker + delayed controlled
// neural anchors. This validates scheduling, not physical applause accuracy.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const assert=require('node:assert/strict'),fs=require('node:fs');
const worker=`
let hidden=false;
self.onmessage=async({data})=>{
 if(data.type==='load'){self.postMessage({type:'ready'});return;}
 if(data.type==='hide'){hidden=data.hidden;return;}
 if(data.type!=='frame')return;
 const canvas=new OffscreenCanvas(data.bitmap.width,data.bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(data.bitmap,0,0);
 const d=ctx.getImageData(0,0,1,1).data[0]/2;data.bitmap.close();
 const landmarks=hidden?[]:[0,1].map(j=>Array.from({length:21},(_,i)=>{
  const xy=i===0?[0,12]:i===5?[-9,-3]:i===9?[0,-8]:i===13?[5,-5]:i===17?[9,0]:[(i%4-1.5)*5,-8-Math.floor(i/4)*2];
  return {x:(120+(j?1:-1)*d/2+xy[0])/240,y:(90+xy[1])/180,z:0};
 }));
 await new Promise(r=>setTimeout(r,55));
 self.postMessage({type:'result',epoch:data.epoch,timestamp:data.timestamp,ms:55,inputWidth:640,inputHeight:480,delegate:'CPU',landmarks,scores:[1,1]});
};`;
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:393,height:852}}),errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.__wave=null;window.__hidden=false;window.__streams=[];window.__neural=null;
   const WorkerClass=Worker;window.Worker=class extends WorkerClass{constructor(...args){super(...args);if(String(args[0]).includes('vision.worker'))window.__neural=this;}};
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>window.__report=t}});
   navigator.mediaDevices.getUserMedia=async options=>{
    if(options.audio!==false)throw Error('Microphone requested');
    const small=document.createElement('canvas');small.width=240;small.height=180;const s=small.getContext('2d');
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;
    // Independent nonperiodic, spatially smoothed textures. Repeating sine
    // stripes make two patches visually indistinguishable at a close overlap.
    const textures=[0,1].map(j=>{
     let seed=12345+j*78127;let a=Array.from({length:64*64},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return 60+(seed>>>24)*.6;});
     for(let pass=0;pass<2;pass++){const b=a.slice();for(let y=1;y<63;y++)for(let x=1;x<63;x++){const k=y*64+x;b[k]=(a[k]*4+a[k-1]*2+a[k+1]*2+a[k-64]*2+a[k+64]*2+a[k-65]+a[k-63]+a[k+63]+a[k+65])/16;}a=b;}
     return a;
    });
    const texture=(j,x,y)=>{x+=32;y+=32;const ix=Math.floor(x),iy=Math.floor(y),dx=x-ix,dy=y-iy,k=iy*64+ix,a=textures[j];return (1-dy)*((1-dx)*a[k]+dx*a[k+1])+dy*((1-dx)*a[k+64]+dx*a[k+65]);};
    function draw(){
     const wave=window.__wave,elapsed=wave?performance.now()-wave.start:-1;
     const d=wave&&elapsed>=0&&elapsed<wave.cycles*1000/wave.hz?62+38*Math.cos(2*Math.PI*wave.hz*elapsed/1000):100;
     const im=s.createImageData(240,180);for(let i=0;i<im.data.length;i+=4){im.data[i]=im.data[i+1]=im.data[i+2]=25;im.data[i+3]=255;}
     if(!window.__hidden)for(let j=0;j<2;j++){
      const cx=120+(j?1:-1)*d/2;
      for(let y=65;y<=114;y++)for(let x=Math.floor(cx-15);x<cx+16;x++){
       const px=x-cx,py=y-90;if((px/15)**2+(py/25)**2>1)continue;
       const k=(y*240+x)*4,v=texture(j,px,py);im.data[k]=im.data[k+1]=im.data[k+2]=v;
      }
     }
     s.putImageData(im,0,0);s.fillStyle='rgb('+Math.round(d*2)+',0,0)';s.fillRect(0,0,4,4);ctx.drawImage(small,0,0,640,480);requestAnimationFrame(draw);
    }draw();const stream=canvas.captureStream(60);window.__streams.push(stream);return stream;
   };
  });
  await page.route('**/assets/vision.worker.js*',r=>r.fulfill({contentType:'text/javascript',body:worker}));
  await page.goto(process.env.TEST_URL||'http://localhost:4173');await page.click('#mode-clap');await page.click('#start');await page.locator('#diagnostics').evaluate(d=>d.open=true);
  try{await page.waitForFunction(()=>document.getElementById('state').textContent==='Идёт подсчёт',{},{timeout:20000});}catch(e){await page.click('#copy');console.log('DEBUG',await page.locator('#copy-fallback').inputValue());throw e;}
  async function report(){await page.click('#copy');return page.evaluate(()=>JSON.parse(window.__report));}
  let d=await report();assert.equal(d.trackingSource,'Модель + оптический трекер');assert.equal(d.autoProfile.camera.id,'fast-60');
  for(const hz of [5,6]){
   const before=Number(await page.locator('#count').textContent());
   await page.evaluate(hz=>window.__wave={hz,cycles:10,start:performance.now()+200},hz);
   await page.waitForTimeout(200+10000/hz+450);d=await report();
   const result={hz,expected:10,counted:d.count-before,neuralFps:d.fps,motionFps:d.motion.fps,deliveredFps:d.cameraDeliveredFps};results.push(result);
   if(result.counted<9||result.counted>10){console.log('FAILED',JSON.stringify(d));await page.locator('.journal').evaluate(d=>d.open=true);const download=page.waitForEvent('download');await page.click('#download-diagnostics');const file=await download;fs.copyFileSync(await file.path(),'work/browser-fast-failed.json');}assert.ok(result.counted>=9&&result.counted<=10,JSON.stringify(result));assert.ok(d.motion.fps>d.fps*1.5);assert.equal(d.trackingSource,'Модель + оптический трекер');
   console.log('PASS separate workers, fast pixels and delayed NN',JSON.stringify(result));
  }
  // A genuinely missing image cannot be recovered from cadence or NN alone.
  const total=d.count;await page.evaluate(()=>{window.__hidden=true;window.__neural.postMessage({type:'hide',hidden:true});});await page.waitForTimeout(1000);
  assert.equal((await report()).count,total);
  await page.evaluate(()=>{window.__hidden=false;window.__wave=null;window.__neural.postMessage({type:'hide',hidden:false});});await page.waitForTimeout(900);
  assert.equal((await report()).count,total);
  await page.click('#pause');assert.equal(await page.locator('#state').textContent(),'Пауза');await page.click('#pause');await page.waitForTimeout(2600);
  assert.equal((await report()).count,total);await page.click('#reset');assert.equal(await page.locator('#count').textContent(),'0');
  await page.click('#stop');assert.equal(await page.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);assert.deepEqual(errors,[]);
  fs.writeFileSync('work/browser-fast-report.json',JSON.stringify({version:'1.4.1',browser:await browser.version(),fixture:'Generated textured hands; real optical worker; controlled neural coordinates delayed 55ms; not human applause',results,errors},null,2));
  console.log('PASS actual tracking loss, return, pause, reset, stream cleanup');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
