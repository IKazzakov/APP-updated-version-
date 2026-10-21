import test from 'node:test';
import assert from 'node:assert/strict';
import {RoundClock} from '../src/round-clock.js';
import {ExerciseSession} from '../src/session.js';
const params={id:'round',startsAt:100000,endsAt:160000,serverNow:100000};
test('60-second timer excludes preparation and never depends on frame count',()=>{let now=3000;const c=new RoundClock(()=>now);assert.equal(c.remaining(),60000);now=10000;c.start(params);now=69999;assert.equal(c.remaining(),1);assert.equal(c.tick(),false);now=70000;assert.equal(c.tick(),true);assert.equal(c.remaining(),0);assert.equal(c.tick(),false);});
test('late captures and late delivered inference cannot score',()=>{let now=1000;const c=new RoundClock(()=>now);c.start(params);assert.equal(c.accepts(999),false);assert.equal(c.accepts(1000),true);now=61000;assert.equal(c.accepts(60999),false);assert.equal(c.accepts(61000),false);});
test('server elapsed time reduces remaining minute',()=>{let now=5000;const c=new RoundClock(()=>now);c.start({...params,serverNow:100300});assert.equal(c.remaining(),59700);now=64700;assert.equal(c.tick(),true);});
test('abort cannot become a completed round after waiting',()=>{let now=0;const c=new RoundClock(()=>now);c.start(params);assert.equal(c.abort(),true);now=100000;assert.equal(c.tick(),false);assert.equal(c.status,'interrupted');assert.equal(c.accepts(500),false);});
test('round start drops incomplete preparation cycles and old inference epoch',()=>{const s=new ExerciseSession();let t=0;const stand={valid:true,side:'left',angle:175,height:195,leg:200,upright:true};const update=(f,n)=>{for(let i=0;i<n;i++){t+=40;s.update(f,t);}};update(stand,25);update({...stand,angle:90,height:130},15);const oldEpoch=s.epoch;s.reset();assert.equal(s.update(stand,t+40,oldEpoch),null);update(stand,30);assert.equal(s.count,0);});
test('invalid or expired server duration cannot start',()=>{const c=new RoundClock(()=>0);assert.throws(()=>c.start({...params,endsAt:160001}));assert.throws(()=>c.start({...params,serverNow:160000}));});
test('network-time correction excludes server processing and never extends the deadline',async()=>{
 const {serverTimeAtReceipt}=await import('../src/round-clock.js');
 assert.equal(serverTimeAtReceipt({serverNow:100000,processingMs:1800},2000),100100);
 assert.equal(serverTimeAtReceipt({serverNow:100000,processingMs:2200},2000),100000);
 assert.equal(serverTimeAtReceipt({serverNow:100000},2000),101000);
});
