import test from 'node:test';
import assert from 'node:assert/strict';
import {Diagnostics} from '../src/diagnostics.js';

globalThis.isSecureContext=true;
function rig(){
  const d=new Diagnostics();
  Object.assign(d.values,{exercise:'Хлопки ладонями',resolution:'720 × 1280 @ 30 fps',modelInput:'540 × 960',
    inferenceMs:14,delegate:'GPU',backendStatus:'Выбран',backendBenchmark:{samples:6,cpuMs:60,gpuMs:14},
    model:'Hand Landmarker · 2 кисти',modelStatus:'Готово',camera:'передняя · включена',count:3,
    counts:{squat:0,clap:3},phase:'open',reason:'Ладони разведены'});
  let t=0;
  return {d,send(hands=2,ms=14){
    t+=1000/30;d.frame(t);d.values.inferenceMs=ms;
    d.observeHands({timestamp:t,ms,delegate:'GPU',landmarks:Array.from({length:hands},()=>[]),scores:[]},
      {valid:hands===2,reason:hands===2?null:'Кисти не найдены',code:'hands_missing'},
      {phase:hands===2?'open':'baseline',reason:hands===2?'Готово':'Кисти потеряны',increment:0});
  }};
}
test('short report always includes requested metadata, including before camera start',()=>{
  const d=new Diagnostics(),report=JSON.parse(d.reportText());
  for(const key of ['app','version','resolution','fps','inferenceMs','delegate','backendBenchmark','fallbackReason'])assert.ok(Object.hasOwn(report,key),key);
  assert.equal(report.resolution,null);assert.equal(report.fps,0);assert.equal(report.lastWithTwoHands,null);
});
test('copy report contains performance, selected backend and camera settings together',()=>{
  const {d,send}=rig();for(let i=0;i<30;i++)send();
  const report=JSON.parse(d.reportText());
  assert.equal(report.version,'1.4.1');assert.equal(report.delegate,'GPU');assert.equal(report.inferenceMs,14);
  assert.equal(report.resolution,'720 × 1280 @ 30 fps');assert.equal(report.fps,30);
  assert.equal(report.recent.twoHandsMsMedian,14);assert.equal(report.recent.twoHandsMsP95,14);
  assert.equal(report.recent.twoHands,30);assert.equal(report.lastWithTwoHands.valid,true);
});
test('long absence does not replace measurements taken with both hands by no-hand speed',()=>{
  const {d,send}=rig();for(let i=0;i<30;i++)send(2,18);
  for(let i=0;i<220;i++)send(0,3);
  const report=JSON.parse(d.reportText());
  assert.equal(report.inferenceMs,3);assert.equal(report.recent.twoHands,0);
  assert.equal(report.lastWithTwoHands.inferenceMs,18);assert.equal(report.lastWithTwoHands.fps,30);
  assert.equal(report.lastWithTwoHands.recent.twoHandsMsMedian,18);
  assert.equal(report.lastWithTwoHands.recent.twoHands,30);
  assert.equal(d.trackingHistory.length,180);assert.ok(report.lastWithTwoHands.ageMs>=0);
  const full=JSON.parse(d.text());assert.equal(full.lastWithTwoHands.inferenceMs,18);
  assert.equal(full.lastTwoHandsTrackingHistory.at(-1).hands,2);
});
test('fresh two-hand observations replace old preserved window, reset does not erase useful measurements',()=>{
  const {d,send}=rig();for(let i=0;i<20;i++)send(2,18);for(let i=0;i<80;i++)send(0,3);
  for(let i=0;i<70;i++)send(2,11);
  d.resetFps();const report=JSON.parse(d.reportText());
  assert.equal(report.fps,0);assert.equal(report.lastWithTwoHands.inferenceMs,11);
  assert.equal(report.lastWithTwoHands.recent.twoHandsMsMedian,11);
});
test('copy contains rejection summaries after raw history has rolled over, full journal remains available',()=>{
  const {d,send}=rig();d.attempts=Array.from({length:12},(_,i)=>({id:i,status:'rejected',reason:'Недостаточное сближение',
    closeObserved:false,minimumRatio:2.1,minimumDistancePx:210,referenceScalePx:100}));
  d.currentAttempt={id:13,status:'pending',minimumRatio:2};
  for(let i=0;i<220;i++)send(0,4);
  const short=JSON.parse(d.reportText()),full=JSON.parse(d.text());
  assert.equal(short.attempts.length,3);assert.equal(short.attempts.at(-1).id,11);
  assert.equal(short.currentAttempt.id,13);assert.equal(short.rejections.hands_missing,220);
  assert.ok(short.trackingHistory.length<=4);assert.equal(full.trackingHistory.length,180);
  assert.equal(full.attempts.length,12);
});
test('phone report stays short with a full session log and long technical errors',()=>{
  const {d,send}=rig();for(let i=0;i<220;i++)send(i%3,12+i%5);
  for(let i=0;i<80;i++)d.event('Событие '.repeat(200));for(let i=0;i<12;i++)d.error(new Error('Ошибка '.repeat(200)));
  d.attempts=Array.from({length:12},(_,id)=>({id,status:'rejected',reason:'Причина '.repeat(300),closeObserved:true,minimumRatio:1.4}));
  d.values.autoProfile={neuralTargetFps:9,activeNeuralLimitFps:9,motionInputMaxEdge:256,neuralP95Ms:75.6,motionP95Ms:20.7,opticalValidRate:.15,modelValidRate:.63,
    reason:'Уменьшен кадр трекера: модель видит кисти, пиксельные опоры неустойчивы',camera:{id:'fast-30',attempts:[{id:'fast-60',error:'OverconstrainedError'},{id:'detail-60',error:'OverconstrainedError'},{id:'fast-30',width:640,height:480,fps:30}],actual:{width:640,height:480,frameRate:30,facingMode:'user'}}};
  for(let i=0;i<60;i++)d.observeMotion({timestamp:i*33,ms:20.7,inputWidth:192,inputHeight:256,landmarks:[[],[]],confidence:1,anchorAgeMs:66.7,source:i%7===0?'optical':'model-anchor',fusionDelayMs:133.3},{valid:true,ratio:3},{phase:'open'});
  const text=d.reportText();assert.ok(text.length<6000,`report length ${text.length}`);
  assert.equal(JSON.parse(text).errors.length,2);assert.equal(JSON.parse(d.text()).errors.length,12);
});
test('hybrid report separates neural speed, camera delivery and real image tracking',()=>{
 const {d,send}=rig();send(2,55);d.values.cameraDeliveredFps=60;d.values.trackingSource='Модель + оптический трекер';
 d.values.autoProfile={neuralTargetFps:12,motionInputMaxEdge:320,camera:{id:'fast-60'}};
 for(let i=0;i<120;i++)d.observeMotion({timestamp:i*1000/60,ms:4,inputWidth:320,inputHeight:240,landmarks:[[],[]],confidence:.9,anchorAgeMs:60},
  {valid:true,ratio:3},{phase:'open',increment:0});
 const r=d.report();assert.equal(r.inferenceMs,55);assert.equal(r.cameraDeliveredFps,60);assert.equal(r.motion.fps,60);
 assert.equal(r.motion.ms,4);assert.equal(r.autoProfile.neuralTargetFps,12);assert.equal(r.lastWithTwoHands.inferenceMs,55);
 assert.equal(JSON.parse(d.text()).motionHistory.length,120);assert.ok(d.reportText().length<6000);
});
test('optical success and neural repairs are reported separately, last optical success survives repairs',()=>{
 const d=new Diagnostics(),packet={ms:20.7,inputWidth:240,inputHeight:320,landmarks:[[],[]],confidence:1,anchorAgeMs:0,fusionDelayMs:133};
 d.observeMotion({...packet,timestamp:0,source:'optical'},{valid:true},{phase:'open'});
 for(let i=1;i<59;i++)d.observeMotion({...packet,timestamp:i*33,source:'model-anchor'},{valid:true},{phase:'open'});
 const r=d.report();assert.equal(r.motion.opticalValidFrames,1);assert.equal(r.motion.modelRepairedFrames,58);
 assert.equal(r.lastGoodMotion.source,'model-anchor');assert.equal(r.lastGoodOptical.source,'optical');
});
