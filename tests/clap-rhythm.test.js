import test from 'node:test';
import assert from 'node:assert/strict';
import {ClapCounter,clapFeatures} from '../src/algorithms/clap.js';
import {readFileSync} from 'node:fs';

const feature=(distancePx,{oneMoving=false,partialHands=0,scale=100}={})=>({
  valid:true,distancePx,scale,partialHands,
  centres:oneMoving?[{x:300,y:500},{x:300+distancePx,y:500}]:[{x:500-distancePx/2,y:500},{x:500+distancePx/2,y:500}],
});
function rig(){
  const c=new ClapCounter();let time=0,count=0;
  return {c,get count(){return count;},get time(){return time;},
    send(f,dt=100){time+=dt;const r=c.update(f,time);count+=r.increment;return r;},
    arm(d=360,options={}){for(let i=0;i<8;i++)this.send(feature(d,options));assert.equal(c.phase,'open');},
  };
}
// No dwell or artificial endpoint repeats. Sampling phase varies independently
// of the physical rhythm; all distances are in one shared image coordinate space.
function continuous({hz,fps,phase=0,cycles=10,maximum=360,minimum=150,oneMoving=false,jitter=false,armDistance=360}){
  const h=rig();h.arm(armDistance,{oneMoving});
  const step=1000/fps,end=cycles*1000/hz;
  if(maximum!==armDistance)h.send(feature(maximum,{oneMoving}),100);
  const start=h.time;
  let elapsed=(phase||1)*step,i=0;
  for(;elapsed<end;elapsed+=step*(jitter?[0.9,1.1,0.95,1.05][i++%4]:1)){
    const d=(maximum+minimum)/2+(maximum-minimum)/2*Math.cos(2*Math.PI*hz*elapsed/1000);
    h.send(feature(d,{oneMoving}),start+elapsed-h.time);
  }
  for(let k=0;k<5;k++)h.send(feature(maximum,{oneMoving}),step);
  return h;
}

for(const fps of [20,30])for(const hz of [1,2,3,4]){
  test(`continuous ${hz}Hz claps at ${fps} processed fps, four sampling offsets, no endpoint holds`,()=>{
    for(const phase of [0.01,0.25,0.5,0.75])assert.equal(continuous({hz,fps,phase}).count,10,`offset ${phase}`);
  });
}
for(const fps of [30,60])for(const hz of [5,6]){
  test(`fast applause ${hz}Hz at ${fps} tracked fps with four sampling offsets`,()=>{
    for(const phase of [0.01,0.25,0.5,0.75])assert.equal(continuous({hz,fps,phase}).count,10,`offset ${phase}`);
  });
}
test('6Hz smaller strokes, one moving hand and irregular camera delivery need no endpoint holds',()=>{
  for(const phase of [0.01,.25,.5,.75])assert.equal(continuous({hz:6,fps:60,phase,maximum:230,minimum:100,oneMoving:true,jitter:true}).count,10);
});
test('an incomplete approach rearms below its starting peak instead of becoming trapped',()=>{
  const h=rig();h.arm(315);h.send(feature(245));h.send(feature(280));
  assert.equal(h.c.phase,'open');assert.equal(h.count,0);
  h.send(feature(155));h.send(feature(290));assert.equal(h.count,1);
});
test('a delayed return does not reject the next observed minimum as too soon',()=>{
  const h=rig();h.arm();h.send(feature(150),40);
  h.send({valid:false},90);h.send(feature(270),30);assert.equal(h.count,1);
  h.send(feature(130),40);h.send(feature(280),40);
  assert.equal(h.count,2,'minima are 160ms apart although completion times are 80ms apart');
});
test('10fps continuous 3Hz regression does not merge ten cycles into one',()=>{
  assert.equal(continuous({hz:3,fps:10,phase:1}).count,10);
});
test('one observed open frame finishes a close; no second endpoint frame is required',()=>{
  const h=rig();h.arm();assert.equal(h.send(feature(160)).phase,'closed');
  assert.equal(h.send(feature(360)).increment,1);assert.equal(h.count,1);
});
test('a wide initial pose does not impose that width on subsequent narrow applause',()=>{
  const h=continuous({hz:3,fps:30,maximum:280,armDistance:600});
  assert.equal(h.count,10);assert.ok(h.c.attempts.every(a=>a.returnThreshold<3));
});
test('a smaller natural stroke can reopen below the initial 2.6 calibration gate',()=>{
  for(const phase of [0.01,0.25,0.5,0.75]){
    assert.equal(continuous({hz:4,fps:30,phase,maximum:230,minimum:120}).count,10);
  }
});
test('4Hz cycles work with one moving palm and one stationary palm',()=>{
  assert.equal(continuous({hz:4,fps:30,oneMoving:true}).count,10);
});
test('variable frame intervals do not change 3Hz/4Hz counts',()=>{
  for(const hz of [3,4])assert.equal(continuous({hz,fps:30,jitter:true}).count,10);
});
test('a mostly visible palm at the edge can continue, but cannot calibrate scale',()=>{
  const h=rig();for(let i=0;i<8;i++)h.send(feature(360,{partialHands:1}));
  assert.equal(h.c.phase,'baseline');h.arm();
  h.send(feature(160,{partialHands:1}));h.send(feature(300,{partialHands:1}));
  assert.equal(h.count,1);
});
test('real landmark geometry accepts a modest partial crop and rejects an off-screen palm',()=>{
  const {landmarks}=JSON.parse(readFileSync(new URL('./fixtures/hand-landmarks.json',import.meta.url)));
  const ids=[0,5,9,13,17],xs=ids.map(i=>landmarks[0][i].x).sort((a,b)=>a-b);
  const offset=-(xs[0]+xs[1])/2;
  const partly=structuredClone(landmarks);partly[0]=partly[0].map(p=>({...p,x:p.x+offset}));
  const f=clapFeatures(partly,[],720,382);
  assert.equal(f.valid,true);assert.equal(f.partialHands,1);
  partly[0]=partly[0].map(p=>({...p,x:p.x-0.4}));
  assert.equal(clapFeatures(partly,[],720,382).code,'cropped');
});
test('holding the minimum and endpoint tremor never create additional cycles',()=>{
  const h=rig();h.arm();h.send(feature(165));
  for(let i=0;i<100;i++)h.send(feature(170+10*Math.sin(i)),33);
  assert.equal(h.count,0);h.send(feature(300));assert.equal(h.count,1);
  for(let i=0;i<100;i++)h.send(feature(300+8*Math.sin(i)),33);
  assert.equal(h.count,1);
});
test('large single-frame bounces faster than the duration floor are rejected',()=>{
  const h=rig();h.arm();h.send(feature(160),33);h.send(feature(360),33);
  assert.equal(h.count,0);assert.equal(h.c.attempts.at(-1).status,'rejected');
  h.send(feature(160));h.send(feature(360));assert.equal(h.count,1);
});
test('brief tracking gaps preserve observed close evidence but never manufacture it',()=>{
  for(const observedClose of [false,true]){
    const h=rig();h.arm();h.send(feature(observedClose?160:240),40);
    h.send({valid:false,reason:'Видна одна кисть'},40);h.send(feature(320),40);
    assert.equal(h.count,Number(observedClose));
  }
});
test('once rhythm is established, a gap longer than most of a cycle discards stale close evidence',()=>{
  const h=rig();h.arm();
  for(let i=0;i<4;i++){h.send(feature(160));h.send(feature(360));}
  assert.equal(h.count,4);assert.ok(h.c.gapBudget<=400&&h.c.gapBudget>=380);
  h.send(feature(160),40);h.send({valid:false},420);h.send(feature(360),40);
  assert.equal(h.count,4);assert.equal(h.c.phase,'baseline');
});
test('brief motion blur gap of 200ms at fast tempo does not drop cycle due to 380ms budget',()=>{
  const h=rig();h.arm();
  for(let i=0;i<4;i++){h.send(feature(160));h.send(feature(360));}
  assert.equal(h.count,4);
  h.send(feature(160),40);h.send({valid:false},200);h.send(feature(360),40);
  assert.equal(h.count,5);
});
test('after a short rhythm interruption fresh moving open observations rearm without finishing the old cycle',()=>{
 const h=rig();h.arm();for(let i=0;i<4;i++){h.send(feature(150));h.send(feature(360));}
 h.send(feature(150),40);h.send({valid:false},420);h.send(feature(310),20);
 assert.equal(h.count,4);assert.equal(h.c.phase,'baseline');assert.ok(h.c.recovery);
 h.send(feature(340),20);assert.equal(h.c.phase,'open');assert.equal(h.count,4);
 h.send(feature(160),70);h.send(feature(300),70);assert.equal(h.count,5);
 h.c.reset('Пауза');assert.equal(h.c.recovery,null);
 h.send(feature(340),20);h.send(feature(340),20);assert.equal(h.c.phase,'baseline');
});
test('completely unobserved near positions are not inferred from cadence',()=>{
  const h=rig();h.arm();
  for(let i=0;i<20;i++){h.send(feature(240),50);h.send({valid:false},50);h.send(feature(330),50);}
  assert.equal(h.count,0);assert.ok(h.c.attempts.every(a=>!a.closeObserved));
});
test('long loss rearms on fresh moving open palms without a 350ms endpoint hold',()=>{
 const h=rig();h.arm();h.send(feature(150));h.send({valid:false},1800);
 assert.equal(h.count,0);assert.equal(h.c.phase,'baseline');
 h.send(feature(400,{scale:140}),33);assert.equal(h.c.phase,'baseline');
 h.send(feature(470,{scale:140}),33);assert.equal(h.c.phase,'open');
 assert.equal(h.c.reference.scale,140);assert.equal(h.count,0,'reentry discards the old close');
 h.send(feature(210,{scale:140}),80);h.send(feature(420,{scale:140}),80);assert.equal(h.count,1);
});
test('returning with palms together cannot rearm after a long tracking loss',()=>{
 const h=rig();h.arm();h.send(feature(150));h.send({valid:false},2000);
 for(let i=0;i<20;i++)h.send(feature(150),33);
 assert.equal(h.count,0);assert.equal(h.c.phase,'baseline');
 h.send(feature(300),33);h.send(feature(370),33);assert.equal(h.c.phase,'open');assert.equal(h.count,0);
});
test('moving reacquisition rejects cropped palms, inconsistent sizes and trajectory jumps',()=>{
 const h=rig();h.arm();h.send({valid:false},2000);
 h.send(feature(360,{partialHands:1}),33);h.send(feature(420,{partialHands:1}),33);assert.equal(h.c.phase,'baseline');
 h.send(feature(360),33);h.send(feature(720,{scale:200}),33);assert.equal(h.c.phase,'baseline');
 const jumped=feature(700,{scale:200});jumped.centres=jumped.centres.map(p=>({...p,x:p.x+2000}));
 h.send(jumped,33);assert.equal(h.c.phase,'baseline');assert.equal(h.count,0);
});
test('reset, explicit pause and source changes do not inherit moving reacquisition',()=>{
 const h=rig();h.arm();h.send({valid:false},2000);assert.equal(h.c.reacquiring,true);
 h.c.reset('Пауза');assert.equal(h.c.reacquiring,false);
 h.send(feature(300),33);h.send(feature(360),33);assert.equal(h.c.phase,'baseline');
 h.c.beginReacquire('Автонастройка');h.send(feature(300),33);h.send(feature(360),33);
 assert.equal(h.c.phase,'open');assert.equal(h.count,0);
});
test('hybrid preparation tolerates missing optical frames between real neural anchors',()=>{
 const h=rig();for(let i=0;i<20;i++)h.send(i%3===0?feature(360):{valid:false},33);
 assert.equal(h.c.phase,'open');assert.equal(h.count,0);
 h.send(feature(150),80);h.send(feature(360),80);assert.equal(h.count,1);
});
test('missing optical frames between fresh separated neural observations do not force a hold',()=>{
 const h=rig();h.arm();h.send(feature(150));h.send({valid:false},2000);
 h.send(feature(300),33);h.send({valid:false},33);h.send({valid:false},33);h.send(feature(370),33);
 assert.equal(h.c.phase,'open');assert.equal(h.count,0);
 h.send(feature(150),80);h.send(feature(360),80);assert.equal(h.count,1);
});
test('one old preparation observation cannot arm after a long absence',()=>{
 const h=rig();h.send(feature(360));for(let i=0;i<12;i++)h.send({valid:false},33);
 h.send(feature(360),33);assert.equal(h.c.phase,'baseline');assert.equal(h.count,0);
});
