import test from 'node:test';
import assert from 'node:assert/strict';
import {HandBackend} from '../src/inference-backend.js';

function rig({gpuMs=5,cpuMs=40,gpuLoadFails=false,cpuLoadFails=false,gpuFailsAt=Infinity,cpuFailsAt=Infinity}={}){
  let now=0;const made=[],closed=[],calls={GPU:0,CPU:0},events=[];
  const b=new HandBackend({clock:()=>now,onInfo:info=>events.push(info),create:async delegate=>{
    if(delegate==='GPU'&&gpuLoadFails)throw Error('No WebGL2');
    if(delegate==='CPU'&&cpuLoadFails)throw Error('CPU load failed');
    made.push(delegate);
    return {detectForVideo(bitmap,timestamp){
      calls[delegate]++;
      if(calls[delegate]===(delegate==='GPU'?gpuFailsAt:cpuFailsAt))throw Error('context/device failure');
      now+=delegate==='GPU'?gpuMs:cpuMs;
      return {delegate,timestamp,bitmap};
    },close(){closed.push(delegate);}};
  }});
  return {b,made,closed,calls,events};
}
const frames=async(b,n=8)=>{for(let i=1;i<=n;i++)await b.detect({frame:i},i*33);};
test('measured faster GPU wins; CPU model is closed after the bounded benchmark',async()=>{
  const h=rig();await h.b.load();await frames(h.b);
  assert.equal(h.b.delegate,'GPU');assert.equal(h.b.benchmarking,false);
  assert.deepEqual(h.closed,['CPU']);assert.equal(h.b.info().backendBenchmark.samples,6);
  assert.equal(h.b.info().backendBenchmark.gpuMs,5);
  const before=h.calls.CPU;await h.b.detect({},400);assert.equal(h.calls.CPU,before);
});
test('slow software GPU loses to CPU; selected result and diagnostics agree',async()=>{
  const h=rig({gpuMs:60,cpuMs:15});await h.b.load();await frames(h.b,7);
  const result=await h.b.detect({},300);
  assert.equal(h.b.delegate,'CPU');assert.equal(result.delegate,'CPU');assert.deepEqual(h.closed,['GPU']);
});
test('a negligible GPU advantage does not change the stable CPU choice',async()=>{
  const h=rig({gpuMs:39,cpuMs:40});await h.b.load();await frames(h.b);assert.equal(h.b.delegate,'CPU');
});
test('clearly slow software GPU is released after two frames, without a long warmup',async()=>{
  const h=rig({gpuMs:900,cpuMs:25});await h.b.load();await frames(h.b,2);
  assert.equal(h.b.delegate,'CPU');assert.equal(h.b.benchmarking,false);
  assert.equal(h.b.info().backendBenchmark.samples,2);assert.equal(h.b.info().backendBenchmark.earlyExit,true);
  assert.deepEqual(h.closed,['GPU']);
});
test('GPU initialization failure starts CPU without stopping camera recognition',async()=>{
  const h=rig({gpuLoadFails:true});await h.b.load();
  assert.equal((await h.b.detect({},100)).delegate,'CPU');assert.match(h.b.info().fallbackReason,/GPU недоступен/);
  assert.equal(h.b.benchmarking,false);
});
test('GPU inference failure during comparison recovers on the same fresh frame',async()=>{
  const h=rig({gpuFailsAt:2});await h.b.load();await h.b.detect({},100);
  const bitmap={frame:2},result=await h.b.detect(bitmap,200);
  assert.equal(result.delegate,'CPU');assert.equal(result.bitmap,bitmap);assert.equal(result.timestamp,200);
  assert.equal(h.b.benchmarking,false);assert.match(h.b.info().fallbackReason,/включён CPU/);
});
test('GPU context loss after selection recreates CPU and releases GPU',async()=>{
  const h=rig({gpuFailsAt:9});await h.b.load();await frames(h.b);
  const result=await h.b.detect({},400);
  assert.equal(result.delegate,'CPU');assert.deepEqual(h.made,['GPU','CPU','CPU']);
  assert.deepEqual(h.closed,['CPU','GPU']);
});
test('CPU comparison failure keeps functioning GPU and closes failed CPU',async()=>{
  const h=rig({cpuFailsAt:2});await h.b.load();await frames(h.b,2);
  assert.equal(h.b.delegate,'GPU');assert.equal(h.b.benchmarking,false);assert.deepEqual(h.closed,['CPU']);
});
test('a CPU load failure does not discard a working GPU',async()=>{
  const h=rig({cpuLoadFails:true});await h.b.load();assert.equal((await h.b.detect({},100)).delegate,'GPU');
});
test('failure of both delegates surfaces an error instead of fake readiness',async()=>{
  const h=rig({gpuLoadFails:true,cpuLoadFails:true});await assert.rejects(h.b.load(),/CPU load failed/);
});
