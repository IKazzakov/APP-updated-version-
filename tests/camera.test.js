import test from 'node:test';
import assert from 'node:assert/strict';
import {Camera,cameraError} from '../src/camera.js';
test('camera requests video only; switch and off stop all previous tracks',async()=>{
 globalThis.isSecureContext=true;const streams=[];const requests=[];
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async options=>{requests.push(options);const track={stopped:false,stop(){this.stopped=true;},addEventListener(){},getSettings(){return {width:1280,height:720};}};const stream={getTracks:()=>[track],getVideoTracks:()=>[track],track};streams.push(stream);return stream;}}}});
 const video={srcObject:null,play:async()=>{}};const c=new Camera(video);
 await c.start();assert.equal(requests[0].audio,false);await c.start('environment');assert.equal(streams[0].track.stopped,true);assert.equal(requests[1].video.facingMode.ideal,'environment');c.stop();assert.equal(streams[1].track.stopped,true);assert.equal(video.srcObject,null);
});
test('a late camera permission response cannot resurrect stopped camera',async()=>{
 let release;const track={stopped:false,stop(){this.stopped=true;}};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>new Promise(r=>release=r)}}});
 const c=new Camera({srcObject:null,play:async()=>{}}),pending=c.start();c.stop();release({getTracks:()=>[track]});assert.equal(await pending,false);assert.equal(track.stopped,true);assert.equal(c.stream,null);
});
test('camera denial explains how to retry',()=>{assert.match(cameraError({name:'NotAllowedError'}),/Разрешить/);assert.match(cameraError({name:'NotReadableError'}),/занята/);});
test('switching from claps restores the original squat profile without leaking a stream',async()=>{
 let settings={width:640,height:480,frameRate:60};const track={stop(){},addEventListener(){},getSettings:()=>settings,
  async applyConstraints(c){settings={width:c.width.ideal,height:c.height.ideal,frameRate:c.frameRate.exact??c.frameRate.ideal};}};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track],getVideoTracks:()=>[track]})}}});
 const c=new Camera({srcObject:null,play:async()=>{}});await c.start('user','clap');assert.equal(c.profile.id,'fast-60');
 await c.selectMode('squat');assert.equal(c.profile.id,'squat');assert.deepEqual(c.settings,{width:1280,height:720,frameRate:30});c.stop();
});
test('a stopped camera cannot be revived by a late profile probe',async()=>{
 let release;const track={stop(){},addEventListener(){},getSettings:()=>({frameRate:60}),applyConstraints:()=>new Promise(r=>release=r)};
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[track],getVideoTracks:()=>[track]})}}});
 const c=new Camera({srcObject:null,play:async()=>{}});const pending=c.start('user','clap');
 while(!release)await Promise.resolve();c.stop();release();assert.equal(await pending,false);assert.equal(c.stream,null);
});
