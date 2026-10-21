import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseClapProfile} from '../src/camera-profiles.js';
import {AutoProfile} from '../src/auto-profile.js';
test('camera selects supported 60fps and inspects actual settings',async()=>{
  let settings={},calls=0;const track={async applyConstraints(c){calls++;settings={width:c.width.ideal,height:c.height.ideal,frameRate:c.frameRate.exact};},getSettings:()=>settings};
  const p=await chooseClapProfile(track);assert.equal(p.id,'fast-60');assert.equal(calls,1);assert.equal(p.attempts[0].fps,60);
});
test('requested 60fps is not reported as delivered 60fps; actual 30fps falls back',async()=>{
  const p=await chooseClapProfile({applyConstraints:async()=>{},getSettings:()=>({width:640,height:480,frameRate:30})});
  assert.equal(p.id,'fast-30');assert.equal(p.attempts.length,3);
});
test('unsupported exact profiles preserve a working stream and missing APIs are supported',async()=>{
  const p=await chooseClapProfile({applyConstraints:async()=>{throw Object.assign(new Error(),{name:'OverconstrainedError'});},getSettings:()=>({frameRate:24})});
  assert.equal(p.id,'browser');assert.equal((await chooseClapProfile({})).id,'browser');
});
test('profile probing stops when camera generation is no longer current',async()=>{
  let current=true,calls=0;const p=await chooseClapProfile({applyConstraints:async()=>{calls++;current=false;},getSettings:()=>({frameRate:60})},()=>current);
  assert.equal(p,null);assert.equal(calls,1);
});
test('neural duty budget uses hand frames, excludes benchmark and changes without camera resets',()=>{
  const p=new AutoProfile();
  for(let i=0;i<24;i++)p.observeModel({ms:500,timestamp:i*100,benchmarking:true,landmarks:[[]]});assert.equal(p.neuralHz,12);
  for(let i=0;i<24;i++)p.observeModel({ms:53,timestamp:3000+i*100,landmarks:[[],[]]});assert.equal(p.neuralHz,12);
  for(let i=0;i<48;i++)p.observeModel({ms:95,timestamp:6000+i*100,landmarks:[[],[]]});assert.equal(p.neuralHz,6);
  for(let i=0;i<48;i++)p.observeModel({ms:3,timestamp:12000+i*100,landmarks:[]});assert.equal(p.neuralHz,6);
});
test('GPU model inference 20-30ms selects target frequency 15-18 fps',()=>{
  const p1=new AutoProfile();
  for(let i=0;i<24;i++)p1.observeModel({ms:20,timestamp:i*100,landmarks:[[],[]],delegate:'GPU'});
  assert.equal(p1.neuralHz,18);
  const p2=new AutoProfile();
  for(let i=0;i<24;i++)p2.observeModel({ms:30,timestamp:i*100,landmarks:[[],[]],delegate:'GPU'});
  assert.equal(p2.neuralHz,15);
  const p3=new AutoProfile();
  for(let i=0;i<24;i++)p3.observeModel({ms:25,timestamp:i*100,landmarks:[[],[]],delegate:'GPU'});
  assert.ok(p3.neuralHz>=15&&p3.neuralHz<=18);
});
test('sustained load changes tracker resolution first, only at rest with hysteresis',()=>{
  const p=new AutoProfile();let result;
  for(let t=0;t<=6000;t+=20){p.observeMotion({timestamp:t,ms:20,landmarks:[[],[]]});assert.equal(p.decide(t,{idle:false,cameraFps:60}),null);result=p.decide(t,{idle:true,cameraFps:60});if(result)break;}
  assert.deepEqual(result,{motionEdge:256});
  for(let t=6100;t<18000;t+=20){p.observeMotion({timestamp:t,ms:20,landmarks:[[],[]]});assert.equal(p.decide(t,{idle:true,cameraFps:60}),null);}
});
test('S23-like weak tracking with 20.7ms cost survives long enough to select 256 at 30fps',()=>{
 const p=new AutoProfile();let decision=null;
 for(let i=0;i<200;i++){
  const t=i*1000/30;
  if(i%3===0)p.observeModel({timestamp:t,ms:75.6,landmarks:[[],[]]},true);
  p.observeMotion({timestamp:t,ms:20.7,landmarks:i%7===0?[[],[]]:[]});
  decision=p.decide(t,{idle:true,cameraFps:30,profileId:'fast-30'});
  if(decision)break;
 }
 assert.deepEqual(decision,{motionEdge:256});assert.equal(p.motionEdge,256);
 assert.ok(p.snapshot().opticalValidRate<.25);
});
test('neural repair does not masquerade as successful optical tracking',()=>{
 const p=new AutoProfile();for(let i=0;i<60;i++)p.observeMotion({timestamp:i*33,ms:4,landmarks:[[],[]],source:'model-anchor'});
 assert.equal(p.snapshot().opticalValidRate,0);
});
test('weak optical tracking lightens work only when neural hands are actually present',()=>{
 for(const present of [false,true]){
  const p=new AutoProfile();let decision;
  for(let i=0;i<180;i++){
   const t=i*33;if(i%3===0)p.observeModel({timestamp:t,ms:20,landmarks:present?[[],[]]:[]},present);
   p.observeMotion({timestamp:t,ms:3,landmarks:[]});
   const d=p.decide(t,{idle:true,cameraFps:30,profileId:'fast-30'});if(d)decision=d;
  }
  assert.equal(decision?.motionEdge,present?256:undefined);
 }
});
test('load is measured while moving; one safe gap can apply an already-needed reduction',()=>{
 const p=new AutoProfile();
 for(let t=0;t<=6600;t+=33){
  p.observeMotion({timestamp:t,ms:20.7,landmarks:[[],[]]});
  assert.equal(p.decide(t,{idle:false,cameraFps:30,profileId:'fast-30'}),null);
 }
 assert.deepEqual(p.decide(6633,{idle:true,cameraFps:30,profileId:'fast-30'}),{motionEdge:256});
});
