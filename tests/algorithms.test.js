import test from 'node:test';
import assert from 'node:assert/strict';
import {SquatCounter,squatFeatures} from '../src/algorithms/squat.js';
import {angle,pixel} from '../src/algorithms/geometry.js';
import {ExerciseSession} from '../src/session.js';
function driver(counter,step=40){let t=0,count=0;return {hold(f,ms){let result;for(let i=0;i<Math.ceil(ms/step);i++){t+=step;result=counter.update(f,t);count+=result?.increment||0;}return result;},get count(){return count;},get t(){return t;}};}
const stand={valid:true,side:'left',angle:175,height:195,leg:200,upright:true};
const down={...stand,angle:130,height:165};
const bottom={...stand,angle:90,height:130};
function squat(d){d.hold(down,280);d.hold(bottom,480);d.hold(down,240);d.hold(stand,500);}
test('one squat and repeated full cycles',()=>{const d=driver(new SquatCounter());d.hold(stand,1000);squat(d);assert.equal(d.count,1);squat(d);squat(d);assert.equal(d.count,3);});
test('starting seated requires standing first',()=>{const d=driver(new SquatCounter());d.hold(bottom,2000);d.hold(stand,1000);assert.equal(d.count,0);squat(d);assert.equal(d.count,1);});
test('partial squat, torso bend, and small bottom oscillations',()=>{const d=driver(new SquatCounter());d.hold(stand,1000);d.hold(down,400);d.hold(stand,500);assert.equal(d.count,0);d.hold({...stand,height:130,upright:false},700);d.hold(stand,500);assert.equal(d.count,0);d.hold(down,300);d.hold(bottom,400);for(let i=0;i<8;i++){d.hold({...bottom,angle:103,height:138},150);d.hold(bottom,150);}assert.equal(d.count,0);d.hold(stand,500);assert.equal(d.count,1);});
test('lost body cannot finish old cycle; side changes rearm',()=>{const d=driver(new SquatCounter());d.hold(stand,1000);d.hold(down,300);d.hold(bottom,400);d.hold(null,80);d.hold(stand,1200);assert.equal(d.count,0);d.hold(down,300);d.hold(bottom,400);d.hold({...stand,side:'right'},1200);assert.equal(d.count,0);});
test('long frame gap invalidates squat',()=>{const c=new SquatCounter(),d=driver(c);d.hold(stand,1000);d.hold(down,300);d.hold(bottom,400);assert.equal(c.update(stand,d.t+1000).increment,0);assert.equal(c.phase,'baseline');});
test('pause and reset discard partial cycles without creating a repetition',()=>{const s=new ExerciseSession(),d=driver(s);d.hold(stand,1000);squat(d);assert.equal(s.count,1);d.hold(down,300);d.hold(bottom,400);s.pause();d.hold(stand,1000);s.resume();d.hold(stand,1000);assert.equal(s.count,1);d.hold(down,300);d.hold(bottom,400);s.reset();d.hold(stand,1000);assert.equal(s.count,0);squat(d);assert.equal(s.count,1);});
test('stale pre-pause results ignored',()=>{const s=new ExerciseSession(),epoch=s.epoch;s.pause();s.resume();assert.equal(s.update(stand,100,epoch),null);assert.equal(s.count,0);});
test('angles account for rectangular image aspect',()=>{const a=pixel({x:0.5,y:0.1},1600,900),b=pixel({x:0.5,y:0.5},1600,900),c=pixel({x:0.725,y:0.5},1600,900);assert.equal(angle(a,b,c),90);});
test('quality hints name knees only when reliable torso supports it',()=>{assert.equal(squatFeatures([],1280,720).valid,false);const p=Array.from({length:33},()=>({x:0.5,y:0.5,visibility:0.2}));assert.match(squatFeatures(p,1280,720).reason,/Не удаётся/);for(const i of [11,12,23,24])p[i].visibility=0.9;assert.equal(squatFeatures(p,1280,720).reason,'Не видно колени');});
test('NaN or missing coordinates cannot produce a repeat',()=>{const c=new SquatCounter(),d=driver(c);d.hold(stand,1000);d.hold(down,300);d.hold(bottom,400);assert.equal(c.update({...stand,height:NaN},d.t+40).increment,0);d.hold(stand,1200);assert.equal(d.count,0);});
test('small standing jitter never starts a cycle',()=>{const d=driver(new SquatCounter());d.hold(stand,1000);for(let i=0;i<40;i++)d.hold({...stand,angle:i%2?161:168,height:i%2?190:195},60);assert.equal(d.count,0);});
