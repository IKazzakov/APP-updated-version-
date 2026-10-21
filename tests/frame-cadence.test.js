import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameCadence} from '../src/frame-cadence.js';
for(const hz of [9,12,20])test(`${hz}Hz inference on a 30fps camera keeps its average instead of rounding down`,()=>{
 const c=new FrameCadence();let sent=0;
 for(let i=0;i<300;i++){const t=i*1000/30;if(c.due(t)){c.sent(t,hz);sent++;assert.equal(c.due(t),false);}}
 assert.ok(Math.abs(sent-hz*10)<=1,`${sent} frames`);
});
test('inference backpressure and a long interruption never replay missed frames',()=>{
 const c=new FrameCadence();c.sent(0,12);
 assert.equal(c.due(1000),true);c.sent(1000,12);assert.equal(c.due(1000),false);assert.equal(c.due(1033),false);
 assert.equal(c.due(1100),true);
});
test('reset and changing the target frequency preserve fresh-only scheduling',()=>{
 const c=new FrameCadence();c.sent(0,20);c.sent(66,9);assert.equal(c.due(66),false);
 c.reset();assert.equal(c.due(0),true);c.sent(0,9);assert.equal(c.due(33),false);
});
