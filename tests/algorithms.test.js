import test from 'node:test';
import assert from 'node:assert/strict';
import {SquatCounter,squatFeatures} from '../src/algorithms/squat.js';
import {ClapCounter,clapFeatures} from '../src/algorithms/clap.js';
import {angle,pixel} from '../src/algorithms/geometry.js';
import {ExerciseSession} from '../src/session.js';
function driver(counter,step=40){let t=0,count=0;return {hold(f,ms){let result;for(let i=0;i<Math.ceil(ms/step);i++){t+=step;result=counter.update(f,t);count+=result?.increment||0;}return result;},get count(){return count;},get t(){return t;}};}
const stand={valid:true,side:'left',angle:175,height:195,leg:200,upright:true};
const down={...stand,angle:130,height:165};
const bottom={...stand,angle:90,height:130};
const open={valid:true,ratio:3.6},near={valid:true,ratio:1.7},closed={valid:true,ratio:0.7};
function squat(d){d.hold(down,280);d.hold(bottom,480);d.hold(down,240);d.hold(stand,500);}
function clap(d){d.hold(near,80);d.hold(closed,120);d.hold(open,170);}
test('one squat and repeated full cycles',()=>{const d=driver(new SquatCounter());d.hold(stand,1000);squat(d);assert.equal(d.count,1);squat(d);squat(d);assert.equal(d.count,3);});
test('starting seated requires standing first',()=>{const d=driver(new SquatCounter());d.hold(bottom,2000);d.hold(stand,1000);assert.equal(d.count,0);squat(d);assert.equal(d.count,1);});
test('partial squat, torso bend, and small bottom oscillations',()=>{const d=driver(new SquatCounter());d.hold(stand,1000);d.hold(down,400);d.hold(stand,500);assert.equal(d.count,0);d.hold({...stand,height:130,upright:false},700);d.hold(stand,500);assert.equal(d.count,0);d.hold(down,300);d.hold(bottom,400);for(let i=0;i<8;i++){d.hold({...bottom,angle:103,height:138},150);d.hold(bottom,150);}assert.equal(d.count,0);d.hold(stand,500);assert.equal(d.count,1);});
test('lost body cannot finish old cycle; side changes rearm',()=>{const d=driver(new SquatCounter());d.hold(stand,1000);d.hold(down,300);d.hold(bottom,400);d.hold(null,80);d.hold(stand,1200);assert.equal(d.count,0);d.hold(down,300);d.hold(bottom,400);d.hold({...stand,side:'right'},1200);assert.equal(d.count,0);});
test('long frame gap invalidates squat',()=>{const c=new SquatCounter(),d=driver(c);d.hold(stand,1000);d.hold(down,300);d.hold(bottom,400);assert.equal(c.update(stand,d.t+1000).increment,0);assert.equal(c.phase,'baseline');});
test('one and multiple visual claps; holding together is not repetition',()=>{const d=driver(new ClapCounter(),20);d.hold(open,600);d.hold(near,100);d.hold(closed,2500);assert.equal(d.count,0);d.hold(open,200);assert.equal(d.count,1);clap(d);clap(d);assert.equal(d.count,3);});
test('hands initially together, incomplete motion and threshold jitter',()=>{const d=driver(new ClapCounter(),20);d.hold(closed,1000);d.hold(open,600);assert.equal(d.count,0);for(let i=0;i<6;i++){d.hold({valid:true,ratio:2.1},120);d.hold({valid:true,ratio:2.02},120);}d.hold(open,300);assert.equal(d.count,0);clap(d);assert.equal(d.count,1);});
test('missing hand is not a clap, reentry cannot finish a stale cycle',()=>{const d=driver(new ClapCounter(),20);d.hold(open,600);d.hold({valid:true,ratio:2.1},100);d.hold(null,60);d.hold(open,600);assert.equal(d.count,0);d.hold(near,100);d.hold(closed,200);d.hold(null,600);d.hold(open,600);assert.equal(d.count,0);clap(d);assert.equal(d.count,1);});
test('short occlusion allowed only after observed close state',()=>{const d=driver(new ClapCounter(),20);d.hold(open,600);d.hold(near,100);d.hold(closed,100);d.hold(null,60);d.hold(open,200);assert.equal(d.count,1);});
test('session pause/resume, reset and mode change discard partial cycles',()=>{const s=new ExerciseSession(),d=driver(s);d.hold(stand,1000);squat(d);assert.equal(s.count,1);d.hold(down,300);d.hold(bottom,400);s.pause();d.hold(stand,1000);s.resume();d.hold(stand,1000);assert.equal(s.count,1);d.hold(down,300);d.hold(bottom,400);s.reset();d.hold(stand,1000);assert.equal(s.count,0);squat(d);s.select('clap');d.hold(open,600);clap(d);assert.equal(s.count,1);s.select('squat');assert.equal(s.count,1);d.hold(stand,1000);assert.equal(s.count,1);});
test('stale pre-pause results ignored',()=>{const s=new ExerciseSession(),epoch=s.epoch;s.pause();s.resume();assert.equal(s.update(stand,100,epoch),null);assert.equal(s.count,0);});
test('angles account for rectangular image aspect',()=>{const a=pixel({x:0.5,y:0.1},1600,900),b=pixel({x:0.5,y:0.5},1600,900),c=pixel({x:0.725,y:0.5},1600,900);assert.equal(angle(a,b,c),90);});
test('invalid landmark quality and cropped feet rejected',()=>{assert.equal(squatFeatures([],1280,720).valid,false);const p=Array.from({length:33},()=>({x:0.5,y:0.5,visibility:0.2}));assert.equal(squatFeatures(p,1280,720).valid,false);assert.equal(clapFeatures([[]],[],1280,720).valid,false);});
test('hand distances use shared image coordinates and scale with palm',()=>{const hand=(cx,scale)=>Array.from({length:21},(_,i)=>({x:cx+(i%5-2)*scale,y:0.5+(Math.floor(i/5)-2)*scale}));const a=clapFeatures([hand(0.3,0.02),hand(0.7,0.02)],[0.9,0.9],1000,1000);const b=clapFeatures([hand(0.1,0.04),hand(0.9,0.04)],[0.9,0.9],1000,1000);assert.equal(a.valid,true);assert.equal(b.valid,true);assert.ok(Math.abs(a.ratio-b.ratio)<1e-6);});
