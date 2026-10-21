import test from 'node:test';
import assert from 'node:assert/strict';
import {ClapCounter,clapFeatures} from '../src/algorithms/clap.js';
import {drawOverlay} from '../src/overlay.js';
import {Diagnostics} from '../src/diagnostics.js';
import {readFileSync} from 'node:fs';
const real=JSON.parse(readFileSync(new URL('./fixtures/hand-landmarks.json',import.meta.url)));
const far={valid:true,ratio:3.2,scale:100};
function harness(dt=84){const c=new ClapCounter();let t=0,count=0;return {c,send(f){t+=dt;const r=c.update(f,t);count+=r.increment;return r;},hold(f,n){let r;for(let i=0;i<n;i++)r=this.send(f);return r;},get count(){return count;}};}
const near={valid:true,ratio:1.75,scale:100};
function arm(h){h.hold(far,7);assert.equal(h.c.phase,'open');}
function canvas(){const calls={arc:0,stroke:0,clear:0};const ctx={clearRect(){calls.clear++;},beginPath(){},moveTo(){},lineTo(){},stroke(){calls.stroke++;},arc(){calls.arc++;},fill(){}};return {width:720,height:382,getContext:()=>ctx,calls};}
test('real Hand Landmarker zero visibility draws 42 hand points',()=>{const c=canvas();drawOverlay(c,real.landmarks,'clap',720,382,true);assert.equal(c.calls.arc,42);assert.equal(c.calls.stroke,42);});
test('Pose visibility filtering and show-points off remain intact',()=>{const c=canvas();drawOverlay(c,real.landmarks,'squat',720,382,true);assert.equal(c.calls.arc,0);drawOverlay(c,real.landmarks,'clap',720,382,false);assert.equal(c.calls.arc,0);assert.equal(c.calls.clear,2);});
test('ambiguous handedness does not discard detected real palms',()=>{const f=clapFeatures(real.landmarks,[0.51,0.52],720,382);assert.equal(f.valid,true);assert.ok(f.ratio>2.6);});
test('one close observation at 11.9 fps completes a cycle after reopening',()=>{const h=harness();arm(h);assert.equal(h.send(near).phase,'closed');assert.equal(h.count,0);h.hold(far,2);assert.equal(h.count,1);});
test('ten cycles at 11.9 fps produce ten counts',()=>{const h=harness();arm(h);for(let i=0;i<10;i++){h.send(near);h.hold(far,3);}assert.equal(h.count,10);});
test('single observed close plus short overlap is recoverable',()=>{const h=harness();arm(h);h.send(near);h.hold({valid:false,reason:'Видна только одна кисть'},2);assert.equal(h.count,0);h.hold(far,2);assert.equal(h.count,1);});
test('disappearance before a measured close cannot confirm a clap',()=>{const h=harness();arm(h);h.send({valid:true,ratio:2.1,scale:100});h.send({valid:false});h.hold(far,8);assert.equal(h.count,0);});
test('long loss after close cannot finish old movement on return',()=>{const h=harness();arm(h);h.send(near);h.hold({valid:false},5);h.hold(far,8);assert.equal(h.count,0);h.send(near);h.hold(far,3);assert.equal(h.count,1);});
test('loss budget starts at last valid frame and reopening needs continuity',()=>{const h=harness();arm(h);h.send(near);h.hold({valid:false},5);h.hold(far,8);assert.equal(h.count,0);});
test('holding together, small oscillations and incomplete approaches do not repeat',()=>{const h=harness();h.hold(near,15);h.hold(far,7);assert.equal(h.count,0);for(let i=0;i<5;i++){h.send({valid:true,ratio:2.05});h.send({valid:true,ratio:1.95});}h.hold(far,3);assert.equal(h.count,0);h.send(near);for(let i=0;i<15;i++){h.send({valid:true,ratio:1.85});h.send({valid:true,ratio:1.65});}assert.equal(h.count,0);h.hold(far,3);assert.equal(h.count,1);});
test('palm size alone cannot fabricate a close position',()=>{const h=harness();arm(h);h.send({...near,scale:250});h.hold(far,8);assert.equal(h.count,0);});
test('severe frame interruption requires a new baseline',()=>{const h=harness();arm(h);h.send(near);const r=h.c.update(far,10000);assert.equal(r.phase,'baseline');assert.equal(r.increment,0);});
test('feature rejection distinguishes missing, invalid, cropped and small hands',()=>{assert.equal(clapFeatures([real.landmarks[0]],[],720,382).code,'hands_missing');const p=structuredClone(real.landmarks);p[0][0].x=NaN;assert.equal(clapFeatures(p,[],720,382).code,'invalid_coordinates');p[0]=real.landmarks[0].map(v=>({...v,x:v.x-1}));assert.equal(clapFeatures(p,[],720,382).code,'cropped');const tiny=real.landmarks.map(hand=>hand.map(p=>({...p,x:0.4+p.x*0.001,y:0.4+p.y*0.001})));assert.equal(clapFeatures(tiny,[],720,382).code,'too_small');});
test('diagnostics retain bounded numeric evidence and precise rejection reasons',()=>{const d=new Diagnostics();for(let i=0;i<220;i++)d.observeHands({timestamp:i*84,landmarks:[real.landmarks[0]],scores:[0.51]}, {valid:false,code:'hands_missing',reason:'Видна только одна кисть'}, {phase:'baseline',reason:'Видна только одна кисть'});assert.equal(d.trackingHistory.length,180);assert.equal(d.rejections.hands_missing,220);assert.equal(d.values.handsDetected,1);assert.equal(d.values.lastRejection.reason,'Видна только одна кисть');assert.equal(d.log.length,1);});

test('one hand in center during approaching is accepted as palm contact and completes clap',()=>{
  const h=harness();arm(h);
  // Start approach with 2 hands
  h.send({valid:true,ratio:2.1,scale:100,centres:[{x:300,y:200},{x:500,y:200}]});
  assert.equal(h.c.phase,'approaching');
  // Overlap: 1 hand detected in center (e.g. from clapFeatures)
  const contact=h.send({valid:false,reason:'Видна только одна кисть — покажите обе',code:'hands_missing',singleHand:true,isCenter:true,centre:{x:400,y:200},centres:[{x:400,y:200},{x:400,y:200}]});
  assert.equal(contact.phase,'closed');
  assert.equal(h.c.attempt.closeObserved,true);
  assert.equal(h.count,0);
  // Reopen
  h.hold(far,2);
  assert.equal(h.count,1);
});
test('observed close survives 400ms re-detection delay at 10fps',()=>{const h=harness(100);arm(h);h.send(near);h.hold({valid:false},3);h.hold(far,2);assert.equal(h.count,1);});
test('pause, reset and mode changes discard an observed close before return',async()=>{const {ExerciseSession}=await import('../src/session.js');for(const action of ['pause','reset','mode']){const s=new ExerciseSession();s.select('clap');let t=0;const send=f=>s.update(f,t+=84);for(let i=0;i<7;i++)send(far);assert.equal(send(near).phase,'closed');if(action==='pause'){s.pause();s.resume();}else if(action==='reset')s.reset();else{s.select('squat');s.select('clap');}for(let i=0;i<8;i++)send(far);assert.equal(s.count,0,action);}});
