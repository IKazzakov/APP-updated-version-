import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameFusion} from '../src/frame-fusion.js';
const row=t=>({timestamp:t,landmarks:[],source:'optical'});
test('late real two-hand observation repairs only its own not-yet-consumed timestamp',()=>{
 const f=new FrameFusion();assert.deepEqual(f.push(row(0)),[]);f.push(row(16));
 assert.equal(f.anchor({timestamp:0,landmarks:[[1],[2]]}),true);
 assert.equal(f.anchor({timestamp:1,landmarks:[[3]]}),false);
 const ready=f.push(row(120));assert.equal(ready[0].timestamp,0);assert.equal(ready[0].source,'model-anchor');
 assert.deepEqual(ready[0].landmarks,[[1],[2]]);assert.equal(ready[0].fusionDelayMs,120);
});
test('late anchors never rewrite consumed frames or count the same observation twice',()=>{
 const f=new FrameFusion(40);f.push(row(0));f.push(row(20));assert.equal(f.push(row(40)).length,1);
 assert.equal(f.anchor({timestamp:0,landmarks:[[1],[2]]}),false);assert.deepEqual(f.push(row(0)),[]);
 assert.deepEqual(f.push(row(40)),[]);
});
test('already pixel-confirmed observations are not overwritten by a neural correction',()=>{
 const f=new FrameFusion();f.push({...row(0),landmarks:[[3],[4]]});
 assert.equal(f.anchor({timestamp:0,landmarks:[[1],[2]]}),false);
 assert.deepEqual(f.push(row(120))[0].landmarks,[[3],[4]]);
});
test('fusion storage stays bounded and output timestamps remain increasing',()=>{
 const f=new FrameFusion(),output=[];for(let t=0;t<5000;t+=4)output.push(...f.push(row(t)));
 assert.ok(f.pending.length<=12);assert.ok(output.every((r,i)=>i===0||r.timestamp>output[i-1].timestamp));
});
test('pause/reset discards pending observations and old anchors',()=>{
 const f=new FrameFusion();f.push(row(0));f.reset();assert.equal(f.anchor({timestamp:0,landmarks:[[1],[2]]}),false);
 assert.deepEqual(f.push(row(120)),[]);
});
